import * as path from "node:path";
import * as vscode from "vscode";
import { renderTurnAnalysisWebview } from "./analysisView";
import {
  computeLatestTurnAnalysis,
  computeLatestTurnUsage,
  discoverCurrentSession,
  loadSessionSnapshot,
  refreshSessionSnapshot
} from "./sessionTracker";
import { StatusBarController } from "./statusBar";
import { SessionSnapshot } from "./types";
import { debounce } from "./utils";

const CONFIG_SECTION = "claudeReplyTokens";
const DEFAULT_REFRESH_INTERVAL_SECONDS = 30;
const DEBOUNCE_MS = 400;

class ClaudeReplyTokensExtension implements vscode.Disposable {
  private readonly statusBar = new StatusBarController();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly debouncedIncrementalRefresh: () => void;
  private readonly debouncedFullRefresh: () => void;
  private currentSnapshot: SessionSnapshot | null = null;
  private currentProjectsPath: string | null = null;
  private watchedSessionPath: string | null = null;
  private projectsWatcher: vscode.FileSystemWatcher | null = null;
  private activeSessionWatcher: vscode.FileSystemWatcher | null = null;
  private analysisPanel: vscode.WebviewPanel | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight = false;
  private queuedMode: "incremental" | "full" | null = null;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.debouncedIncrementalRefresh = debounce(() => {
      void this.runRefresh("incremental");
    }, DEBOUNCE_MS);
    this.debouncedFullRefresh = debounce(() => {
      void this.runRefresh("full");
    }, DEBOUNCE_MS);

    this.registerCommands();
    this.registerEventHandlers();
    this.restartRefreshTimer();
  }

  public async initialize(): Promise<void> {
    await this.runRefresh("full");
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    this.projectsWatcher?.dispose();
    this.activeSessionWatcher?.dispose();
    this.analysisPanel?.dispose();
    this.analysisPanel = null;
    this.statusBar.dispose();
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private registerCommands(): void {
    this.subscriptions.push(
      vscode.commands.registerCommand("claudeReplyTokens.refresh", async () => {
        await this.runRefresh("full");
      }),
      vscode.commands.registerCommand(
        "claudeReplyTokens.openTurnAnalysis",
        async () => {
          await this.openTurnAnalysis();
        }
      ),
      vscode.commands.registerCommand(
        "claudeReplyTokens.openTranscript",
        async () => {
          const transcriptPath = this.currentSnapshot?.session.jsonlPath;
          if (!transcriptPath) {
            void vscode.window.showInformationMessage(
              "No Claude transcript is available for the current workspace yet."
            );
            return;
          }

          const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(transcriptPath)
          );
          await vscode.window.showTextDocument(document, {
            preview: false
          });
        }
      ),
      vscode.commands.registerCommand(
        "claudeReplyTokens.openSettings",
        async () => {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            CONFIG_SECTION
          );
        }
      )
    );
  }

  private registerEventHandlers(): void {
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          this.restartRefreshTimer();
          this.debouncedFullRefresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.debouncedFullRefresh();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.debouncedFullRefresh();
      })
    );
  }

  private restartRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    const refreshIntervalSeconds = Math.max(
      DEFAULT_REFRESH_INTERVAL_SECONDS,
      this.getConfiguration().refreshIntervalSeconds
    );
    this.refreshTimer = setInterval(() => {
      void this.runRefresh("full");
    }, refreshIntervalSeconds * 1000);
  }

  private async runRefresh(mode: "incremental" | "full"): Promise<void> {
    if (this.refreshInFlight) {
      this.queuedMode = this.queuedMode === "full" || mode === "full" ? "full" : mode;
      return;
    }

    this.refreshInFlight = true;
    try {
      if (mode === "incremental" && this.currentSnapshot) {
        await this.refreshIncremental();
      } else {
        await this.refreshFromDiscovery();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error while reading Claude logs.";
      this.statusBar.showPlaceholder(message);
    } finally {
      this.refreshInFlight = false;

      if (this.queuedMode) {
        const queuedMode = this.queuedMode;
        this.queuedMode = null;
        await this.runRefresh(queuedMode);
      }
    }
  }

  private async refreshFromDiscovery(): Promise<void> {
    this.statusBar.showLoading("Scanning Claude Code sessions...");

    const discovery = await discoverCurrentSession({
      dataDirectory: this.getConfiguration().dataDirectory,
      preferredWorkspaceFolder: this.getPreferredWorkspaceFolder(),
      workspaceFolders: this.getWorkspaceFolders()
    });

    this.reconfigureProjectsWatcher(discovery.projectsPath);

    if (!discovery.claudeRoot || !discovery.projectsPath) {
      this.currentSnapshot = null;
      this.reconfigureActiveSessionWatcher(null);
      this.statusBar.showPlaceholder(
        "Claude data directory was not found. Configure claudeReplyTokens.dataDirectory if needed."
      );
      return;
    }

    if (!discovery.session) {
      this.currentSnapshot = null;
      this.reconfigureActiveSessionWatcher(null);
      this.statusBar.showPlaceholder(
        "No Claude reply data matches the current workspace yet."
      );
      return;
    }

    const shouldReload =
      !this.currentSnapshot ||
      this.currentSnapshot.session.jsonlPath !== discovery.session.jsonlPath;

    if (shouldReload) {
      this.currentSnapshot = await loadSessionSnapshot(discovery.session);
    } else if (this.currentSnapshot) {
      this.currentSnapshot = await refreshSessionSnapshot({
        ...this.currentSnapshot,
        session: discovery.session
      });
    }

    this.reconfigureActiveSessionWatcher(discovery.session.jsonlPath);
    this.updateStatusBarFromSnapshot();
  }

  private async refreshIncremental(): Promise<void> {
    if (!this.currentSnapshot) {
      await this.refreshFromDiscovery();
      return;
    }

    try {
      this.currentSnapshot = await refreshSessionSnapshot(this.currentSnapshot);
      this.updateStatusBarFromSnapshot();
    } catch {
      await this.refreshFromDiscovery();
    }
  }

  private updateStatusBarFromSnapshot(): void {
    if (!this.currentSnapshot) {
      this.statusBar.showPlaceholder(
        "No Claude reply data matches the current workspace yet."
      );
      this.refreshAnalysisPanel();
      return;
    }

    const turnUsage = computeLatestTurnUsage(this.currentSnapshot);
    if (!turnUsage) {
      this.statusBar.showPlaceholder(
        "Claude session found, but there is no completed assistant reply with usage data yet."
      );
      this.refreshAnalysisPanel();
      return;
    }

    this.statusBar.showUsage(turnUsage);
    this.refreshAnalysisPanel();
  }

  private async openTurnAnalysis(): Promise<void> {
    const analysis = this.currentSnapshot
      ? computeLatestTurnAnalysis(this.currentSnapshot)
      : null;

    if (!analysis) {
      void vscode.window.showInformationMessage(
        "No completed Claude turn is available for the current workspace yet."
      );
      return;
    }

    if (!this.analysisPanel) {
      this.analysisPanel = vscode.window.createWebviewPanel(
        "claudeReplyTokens.turnAnalysis",
        "Claude Turn Analysis",
        vscode.ViewColumn.Beside,
        {
          enableCommandUris: true
        }
      );
      this.analysisPanel.onDidDispose(() => {
        this.analysisPanel = null;
      });
    } else {
      this.analysisPanel.reveal(vscode.ViewColumn.Beside, false);
    }

    this.analysisPanel.webview.html = renderTurnAnalysisWebview(analysis);
  }

  private refreshAnalysisPanel(): void {
    if (!this.analysisPanel) {
      return;
    }

    const analysis = this.currentSnapshot
      ? computeLatestTurnAnalysis(this.currentSnapshot)
      : null;
    this.analysisPanel.webview.html = renderTurnAnalysisWebview(analysis);
  }

  private reconfigureProjectsWatcher(projectsPath: string | null): void {
    if (this.currentProjectsPath === projectsPath) {
      return;
    }

    this.currentProjectsPath = projectsPath;
    this.projectsWatcher?.dispose();
    this.projectsWatcher = null;

    if (!projectsPath) {
      return;
    }

    this.projectsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(projectsPath), "**/*.jsonl")
    );

    this.projectsWatcher.onDidCreate(() => {
      this.debouncedFullRefresh();
    });
    this.projectsWatcher.onDidDelete(() => {
      this.debouncedFullRefresh();
    });
    this.projectsWatcher.onDidChange((uri) => {
      if (
        this.currentSnapshot &&
        sameFilePath(uri.fsPath, this.currentSnapshot.session.jsonlPath)
      ) {
        this.debouncedIncrementalRefresh();
      } else {
        this.debouncedFullRefresh();
      }
    });

    this.context.subscriptions.push(this.projectsWatcher);
  }

  private reconfigureActiveSessionWatcher(sessionPath: string | null): void {
    if (this.watchedSessionPath === sessionPath && this.activeSessionWatcher) {
      return;
    }

    this.watchedSessionPath = sessionPath;
    this.activeSessionWatcher?.dispose();
    this.activeSessionWatcher = null;

    if (!sessionPath) {
      return;
    }

    this.activeSessionWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(sessionPath)),
        path.basename(sessionPath)
      )
    );

    this.activeSessionWatcher.onDidChange(() => {
      this.debouncedIncrementalRefresh();
    });
    this.activeSessionWatcher.onDidDelete(() => {
      this.debouncedFullRefresh();
    });
    this.activeSessionWatcher.onDidCreate(() => {
      this.debouncedFullRefresh();
    });

    this.context.subscriptions.push(this.activeSessionWatcher);
  }

  private getConfiguration(): {
    dataDirectory: string | undefined;
    refreshIntervalSeconds: number;
  } {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const dataDirectory = configuration.get<string>("dataDirectory")?.trim();
    return {
      dataDirectory: dataDirectory ? dataDirectory : undefined,
      refreshIntervalSeconds: configuration.get<number>(
        "refreshIntervalSeconds",
        DEFAULT_REFRESH_INTERVAL_SECONDS
      )
    };
  }

  private getWorkspaceFolders(): string[] {
    return (
      vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
    );
  }

  private getPreferredWorkspaceFolder(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri) {
      return this.getWorkspaceFolders()[0];
    }

    return vscode.workspace.getWorkspaceFolder(activeUri)?.uri.fsPath;
  }
}

function sameFilePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }

  return left === right;
}

let extensionInstance: ClaudeReplyTokensExtension | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  extensionInstance = new ClaudeReplyTokensExtension(context);
  context.subscriptions.push(extensionInstance);
  await extensionInstance.initialize();
}

export function deactivate(): void {
  extensionInstance?.dispose();
  extensionInstance = undefined;
}
