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
    this.item.command = "claudeReplyTokens.openTranscript";
    this.item.text = "Claude -- tok";
    this.item.tooltip = "Waiting for Claude Code reply data.";
    this.item.show();
  }

  public showLoading(message: string): void {
    this.item.text = "$(sync~spin) Claude ... tok";
    this.item.tooltip = message;
  }

  public showUsage(turnUsage: TurnUsage): void {
    this.item.text = `Claude ${formatCompactTokens(turnUsage.breakdown.totalTokens)} tok`;

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown("**Claude Reply Tokens**\n\n");
    tooltip.appendMarkdown(
      `Total: \`${formatExactTokens(turnUsage.breakdown.totalTokens)}\`\n\n`
    );
    tooltip.appendMarkdown(
      `Input: \`${formatExactTokens(turnUsage.breakdown.inputTokens)}\`\n\n`
    );
    tooltip.appendMarkdown(
      `Output: \`${formatExactTokens(turnUsage.breakdown.outputTokens)}\`\n\n`
    );
    tooltip.appendMarkdown(
      `Cache write: \`${formatExactTokens(turnUsage.breakdown.cacheWriteTokens)}\`\n\n`
    );
    tooltip.appendMarkdown(
      `Cache read: \`${formatExactTokens(turnUsage.breakdown.cacheReadTokens)}\`\n\n`
    );
    tooltip.appendMarkdown(`Model: \`${turnUsage.model}\`\n\n`);
    tooltip.appendMarkdown(
      `Updated: \`${formatLocalDateTime(turnUsage.timestamp)}\`\n\n`
    );
    tooltip.appendMarkdown(`Session: \`${turnUsage.sessionId}\`\n\n`);
    tooltip.appendMarkdown(`Transcript: \`${turnUsage.transcriptPath}\``);
    tooltip.isTrusted = true;

    this.item.tooltip = tooltip;
  }

  public showPlaceholder(message: string): void {
    this.item.text = "Claude -- tok";
    this.item.tooltip = message;
  }

  public dispose(): void {
    this.item.dispose();
  }
}
