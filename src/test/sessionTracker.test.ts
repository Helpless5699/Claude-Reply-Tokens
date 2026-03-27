import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeLatestTurnAnalysis,
  computeLatestTurnUsage,
  discoverCurrentSession,
  loadSessionSnapshot,
  refreshSessionSnapshot
} from "../sessionTracker";

async function createClaudeFixture(
  workspacePath: string,
  fileName: string,
  lines: string[]
): Promise<{ claudeRoot: string; jsonlPath: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-reply-tokens-"));
  const claudeRoot = path.join(tempRoot, ".claude");
  const projectDir = path.join(claudeRoot, "projects", "sample-project");
  const jsonlPath = path.join(projectDir, fileName);

  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(jsonlPath, `${lines.join("\n")}\n`, "utf8");

  return { claudeRoot, jsonlPath };
}

function assistantRecord(params: {
  uuid: string;
  parentUuid: string;
  sessionId: string;
  cwd: string;
  timestamp: string;
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  model?: string;
  content?: unknown[];
  stopReason?: string | null;
}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: params.uuid,
    parentUuid: params.parentUuid,
    sessionId: params.sessionId,
    cwd: params.cwd,
    timestamp: params.timestamp,
    message: {
      role: "assistant",
      model: params.model ?? "claude-sonnet-4-6",
      content:
        params.content ??
        [
          {
            type: "text",
            text: "Assistant reply"
          }
        ],
      stop_reason: params.stopReason ?? null,
      usage: {
        input_tokens: params.input,
        output_tokens: params.output,
        cache_creation_input_tokens: params.cacheWrite ?? 0,
        cache_read_input_tokens: params.cacheRead ?? 0
      }
    }
  });
}

function userRecord(params: {
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  cwd: string;
  timestamp: string;
  content?: string | unknown[];
}): string {
  return JSON.stringify({
    type: "user",
    uuid: params.uuid,
    parentUuid: params.parentUuid ?? null,
    sessionId: params.sessionId,
    cwd: params.cwd,
    timestamp: params.timestamp,
    message: {
      role: "user",
      content: params.content ?? "Hello"
    }
  });
}

test("aggregates the latest reply chain across multiple assistant records", async () => {
  const workspacePath = path.join(os.tmpdir(), "workspace-a");
  const sessionId = "session-a";
  const fixture = await createClaudeFixture(workspacePath, "session-a.jsonl", [
    userRecord({
      uuid: "user-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:00.000Z"
    }),
    assistantRecord({
      uuid: "assistant-1",
      parentUuid: "user-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:01.000Z",
      input: 100,
      output: 50,
      cacheWrite: 200,
      cacheRead: 10
    }),
    assistantRecord({
      uuid: "assistant-2",
      parentUuid: "assistant-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:02.000Z",
      input: 20,
      output: 5,
      cacheRead: 2
    })
  ]);

  const discovery = await discoverCurrentSession({
    dataDirectory: fixture.claudeRoot,
    workspaceFolders: [workspacePath],
    preferredWorkspaceFolder: workspacePath
  });
  assert.ok(discovery.session);

  const snapshot = await loadSessionSnapshot(discovery.session);
  const turnUsage = computeLatestTurnUsage(snapshot);

  assert.ok(turnUsage);
  assert.equal(turnUsage.assistantUuid, "assistant-2");
  assert.equal(turnUsage.breakdown.inputTokens, 120);
  assert.equal(turnUsage.breakdown.outputTokens, 55);
  assert.equal(turnUsage.breakdown.cacheWriteTokens, 200);
  assert.equal(turnUsage.breakdown.cacheReadTokens, 12);
  assert.equal(turnUsage.breakdown.totalTokens, 387);
});

test("includes tool-result hops in the latest turn analysis", async () => {
  const workspacePath = path.join(os.tmpdir(), "workspace-tool-turn");
  const sessionId = "session-tool-turn";
  const toolResultText = "A".repeat(1200);
  const fixture = await createClaudeFixture(workspacePath, "tool-turn.jsonl", [
    userRecord({
      uuid: "user-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:00.000Z",
      content: [
        {
          type: "text",
          text: "Please inspect this file."
        }
      ]
    }),
    assistantRecord({
      uuid: "assistant-1",
      parentUuid: "user-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:01.000Z",
      input: 30,
      output: 20,
      cacheWrite: 400,
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: {
            file_path: "README.md"
          }
        }
      ],
      stopReason: "tool_use"
    }),
    userRecord({
      uuid: "user-2",
      parentUuid: "assistant-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:02.000Z",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: toolResultText
        }
      ]
    }),
    assistantRecord({
      uuid: "assistant-2",
      parentUuid: "user-2",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:04.000Z",
      input: 10,
      output: 80,
      cacheRead: 400,
      content: [
        {
          type: "thinking",
          thinking: "I should summarize the file."
        },
        {
          type: "text",
          text: "Here is the summary."
        }
      ],
      stopReason: "end_turn"
    })
  ]);

  const discovery = await discoverCurrentSession({
    dataDirectory: fixture.claudeRoot,
    workspaceFolders: [workspacePath],
    preferredWorkspaceFolder: workspacePath
  });
  assert.ok(discovery.session);

  const snapshot = await loadSessionSnapshot(discovery.session);
  const turnUsage = computeLatestTurnUsage(snapshot);
  const analysis = computeLatestTurnAnalysis(snapshot);

  assert.ok(turnUsage);
  assert.equal(turnUsage.breakdown.inputTokens, 40);
  assert.equal(turnUsage.breakdown.outputTokens, 100);
  assert.equal(turnUsage.breakdown.cacheWriteTokens, 400);
  assert.equal(turnUsage.breakdown.cacheReadTokens, 400);
  assert.equal(turnUsage.breakdown.totalTokens, 940);

  assert.ok(analysis);
  assert.equal(analysis.steps.length, 2);
  assert.equal(analysis.recordCount, 4);
  assert.equal(analysis.dominantTokenBucket, "cacheWriteTokens");
  assert.equal(analysis.dominantContentCategory, "toolResult");
  assert.deepEqual(analysis.steps[0].toolNames, ["Read"]);
  assert.equal(analysis.contentMetrics.toolResult.chars, toolResultText.length);
  assert.equal(analysis.contentMetrics.assistantThinking.blocks, 1);
  assert.equal(analysis.breakdown.totalTokens, 940);
});

test("prefers the most recent matching session for the current workspace", async () => {
  const workspacePath = path.join(os.tmpdir(), "workspace-b");
  const older = await createClaudeFixture(workspacePath, "older.jsonl", [
    userRecord({
      uuid: "older-user",
      sessionId: "older",
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:00.000Z"
    }),
    assistantRecord({
      uuid: "older-assistant",
      parentUuid: "older-user",
      sessionId: "older",
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:02.000Z",
      input: 10,
      output: 10
    })
  ]);

  const secondProjectDir = path.join(
    older.claudeRoot,
    "projects",
    "sample-project-2"
  );
  await fs.mkdir(secondProjectDir, { recursive: true });
  await fs.writeFile(
    path.join(secondProjectDir, "newer.jsonl"),
    [
      userRecord({
        uuid: "newer-user",
        sessionId: "newer",
        cwd: workspacePath,
        timestamp: "2026-03-26T12:00:03.000Z"
      }),
      assistantRecord({
        uuid: "newer-assistant",
        parentUuid: "newer-user",
        sessionId: "newer",
        cwd: workspacePath,
        timestamp: "2026-03-26T12:00:05.000Z",
        input: 20,
        output: 20
      })
    ].join("\n"),
    "utf8"
  );

  const discovery = await discoverCurrentSession({
    dataDirectory: older.claudeRoot,
    workspaceFolders: [workspacePath],
    preferredWorkspaceFolder: workspacePath
  });

  assert.equal(discovery.session?.sessionId, "newer");
});

test("incremental refresh picks up appended assistant records and ignores bad lines", async () => {
  const workspacePath = path.join(os.tmpdir(), "workspace-c");
  const sessionId = "session-c";
  const fixture = await createClaudeFixture(workspacePath, "session-c.jsonl", [
    userRecord({
      uuid: "user-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:00.000Z"
    }),
    assistantRecord({
      uuid: "assistant-1",
      parentUuid: "user-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:02.000Z",
      input: 10,
      output: 3
    })
  ]);

  const discovery = await discoverCurrentSession({
    dataDirectory: fixture.claudeRoot,
    workspaceFolders: [workspacePath],
    preferredWorkspaceFolder: workspacePath
  });
  assert.ok(discovery.session);

  let snapshot = await loadSessionSnapshot(discovery.session);
  await fs.appendFile(
    fixture.jsonlPath,
    `this is not json\n${assistantRecord({
      uuid: "assistant-2",
      parentUuid: "assistant-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:03.000Z",
      input: 7,
      output: 4,
      cacheRead: 2
    })}\n`,
    "utf8"
  );

  snapshot = await refreshSessionSnapshot(snapshot);
  const turnUsage = computeLatestTurnUsage(snapshot);

  assert.ok(turnUsage);
  assert.equal(turnUsage.breakdown.totalTokens, 26);
  assert.equal(turnUsage.breakdown.inputTokens, 17);
  assert.equal(turnUsage.breakdown.outputTokens, 7);
  assert.equal(turnUsage.breakdown.cacheReadTokens, 2);
});
