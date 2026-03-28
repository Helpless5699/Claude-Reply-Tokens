import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeWorkspaceRecentUsageSummary,
  computeLatestTurnAnalysis,
  computeLatestTurnUsage,
  discoverCurrentSession,
  loadSessionSnapshot,
  refreshSessionSnapshot
} from "../sessionTracker";

async function createClaudeFixture(
  workspacePath: string,
  fileName: string,
  lines: string[],
  telemetryLines: string[] = []
): Promise<{ claudeRoot: string; jsonlPath: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-reply-tokens-"));
  const claudeRoot = path.join(tempRoot, ".claude");
  const projectDir = path.join(claudeRoot, "projects", "sample-project");
  const jsonlPath = path.join(projectDir, fileName);

  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(jsonlPath, `${lines.join("\n")}\n`, "utf8");

  if (telemetryLines.length > 0) {
    const telemetryDir = path.join(claudeRoot, "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });
    await fs.writeFile(
      path.join(telemetryDir, `1p_failed_events.${path.basename(fileName, ".jsonl")}.fixture.json`),
      `${telemetryLines.join("\n")}\n`,
      "utf8"
    );
  }

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

function telemetryEvent(params: {
  sessionId: string;
  name: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  skillName?: string;
}): string {
  return JSON.stringify({
    event_type: "ClaudeCodeInternalEvent",
    event_data: {
      event_name: params.name,
      client_timestamp: params.timestamp,
      session_id: params.sessionId,
      additional_metadata: Buffer.from(
        JSON.stringify(params.metadata ?? {}),
        "utf8"
      ).toString("base64")
    },
    skill_name: params.skillName
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

test("aggregates telemetry prompt-source signals across the latest turn", async () => {
  const workspacePath = path.join(os.tmpdir(), "workspace-telemetry-turn");
  const sessionId = "session-telemetry-turn";
  const fixture = await createClaudeFixture(
    workspacePath,
    "session-telemetry-turn.jsonl",
    [
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
        input: 12,
        output: 18,
        cacheWrite: 50,
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
            content: "Result"
          }
        ]
      }),
      assistantRecord({
        uuid: "assistant-2",
        parentUuid: "user-2",
        sessionId,
        cwd: workspacePath,
        timestamp: "2026-03-26T12:00:04.000Z",
        input: 8,
        output: 11,
        cacheRead: 25,
        stopReason: "end_turn"
      })
    ],
    [
      telemetryEvent({
        sessionId,
        name: "tengu_input_prompt",
        timestamp: "2026-03-26T11:59:59.900Z"
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_sysprompt_block",
        timestamp: "2026-03-26T11:59:59.920Z",
        metadata: {
          length: 200,
          hash: "sys-1"
        }
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_skill_loaded",
        timestamp: "2026-03-26T11:59:59.930Z",
        metadata: {
          skill_budget: 1600
        },
        skillName: "memory-recall"
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_claudemd__initial_load",
        timestamp: "2026-03-26T11:59:59.940Z",
        metadata: {
          file_count: 2,
          total_content_length: 900,
          project_count: 1,
          user_count: 0,
          local_count: 0,
          managed_count: 0,
          automem_count: 1,
          teammem_count: 0
        }
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_context_size",
        timestamp: "2026-03-26T11:59:59.950Z",
        metadata: {
          git_status_size: 300,
          claude_md_size: 1200,
          non_mcp_tools_tokens: 4000,
          mcp_tools_tokens: 0
        }
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_input_prompt",
        timestamp: "2026-03-26T12:00:03.000Z"
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_sysprompt_block",
        timestamp: "2026-03-26T12:00:03.010Z",
        metadata: {
          length: 220,
          hash: "sys-2"
        }
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_skill_loaded",
        timestamp: "2026-03-26T12:00:03.020Z",
        metadata: {
          skill_budget: 800
        },
        skillName: "update-memory"
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_claudemd__initial_load",
        timestamp: "2026-03-26T12:00:03.030Z",
        metadata: {
          file_count: 1,
          total_content_length: 500,
          project_count: 0,
          user_count: 0,
          local_count: 0,
          managed_count: 0,
          automem_count: 1,
          teammem_count: 0
        }
      }),
      telemetryEvent({
        sessionId,
        name: "tengu_context_size",
        timestamp: "2026-03-26T12:00:03.040Z",
        metadata: {
          git_status_size: 100,
          claude_md_size: 600,
          non_mcp_tools_tokens: 4000,
          mcp_tools_tokens: 50
        }
      })
    ]
  );

  const discovery = await discoverCurrentSession({
    dataDirectory: fixture.claudeRoot,
    workspaceFolders: [workspacePath],
    preferredWorkspaceFolder: workspacePath
  });
  assert.ok(discovery.session);

  const snapshot = await loadSessionSnapshot(discovery.session);
  const analysis = computeLatestTurnAnalysis(snapshot);

  assert.ok(analysis);
  assert.ok(analysis.promptSources);
  assert.equal(analysis.promptSources.promptCount, 2);
  assert.equal(analysis.promptSources.breakdown.systemPrompt, 420);
  assert.equal(analysis.promptSources.breakdown.skills, 2400);
  assert.equal(analysis.promptSources.breakdown.claudeMd, 1800);
  assert.equal(analysis.promptSources.breakdown.environment, 400);
  assert.equal(analysis.promptSources.breakdown.builtInTools, 8000);
  assert.equal(analysis.promptSources.breakdown.mcpTools, 50);
  assert.equal(analysis.promptSources.totalKnownValue, 13070);
  assert.equal(analysis.promptSources.dominantSource, "builtInTools");
  assert.equal(analysis.promptSources.instructionLoads?.fileCount, 3);
  assert.equal(analysis.promptSources.instructionLoads?.automemCount, 2);
});

test("computes rolling workspace usage windows across multiple sessions", async () => {
  const workspacePath = path.join(os.tmpdir(), "workspace-recent-usage");
  const sessionId = "recent-usage-a";
  const fixture = await createClaudeFixture(workspacePath, "recent-usage-a.jsonl", [
    userRecord({
      uuid: "user-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-28T11:20:00.000Z"
    }),
    assistantRecord({
      uuid: "assistant-1",
      parentUuid: "user-1",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-28T11:30:00.000Z",
      input: 10,
      output: 20,
      cacheWrite: 30,
      cacheRead: 40
    }),
    userRecord({
      uuid: "user-2",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-28T01:00:00.000Z"
    }),
    assistantRecord({
      uuid: "assistant-2",
      parentUuid: "user-2",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-28T02:00:00.000Z",
      input: 5,
      output: 5,
      cacheWrite: 10,
      cacheRead: 0
    }),
    userRecord({
      uuid: "user-3",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T10:00:00.000Z"
    }),
    assistantRecord({
      uuid: "assistant-3",
      parentUuid: "user-3",
      sessionId,
      cwd: workspacePath,
      timestamp: "2026-03-26T12:00:00.000Z",
      input: 1,
      output: 2,
      cacheWrite: 3,
      cacheRead: 4
    })
  ]);

  const secondProjectDir = path.join(
    fixture.claudeRoot,
    "projects",
    "sample-project-2"
  );
  await fs.mkdir(secondProjectDir, { recursive: true });
  await fs.writeFile(
    path.join(secondProjectDir, "recent-usage-b.jsonl"),
    [
      userRecord({
        uuid: "user-4",
        sessionId: "recent-usage-b",
        cwd: workspacePath,
        timestamp: "2026-03-23T09:00:00.000Z"
      }),
      assistantRecord({
        uuid: "assistant-4",
        parentUuid: "user-4",
        sessionId: "recent-usage-b",
        cwd: workspacePath,
        timestamp: "2026-03-23T12:00:00.000Z",
        input: 7,
        output: 8,
        cacheWrite: 9,
        cacheRead: 10
      }),
      userRecord({
        uuid: "user-5",
        sessionId: "recent-usage-b",
        cwd: workspacePath,
        timestamp: "2026-03-10T09:00:00.000Z"
      }),
      assistantRecord({
        uuid: "assistant-5",
        parentUuid: "user-5",
        sessionId: "recent-usage-b",
        cwd: workspacePath,
        timestamp: "2026-03-10T12:00:00.000Z",
        input: 11,
        output: 12,
        cacheWrite: 13,
        cacheRead: 14
      })
    ].join("\n") + "\n",
    "utf8"
  );

  const summary = await computeWorkspaceRecentUsageSummary({
    dataDirectory: fixture.claudeRoot,
    workspacePath,
    now: new Date("2026-03-28T12:00:00.000Z")
  });

  assert.ok(summary);
  assert.equal(summary.windows.length, 5);

  const oneHour = summary.windows[0];
  assert.equal(oneHour.key, "1h");
  assert.equal(oneHour.breakdown.totalTokens, 100);
  assert.equal(oneHour.breakdown.inputTokens, 10);
  assert.equal(oneHour.breakdown.outputTokens, 20);
  assert.equal(oneHour.breakdown.cacheWriteTokens, 30);
  assert.equal(oneHour.breakdown.cacheReadTokens, 40);
  assert.equal(oneHour.assistantCalls, 1);
  assert.equal(oneHour.sessionCount, 1);

  const oneDay = summary.windows[1];
  assert.equal(oneDay.key, "1d");
  assert.equal(oneDay.breakdown.totalTokens, 120);
  assert.equal(oneDay.assistantCalls, 2);

  const threeDays = summary.windows[2];
  assert.equal(threeDays.key, "3d");
  assert.equal(threeDays.breakdown.totalTokens, 130);

  const sevenDays = summary.windows[3];
  assert.equal(sevenDays.key, "7d");
  assert.equal(sevenDays.breakdown.totalTokens, 164);
  assert.equal(sevenDays.assistantCalls, 4);
  assert.equal(sevenDays.sessionCount, 2);

  const thirtyDays = summary.windows[4];
  assert.equal(thirtyDays.key, "30d");
  assert.equal(thirtyDays.breakdown.totalTokens, 214);
  assert.equal(thirtyDays.assistantCalls, 5);
  assert.equal(thirtyDays.sessionCount, 2);
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
