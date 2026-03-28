import * as vscode from "vscode";
import {
  ContentMetric,
  ContentMetrics,
  PromptSourceAnalysis,
  PromptSourceKind,
  RecentUsageWindowAnalysis,
  TokenBucketKind,
  TurnAnalysis,
  TurnContentCategory,
  WorkspaceRecentUsageSummary
} from "./types";
import {
  formatCompactTokens,
  formatExactTokens,
  formatLocalDateTime
} from "./utils";

export function renderTurnAnalysisWebview(
  analysis: TurnAnalysis | null,
  recentUsage: WorkspaceRecentUsageSummary | null = null
): string {
  const locale = vscode.env.language || "en";

  if (!analysis) {
    return renderShell({
      language: locale,
      title: vscode.l10n.t("Claude Turn Analysis"),
      body: `
        <section class="card empty">
          <h1>${escapeHtml(vscode.l10n.t("No completed Claude turn yet"))}</h1>
          <p>${escapeHtml(
            vscode.l10n.t(
              "Wait for Claude to finish a reply in this workspace, then click the status bar again."
            )
          )}</p>
        </section>
      `
    });
  }

  const tokenRows = renderTokenRows(analysis, locale);
  const recentUsageSection = renderRecentUsageSection(recentUsage, locale);
  const promptSources = renderPromptSourceCard(analysis, locale);
  const contentRows = renderContentRows(analysis.contentMetrics, locale);
  const stepRows = analysis.steps.map((step, index) => {
    const stepSummary = describeAssistantStep(step.kinds, step.toolNames);
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(stepSummary)}</td>
        <td>${escapeHtml(formatLocalDateTime(step.timestamp, locale))}</td>
        <td>${escapeHtml(formatStopReason(step.stopReason))}</td>
        <td>${escapeHtml(formatExactTokens(step.breakdown.totalTokens, locale))}</td>
      </tr>
    `;
  });

  const dominantTokenText = analysis.dominantTokenBucket
    ? vscode.l10n.t(
        "{0} is the largest exact token bucket this turn.",
        tokenBucketLabel(analysis.dominantTokenBucket)
      )
    : vscode.l10n.t("No token usage was recorded for the latest turn.");
  const dominantContentText = analysis.dominantContentCategory
    ? vscode.l10n.t(
        "{0} is the largest visible content category by size.",
        contentCategoryLabel(analysis.dominantContentCategory)
      )
    : vscode.l10n.t("No visible message content was captured for the latest turn.");
  const openTranscriptUri = "command:claudeReplyTokens.openTranscript";
  const refreshUri = "command:claudeReplyTokens.refresh";

  return renderShell({
    language: locale,
    title: vscode.l10n.t("Claude Turn Analysis"),
    body: `
      <header class="hero">
        <div>
          <p class="eyebrow">${escapeHtml(vscode.l10n.t("Latest Claude Turn"))}</p>
          <h1>${escapeHtml(
            vscode.l10n.t("{0} tok", formatCompactTokens(analysis.breakdown.totalTokens))
          )}</h1>
          <p class="meta">
            ${escapeHtml(analysis.model)}
            <span class="dot"></span>
            ${escapeHtml(formatLocalDateTime(analysis.timestamp, locale))}
            <span class="dot"></span>
            ${escapeHtml(vscode.l10n.t("Session {0}", analysis.sessionId))}
          </p>
        </div>
        <div class="actions">
          <a class="button" href="${openTranscriptUri}">${escapeHtml(
            vscode.l10n.t("Open transcript")
          )}</a>
          <a class="button secondary" href="${refreshUri}">${escapeHtml(
            vscode.l10n.t("Refresh")
          )}</a>
        </div>
      </header>

      ${recentUsageSection}

      <section class="grid">
        <article class="card">
          <h2>${escapeHtml(vscode.l10n.t("Exact Token Buckets"))}</h2>
          <p class="muted">${escapeHtml(dominantTokenText)}</p>
          <div class="rows">${tokenRows}</div>
        </article>

        ${promptSources}

        <article class="card">
          <h2>${escapeHtml(vscode.l10n.t("Visible Content Mix"))}</h2>
          <p class="muted">
            ${escapeHtml(
              vscode.l10n.t(
                "Heuristic only. Claude logs expose token usage per assistant record, not per content block."
              )
            )}
          </p>
          <p class="muted">${escapeHtml(dominantContentText)}</p>
          <div class="rows">${contentRows}</div>
        </article>
      </section>

      <section class="card">
        <h2>${escapeHtml(vscode.l10n.t("Assistant Steps"))}</h2>
        <p class="muted">
          ${escapeHtml(
            vscode.l10n.t(
              "{callCount} assistant call(s) across {recordCount} record(s) in this turn.",
              {
                callCount: analysis.steps.length,
                recordCount: analysis.recordCount
              }
            )
          )}
        </p>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>${escapeHtml(vscode.l10n.t("Step"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Time"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Stop reason"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Total tokens"))}</th>
            </tr>
          </thead>
          <tbody>
            ${stepRows.join("")}
          </tbody>
        </table>
      </section>

      <section class="card small">
        <h2>${escapeHtml(vscode.l10n.t("Context"))}</h2>
        <p>${escapeHtml(vscode.l10n.t("Turn start"))}: <code>${escapeHtml(
          formatLocalDateTime(analysis.turnStartedAt, locale)
        )}</code></p>
        <p>${escapeHtml(vscode.l10n.t("Turn end"))}: <code>${escapeHtml(
          formatLocalDateTime(analysis.timestamp, locale)
        )}</code></p>
        <p>${escapeHtml(vscode.l10n.t("Transcript"))}: <code>${escapeHtml(
          analysis.transcriptPath
        )}</code></p>
      </section>
    `
  });
}

function renderTokenRows(analysis: TurnAnalysis, locale: string): string {
  const total = Math.max(analysis.breakdown.totalTokens, 1);
  const rows: Array<{ label: string; value: number }> = [
    {
      label: tokenBucketLabel("inputTokens"),
      value: analysis.breakdown.inputTokens
    },
    {
      label: tokenBucketLabel("outputTokens"),
      value: analysis.breakdown.outputTokens
    },
    {
      label: tokenBucketLabel("cacheWriteTokens"),
      value: analysis.breakdown.cacheWriteTokens
    },
    {
      label: tokenBucketLabel("cacheReadTokens"),
      value: analysis.breakdown.cacheReadTokens
    }
  ];

  return rows
    .map((row) => renderMetricRow(row.label, row.value, total, vscode.l10n.t("tok"), locale))
    .join("");
}

function renderContentRows(metrics: ContentMetrics, locale: string): string {
  const entries = sortMetrics(metrics);
  const totalChars = Math.max(
    entries.reduce((sum, [, metric]) => sum + metric.chars, 0),
    1
  );

  return entries
    .map(([category, metric]) =>
      renderMetricRow(
        vscode.l10n.t("{0} ({1})", contentCategoryLabel(category), blockCountLabel(metric.blocks)),
        metric.chars,
        totalChars,
        vscode.l10n.t("chars"),
        locale
      )
    )
    .join("");
}

function renderRecentUsageSection(
  recentUsage: WorkspaceRecentUsageSummary | null,
  locale: string
): string {
  if (!recentUsage) {
    return `
      <section class="card">
        <h2>${escapeHtml(vscode.l10n.t("Recent Cumulative Usage"))}</h2>
        <p class="muted">${escapeHtml(
          vscode.l10n.t(
            "No recent workspace usage was found for the tracked workspace."
          )
        )}</p>
      </section>
    `;
  }

  const rows = recentUsage.windows
    .map((window) => renderRecentUsageRow(window, locale))
    .join("");

  return `
    <section class="card">
      <h2>${escapeHtml(vscode.l10n.t("Recent Cumulative Usage"))}</h2>
      <p class="muted">${escapeHtml(
        vscode.l10n.t(
          "Current workspace only. Sums every assistant call with usage data inside each rolling window."
        )
      )}</p>
      <p class="muted">${escapeHtml(
        vscode.l10n.t(
          "Composition columns are exact token buckets. Windows overlap, so 30 days includes 7 days."
        )
      )}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>${escapeHtml(vscode.l10n.t("Window"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Total"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Input"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Output"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Cache write"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Cache read"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Assistant calls"))}</th>
              <th>${escapeHtml(vscode.l10n.t("Sessions"))}</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderRecentUsageRow(
  window: RecentUsageWindowAnalysis,
  locale: string
): string {
  return `
    <tr>
      <td>${escapeHtml(vscode.l10n.t(window.label))}</td>
      <td>${escapeHtml(formatExactTokens(window.breakdown.totalTokens, locale))}</td>
      <td>${escapeHtml(formatBreakdownValue(window.breakdown.inputTokens, window.breakdown.totalTokens, locale))}</td>
      <td>${escapeHtml(formatBreakdownValue(window.breakdown.outputTokens, window.breakdown.totalTokens, locale))}</td>
      <td>${escapeHtml(formatBreakdownValue(window.breakdown.cacheWriteTokens, window.breakdown.totalTokens, locale))}</td>
      <td>${escapeHtml(formatBreakdownValue(window.breakdown.cacheReadTokens, window.breakdown.totalTokens, locale))}</td>
      <td>${escapeHtml(formatExactTokens(window.assistantCalls, locale))}</td>
      <td>${escapeHtml(formatExactTokens(window.sessionCount, locale))}</td>
    </tr>
  `;
}

function renderPromptSourceCard(
  analysis: TurnAnalysis,
  locale: string
): string {
  const promptSources = analysis.promptSources;
  if (!promptSources) {
    return `
      <article class="card">
        <h2>${escapeHtml(vscode.l10n.t("Prompt Source Signals"))}</h2>
        <p class="muted">${escapeHtml(
          vscode.l10n.t(
            "No Claude telemetry context breakdown was found for this turn."
          )
        )}</p>
      </article>
    `;
  }

  const dominantPromptSourceText = promptSources.dominantSource
    ? vscode.l10n.t(
        "{0} is the largest detectable prompt source in this turn.",
        promptSourceLabel(promptSources.dominantSource)
      )
    : vscode.l10n.t(
        "No detectable prompt-source signal was recorded for this turn."
      );
  const promptSourceRows = renderPromptSourceRows(promptSources, locale);
  const instructionLoads = promptSources.instructionLoads;
  const instructionLoadText = instructionLoads
    ? vscode.l10n.t(
        "Instruction files loaded across this turn: {fileCount} total | project {projectCount} | user {userCount} | local {localCount} | managed {managedCount} | auto-memory {automemCount} | team-memory {teammemCount}.",
        {
          fileCount: instructionLoads.fileCount,
          projectCount: instructionLoads.projectCount,
          userCount: instructionLoads.userCount,
          localCount: instructionLoads.localCount,
          managedCount: instructionLoads.managedCount,
          automemCount: instructionLoads.automemCount,
          teammemCount: instructionLoads.teammemCount
        }
      )
    : vscode.l10n.t("No CLAUDE.md or memory-file load details were exposed.");

  return `
    <article class="card">
      <h2>${escapeHtml(vscode.l10n.t("Prompt Source Signals"))}</h2>
      <p class="muted">${escapeHtml(
        vscode.l10n.t(
          "Telemetry-based estimate only. Claude does not expose exact per-source token accounting for a turn, so percentages show relative pressure across detectable sources."
        )
      )}</p>
      <p class="muted">${escapeHtml(
        vscode.l10n.t(
          "Aggregated across {promptCount} prompt call(s) in this turn.",
          { promptCount: promptSources.promptCount }
        )
      )}</p>
      <p class="muted">${escapeHtml(dominantPromptSourceText)}</p>
      <div class="rows">${promptSourceRows}</div>
      <p class="muted small-copy">${escapeHtml(
        vscode.l10n.t(
          "Units are mixed: `tok` = telemetry tokens, `len` = telemetry-reported length, `budget` = skill budget."
        )
      )}</p>
      <p class="muted small-copy">${escapeHtml(instructionLoadText)}</p>
      <p class="muted small-copy">${escapeHtml(
        vscode.l10n.t(
          "Claude telemetry does not separately expose conversation-body tokens or an exact CLAUDE.md vs memory-file split."
        )
      )}</p>
    </article>
  `;
}

function renderPromptSourceRows(
  promptSources: PromptSourceAnalysis,
  locale: string
): string {
  const total = Math.max(promptSources.totalKnownValue, 1);
  const rows: Array<{ kind: PromptSourceKind; value: number }> = [
    {
      kind: "systemPrompt",
      value: promptSources.breakdown.systemPrompt
    },
    {
      kind: "skills",
      value: promptSources.breakdown.skills
    },
    {
      kind: "claudeMd",
      value: promptSources.breakdown.claudeMd
    },
    {
      kind: "environment",
      value: promptSources.breakdown.environment
    },
    {
      kind: "builtInTools",
      value: promptSources.breakdown.builtInTools
    },
    {
      kind: "mcpTools",
      value: promptSources.breakdown.mcpTools
    }
  ];

  return rows
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value)
    .map((row) =>
      renderMetricRow(
        promptSourceLabel(row.kind),
        row.value,
        total,
        promptSourceUnit(row.kind),
        locale
      )
    )
    .join("");
}

function sortMetrics(
  metrics: ContentMetrics
): Array<[TurnContentCategory, ContentMetric]> {
  return (Object.entries(metrics) as Array<[TurnContentCategory, ContentMetric]>)
    .filter(([, metric]) => metric.blocks > 0 || metric.chars > 0)
    .sort((left, right) => right[1].chars - left[1].chars);
}

function renderMetricRow(
  label: string,
  value: number,
  total: number,
  suffix: string,
  locale: string
): string {
  const percentage = total > 0 ? (value / total) * 100 : 0;
  return `
    <div class="row">
      <div class="row-head">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(
          vscode.l10n.t("{0} {1}", formatExactTokens(value, locale), suffix)
        )} | ${escapeHtml(formatPercentage(percentage, locale))}%</span>
      </div>
      <div class="bar">
        <span style="width: ${Math.max(percentage, value > 0 ? 2 : 0)}%"></span>
      </div>
    </div>
  `;
}

function tokenBucketLabel(bucket: TokenBucketKind): string {
  switch (bucket) {
    case "inputTokens":
      return vscode.l10n.t("Input");
    case "outputTokens":
      return vscode.l10n.t("Output");
    case "cacheWriteTokens":
      return vscode.l10n.t("Cache write");
    case "cacheReadTokens":
      return vscode.l10n.t("Cache read");
  }
}

function promptSourceLabel(kind: PromptSourceKind): string {
  switch (kind) {
    case "systemPrompt":
      return vscode.l10n.t("System prompt");
    case "skills":
      return vscode.l10n.t("Skills");
    case "claudeMd":
      return vscode.l10n.t("CLAUDE.md / memory files");
    case "environment":
      return vscode.l10n.t("Git / environment");
    case "builtInTools":
      return vscode.l10n.t("Built-in tools");
    case "mcpTools":
      return vscode.l10n.t("MCP tools");
  }
}

function promptSourceUnit(kind: PromptSourceKind): string {
  switch (kind) {
    case "skills":
      return vscode.l10n.t("budget");
    case "builtInTools":
    case "mcpTools":
      return vscode.l10n.t("tok");
    case "systemPrompt":
    case "claudeMd":
    case "environment":
      return vscode.l10n.t("len");
  }
}

function contentCategoryLabel(category: TurnContentCategory): string {
  switch (category) {
    case "userText":
      return vscode.l10n.t("User text");
    case "toolResult":
      return vscode.l10n.t("Tool results");
    case "assistantToolUse":
      return vscode.l10n.t("Assistant tool calls");
    case "assistantThinking":
      return vscode.l10n.t("Assistant thinking");
    case "assistantText":
      return vscode.l10n.t("Assistant text");
    case "other":
      return vscode.l10n.t("Other blocks");
  }
}

function blockCountLabel(count: number): string {
  if (count === 1) {
    return vscode.l10n.t("{0} block", count);
  }

  return vscode.l10n.t("{0} blocks", count);
}

function describeAssistantStep(kinds: string[], toolNames: string[]): string {
  if (toolNames.length > 0) {
    return vscode.l10n.t("Tool call: {0}", toolNames.join(", "));
  }

  if (kinds.length === 0) {
    return vscode.l10n.t("Assistant step");
  }

  const labels = kinds.map((kind) => {
    switch (kind) {
      case "text":
        return vscode.l10n.t("Text");
      case "thinking":
        return vscode.l10n.t("Thinking");
      case "tool_use":
        return vscode.l10n.t("Tool planning");
      default:
        return kind;
    }
  });

  return labels.join(" + ");
}

function formatStopReason(stopReason: string | null): string {
  switch (stopReason ?? "end_turn") {
    case "end_turn":
      return vscode.l10n.t("Turn ended normally");
    case "tool_use":
      return vscode.l10n.t("Tool call requested");
    case "max_tokens":
      return vscode.l10n.t("Max tokens reached");
    case "stop_sequence":
      return vscode.l10n.t("Stop sequence matched");
    default:
      return stopReason ?? "end_turn";
  }
}

function formatBreakdownValue(
  value: number,
  total: number,
  locale: string
): string {
  const percentage = total > 0 ? (value / total) * 100 : 0;
  return vscode.l10n.t(
    "{0} ({1}%)",
    formatExactTokens(value, locale),
    formatPercentage(percentage, locale)
  );
}

function formatPercentage(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(value);
}

function renderShell(params: { title: string; body: string; language: string }): string {
  return `<!DOCTYPE html>
  <html lang="${escapeHtml(params.language)}">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(params.title)}</title>
      <style>
        :root {
          color-scheme: light dark;
          --bg: var(--vscode-editor-background);
          --fg: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --panel: color-mix(in srgb, var(--bg) 92%, var(--fg) 8%);
          --border: color-mix(in srgb, var(--fg) 16%, transparent);
          --accent: var(--vscode-button-background);
          --accent-fg: var(--vscode-button-foreground);
          --accent-soft: color-mix(in srgb, var(--accent) 20%, transparent);
          --bar: color-mix(in srgb, var(--fg) 10%, transparent);
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          padding: 24px;
          color: var(--fg);
          background:
            radial-gradient(circle at top right, var(--accent-soft), transparent 32%),
            linear-gradient(180deg, color-mix(in srgb, var(--bg) 92%, var(--fg) 8%), var(--bg));
          font-family: Georgia, "Noto Serif SC", "Source Han Serif SC", serif;
        }

        .hero,
        .grid,
        .card,
        .rows,
        .row,
        .actions {
          display: flex;
        }

        .hero,
        .card,
        .row {
          flex-direction: column;
        }

        .hero {
          gap: 16px;
          margin-bottom: 20px;
        }

        .grid {
          gap: 16px;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }

        .card {
          gap: 12px;
          padding: 18px;
          border: 1px solid var(--border);
          border-radius: 18px;
          background: var(--panel);
          box-shadow: 0 10px 30px color-mix(in srgb, var(--bg) 50%, transparent);
        }

        .grid .card {
          flex: 1 1 320px;
        }

        .small {
          margin-top: 16px;
        }

        .empty {
          min-height: 180px;
          justify-content: center;
        }

        .eyebrow {
          margin: 0 0 8px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
          font-size: 12px;
        }

        h1,
        h2,
        p {
          margin: 0;
        }

        h1 {
          font-size: clamp(30px, 6vw, 44px);
          line-height: 1.05;
        }

        h2 {
          font-size: 18px;
        }

        .meta,
        .muted {
          color: var(--muted);
        }

        .small-copy {
          font-size: 12px;
          line-height: 1.45;
        }

        .meta {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
        }

        .dot {
          width: 4px;
          height: 4px;
          border-radius: 999px;
          background: currentColor;
          display: inline-block;
        }

        .actions {
          gap: 10px;
          flex-wrap: wrap;
        }

        .button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 36px;
          padding: 0 14px;
          border-radius: 999px;
          text-decoration: none;
          background: var(--accent);
          color: var(--accent-fg);
          border: 1px solid transparent;
        }

        .button.secondary {
          background: transparent;
          color: var(--fg);
          border-color: var(--border);
        }

        .rows {
          flex-direction: column;
          gap: 10px;
        }

        .row {
          gap: 6px;
        }

        .row-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          font-size: 13px;
        }

        .bar {
          width: 100%;
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: var(--bar);
        }

        .bar span {
          display: block;
          height: 100%;
          border-radius: 999px;
          background:
            linear-gradient(90deg, color-mix(in srgb, var(--accent) 82%, white 18%), var(--accent));
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        .table-wrap {
          width: 100%;
          overflow-x: auto;
        }

        th,
        td {
          padding: 10px 8px;
          text-align: left;
          border-bottom: 1px solid var(--border);
          vertical-align: top;
        }

        th {
          color: var(--muted);
          font-weight: 600;
        }

        code {
          font-family: Consolas, "Courier New", monospace;
          word-break: break-all;
        }

        @media (max-width: 720px) {
          body {
            padding: 16px;
          }

          .row-head {
            flex-direction: column;
          }

          .meta {
            gap: 8px;
          }
        }
      </style>
    </head>
    <body>
      ${params.body}
    </body>
  </html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}
