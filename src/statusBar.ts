import * as vscode from "vscode";
import { TurnUsage } from "./types";
import {
  formatCompactTokens,
  formatExactTokens,
  formatLocalDateTime
} from "./utils";

export class StatusBarController {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98
    );
    this.item.command = "claudeReplyTokens.openTurnAnalysis";
    this.item.text = "Claude -- tok";
    this.item.tooltip = vscode.l10n.t(
      "Waiting for Claude Code reply data. Click to open the latest turn analysis."
    );
    this.item.show();
  }

  public showLoading(message: string): void {
    this.item.text = "$(sync~spin) Claude ... tok";
    this.item.tooltip = message;
  }

  public showUsage(turnUsage: TurnUsage): void {
    const locale = vscode.env.language;
    this.item.text = `Claude ${formatCompactTokens(turnUsage.breakdown.totalTokens)} tok`;

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${vscode.l10n.t("Claude Reply Tokens")}**\n\n`);
    tooltip.appendMarkdown(
      `${vscode.l10n.t("Total")}: \`${formatExactTokens(
        turnUsage.breakdown.totalTokens,
        locale
      )}\`\n\n`
    );
    tooltip.appendMarkdown(
      `${vscode.l10n.t("Input")}: \`${formatExactTokens(
        turnUsage.breakdown.inputTokens,
        locale
      )}\`\n\n`
    );
    tooltip.appendMarkdown(
      `${vscode.l10n.t("Output")}: \`${formatExactTokens(
        turnUsage.breakdown.outputTokens,
        locale
      )}\`\n\n`
    );
    tooltip.appendMarkdown(
      `${vscode.l10n.t("Cache write")}: \`${formatExactTokens(
        turnUsage.breakdown.cacheWriteTokens,
        locale
      )}\`\n\n`
    );
    tooltip.appendMarkdown(
      `${vscode.l10n.t("Cache read")}: \`${formatExactTokens(
        turnUsage.breakdown.cacheReadTokens,
        locale
      )}\`\n\n`
    );
    tooltip.appendMarkdown(`${vscode.l10n.t("Model")}: \`${turnUsage.model}\`\n\n`);
    tooltip.appendMarkdown(
      `${vscode.l10n.t("Updated")}: \`${formatLocalDateTime(
        turnUsage.timestamp,
        locale
      )}\`\n\n`
    );
    tooltip.appendMarkdown(`${vscode.l10n.t("Session")}: \`${turnUsage.sessionId}\`\n\n`);
    tooltip.appendMarkdown(
      `${vscode.l10n.t("Transcript")}: \`${turnUsage.transcriptPath}\`\n\n`
    );
    tooltip.appendMarkdown(
      `[${vscode.l10n.t("Open turn analysis")}](command:claudeReplyTokens.openTurnAnalysis) | `
    );
    tooltip.appendMarkdown(
      `[${vscode.l10n.t("Open transcript")}](command:claudeReplyTokens.openTranscript)`
    );
    tooltip.isTrusted = true;

    this.item.tooltip = tooltip;
  }

  public showPlaceholder(message: string): void {
    this.item.text = "Claude -- tok";
    this.item.tooltip = vscode.l10n.t(
      "{0} Click to open the latest turn analysis when data is ready.",
      message
    );
  }

  public dispose(): void {
    this.item.dispose();
  }
}
