import {
  ContentMetric,
  ContentMetrics,
  TokenBucketKind,
  TurnAnalysis,
  TurnContentCategory
} from "./types";
import {
  formatCompactTokens,
  formatExactTokens,
  formatLocalDateTime
} from "./utils";

export function renderTurnAnalysisWebview(
  analysis: TurnAnalysis | null
): string {
  if (!analysis) {
    return renderShell({
      title: "Claude Turn Analysis",
      body: `
        <section class="card empty">
          <h1>No completed Claude turn yet</h1>
          <p>Wait for Claude to finish a reply in this workspace, then click the status bar again.</p>
        </section>
      `
    });
  }

  const tokenRows = renderTokenRows(analysis);
  const contentRows = renderContentRows(analysis.contentMetrics);
  const stepRows = analysis.steps.map((step, index) => {
    const stepSummary = describeAssistantStep(step.kinds, step.toolNames);
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(stepSummary)}</td>
        <td>${escapeHtml(formatLocalDateTime(step.timestamp))}</td>
        <td>${escapeHtml(step.stopReason ?? "end_turn")}</td>
        <td>${escapeHtml(formatExactTokens(step.breakdown.totalTokens))}</td>
      </tr>
    `;
  });

  const dominantTokenText = analysis.dominantTokenBucket
    ? `${tokenBucketLabel(analysis.dominantTokenBucket)} is the largest exact token bucket this turn.`
    : "No token usage was recorded for the latest turn.";
  const dominantContentText = analysis.dominantContentCategory
    ? `${analysis.contentMetrics[analysis.dominantContentCategory].label} is the largest visible content category by size.`
    : "No visible message content was captured for the latest turn.";
  const openTranscriptUri = "command:claudeReplyTokens.openTranscript";
  const refreshUri = "command:claudeReplyTokens.refresh";

  return renderShell({
    title: "Claude Turn Analysis",
    body: `
      <header class="hero">
        <div>
          <p class="eyebrow">Latest Claude Turn</p>
          <h1>${escapeHtml(formatCompactTokens(analysis.breakdown.totalTokens))} tok</h1>
          <p class="meta">
            ${escapeHtml(analysis.model)}
            <span class="dot"></span>
            ${escapeHtml(formatLocalDateTime(analysis.timestamp))}
            <span class="dot"></span>
            session ${escapeHtml(analysis.sessionId)}
          </p>
        </div>
        <div class="actions">
          <a class="button" href="${openTranscriptUri}">Open transcript</a>
          <a class="button secondary" href="${refreshUri}">Refresh</a>
        </div>
      </header>

      <section class="grid">
        <article class="card">
          <h2>Exact Token Buckets</h2>
          <p class="muted">${escapeHtml(dominantTokenText)}</p>
          <div class="rows">${tokenRows}</div>
        </article>

        <article class="card">
          <h2>Visible Content Mix</h2>
          <p class="muted">
            Heuristic only. Claude logs expose token usage per assistant record, not per content block.
          </p>
          <p class="muted">${escapeHtml(dominantContentText)}</p>
          <div class="rows">${contentRows}</div>
        </article>
      </section>

      <section class="card">
        <h2>Assistant Steps</h2>
        <p class="muted">
          ${analysis.steps.length} assistant call(s) across ${analysis.recordCount} record(s) in this turn.
        </p>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>Time</th>
              <th>Stop reason</th>
              <th>Total tokens</th>
            </tr>
          </thead>
          <tbody>
            ${stepRows.join("")}
          </tbody>
        </table>
      </section>

      <section class="card small">
        <h2>Context</h2>
        <p>Turn start: <code>${escapeHtml(formatLocalDateTime(analysis.turnStartedAt))}</code></p>
        <p>Turn end: <code>${escapeHtml(formatLocalDateTime(analysis.timestamp))}</code></p>
        <p>Transcript: <code>${escapeHtml(analysis.transcriptPath)}</code></p>
      </section>
    `
  });
}

function renderTokenRows(analysis: TurnAnalysis): string {
  const total = Math.max(analysis.breakdown.totalTokens, 1);
  const rows: Array<{ label: string; value: number }> = [
    {
      label: "Input",
      value: analysis.breakdown.inputTokens
    },
    {
      label: "Output",
      value: analysis.breakdown.outputTokens
    },
    {
      label: "Cache write",
      value: analysis.breakdown.cacheWriteTokens
    },
    {
      label: "Cache read",
      value: analysis.breakdown.cacheReadTokens
    }
  ];

  return rows
    .map((row) => renderMetricRow(row.label, row.value, total))
    .join("");
}

function renderContentRows(metrics: ContentMetrics): string {
  const entries = sortMetrics(metrics);
  const totalChars = Math.max(
    entries.reduce((sum, [, metric]) => sum + metric.chars, 0),
    1
  );

  return entries
    .map(([, metric]) =>
      renderMetricRow(
        `${metric.label} (${metric.blocks} block${metric.blocks === 1 ? "" : "s"})`,
        metric.chars,
        totalChars,
        "chars"
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
  suffix = "tok"
): string {
  const percentage = total > 0 ? (value / total) * 100 : 0;
  return `
    <div class="row">
      <div class="row-head">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(`${formatExactTokens(value)} ${suffix}`)} | ${percentage.toFixed(1)}%</span>
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
      return "Input";
    case "outputTokens":
      return "Output";
    case "cacheWriteTokens":
      return "Cache write";
    case "cacheReadTokens":
      return "Cache read";
  }
}

function describeAssistantStep(kinds: string[], toolNames: string[]): string {
  if (toolNames.length > 0) {
    return `Tool call: ${toolNames.join(", ")}`;
  }

  if (kinds.length === 0) {
    return "Assistant step";
  }

  const labels = kinds.map((kind) => {
    switch (kind) {
      case "text":
        return "Text";
      case "thinking":
        return "Thinking";
      case "tool_use":
        return "Tool planning";
      default:
        return kind;
    }
  });

  return labels.join(" + ");
}

function renderShell(params: { title: string; body: string }): string {
  return `<!DOCTYPE html>
  <html lang="en">
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
