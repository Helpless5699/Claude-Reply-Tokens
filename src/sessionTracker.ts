import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AssistantStepAnalysis,
  ClaudeRecord,
  ClaudeToolUseContentBlock,
  ClaudeUsage,
  ContentMetrics,
  SessionDiscovery,
  SessionMatch,
  SessionSnapshot,
  TokenBucketKind,
  TurnAnalysis,
  TurnContentCategory,
  TrackerConfig,
  TurnUsage,
  UsageBreakdown
} from "./types";
import { normalizeFsPath, workspaceMatchesCwd } from "./utils";

const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const PROJECTS_DIR_NAME = "projects";
const DEFAULT_REFRESH_ENCODING = "utf8";

interface CountableAssistantRecord extends ClaudeRecord {
  uuid: string;
  timestamp: string;
}

interface LatestTurnRecords {
  latestAssistant: CountableAssistantRecord;
  records: ClaudeRecord[];
}

export async function discoverCurrentSession(
  config: TrackerConfig
): Promise<SessionDiscovery> {
  const claudeRoots = await getClaudeRoots(config.dataDirectory);
  if (claudeRoots.length === 0) {
    return {
      claudeRoot: null,
      projectsPath: null,
      session: null
    };
  }

  const workspaceOrder = buildWorkspacePreferenceOrder(
    config.workspaceFolders,
    config.preferredWorkspaceFolder
  );

  for (const claudeRoot of claudeRoots) {
    const projectsPath = path.join(claudeRoot, PROJECTS_DIR_NAME);
    const jsonlFiles = await findJsonlFiles(projectsPath);
    if (jsonlFiles.length === 0) {
      continue;
    }

    const candidates = await Promise.all(
      jsonlFiles.map(async (jsonlPath) => summarizeSessionFile(jsonlPath))
    );
    const validCandidates = candidates.filter(
      (candidate): candidate is SessionMatch => candidate !== null
    );
    const session = chooseBestSession(validCandidates, workspaceOrder);

    if (session) {
      return {
        claudeRoot,
        projectsPath,
        session
      };
    }
  }

  return {
    claudeRoot: claudeRoots[0],
    projectsPath: path.join(claudeRoots[0], PROJECTS_DIR_NAME),
    session: null
  };
}

export async function loadSessionSnapshot(
  session: SessionMatch
): Promise<SessionSnapshot> {
  const content = await fs.readFile(session.jsonlPath, DEFAULT_REFRESH_ENCODING);
  const stats = await fs.stat(session.jsonlPath);
  const { records, trailingPartial } = parseJsonlText(content);

  return {
    session,
    records,
    offset: stats.size,
    trailingPartial
  };
}

export async function refreshSessionSnapshot(
  snapshot: SessionSnapshot
): Promise<SessionSnapshot> {
  const stats = await fs.stat(snapshot.session.jsonlPath);
  if (stats.size < snapshot.offset) {
    return loadSessionSnapshot(snapshot.session);
  }

  if (stats.size === snapshot.offset) {
    return snapshot;
  }

  const fileHandle = await fs.open(snapshot.session.jsonlPath, "r");
  try {
    const buffer = Buffer.alloc(stats.size - snapshot.offset);
    await fileHandle.read(buffer, 0, buffer.length, snapshot.offset);
    const appendedText = buffer.toString(DEFAULT_REFRESH_ENCODING);
    const parsed = parseJsonlText(`${snapshot.trailingPartial}${appendedText}`);

    return {
      session: snapshot.session,
      records: snapshot.records.concat(parsed.records),
      offset: stats.size,
      trailingPartial: parsed.trailingPartial
    };
  } finally {
    await fileHandle.close();
  }
}

export function computeLatestTurnUsage(snapshot: SessionSnapshot): TurnUsage | null {
  const latestTurn = collectLatestTurnRecords(snapshot);
  if (!latestTurn) {
    return null;
  }

  const breakdown = emptyBreakdown();
  for (const record of latestTurn.records) {
    if (isCountableAssistant(record)) {
      accumulateUsage(breakdown, record.message!.usage!);
    }
  }

  return {
    sessionId: snapshot.session.sessionId,
    assistantUuid: latestTurn.latestAssistant.uuid,
    model: latestTurn.latestAssistant.message?.model ?? "unknown",
    timestamp: latestTurn.latestAssistant.timestamp,
    breakdown,
    transcriptPath: snapshot.session.jsonlPath
  };
}

export function computeLatestTurnAnalysis(
  snapshot: SessionSnapshot
): TurnAnalysis | null {
  const latestTurn = collectLatestTurnRecords(snapshot);
  if (!latestTurn) {
    return null;
  }

  const breakdown = emptyBreakdown();
  const contentMetrics = emptyContentMetrics();
  const steps: AssistantStepAnalysis[] = [];

  for (const record of latestTurn.records) {
    accumulateRecordContentMetrics(contentMetrics, record);

    if (isCountableAssistant(record)) {
      const stepBreakdown = emptyBreakdown();
      accumulateUsage(stepBreakdown, record.message!.usage!);
      accumulateUsage(breakdown, record.message!.usage!);

      steps.push({
        uuid:
          record.uuid ??
          `${snapshot.session.sessionId}-assistant-step-${steps.length + 1}`,
        timestamp: record.timestamp ?? latestTurn.latestAssistant.timestamp,
        model: record.message?.model ?? latestTurn.latestAssistant.message?.model ?? "unknown",
        stopReason: record.message?.stop_reason ?? null,
        kinds: collectAssistantKinds(record),
        toolNames: collectAssistantToolNames(record),
        breakdown: stepBreakdown
      });
    }
  }

  return {
    sessionId: snapshot.session.sessionId,
    assistantUuid: latestTurn.latestAssistant.uuid,
    model: latestTurn.latestAssistant.message?.model ?? "unknown",
    timestamp: latestTurn.latestAssistant.timestamp,
    turnStartedAt:
      latestTurn.records[0]?.timestamp ?? latestTurn.latestAssistant.timestamp,
    transcriptPath: snapshot.session.jsonlPath,
    breakdown,
    dominantTokenBucket: findDominantTokenBucket(breakdown),
    contentMetrics,
    dominantContentCategory: findDominantContentCategory(contentMetrics),
    steps,
    recordCount: latestTurn.records.length
  };
}

export function emptyBreakdown(): UsageBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0
  };
}

function accumulateUsage(breakdown: UsageBreakdown, usage: ClaudeUsage): void {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

  breakdown.inputTokens += inputTokens;
  breakdown.outputTokens += outputTokens;
  breakdown.cacheWriteTokens += cacheWriteTokens;
  breakdown.cacheReadTokens += cacheReadTokens;
  breakdown.totalTokens +=
    inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;
}

function emptyContentMetrics(): ContentMetrics {
  return {
    userText: {
      label: "User text",
      chars: 0,
      blocks: 0
    },
    toolResult: {
      label: "Tool results",
      chars: 0,
      blocks: 0
    },
    assistantToolUse: {
      label: "Assistant tool calls",
      chars: 0,
      blocks: 0
    },
    assistantThinking: {
      label: "Assistant thinking",
      chars: 0,
      blocks: 0
    },
    assistantText: {
      label: "Assistant text",
      chars: 0,
      blocks: 0
    },
    other: {
      label: "Other blocks",
      chars: 0,
      blocks: 0
    }
  };
}

function buildRecordIndex(records: ClaudeRecord[]): Map<string, ClaudeRecord> {
  const index = new Map<string, ClaudeRecord>();
  for (const record of records) {
    if (record.uuid) {
      index.set(record.uuid, record);
    }
  }
  return index;
}

function findLatestCountableAssistant(records: ClaudeRecord[]): ClaudeRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const candidate = records[index];
    if (isCountableAssistant(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function collectLatestTurnRecords(
  snapshot: SessionSnapshot
): LatestTurnRecords | null {
  const latestAssistant = findLatestTrackedAssistant(snapshot.records);
  if (!latestAssistant) {
    return null;
  }

  const recordByUuid = buildRecordIndex(snapshot.records);
  const chain: ClaudeRecord[] = [];
  const visited = new Set<string>();
  let current: ClaudeRecord | undefined = latestAssistant;

  while (current?.uuid && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    chain.push(current);

    const parentUuid = current.parentUuid ?? undefined;
    if (!parentUuid) {
      break;
    }

    const parentRecord = recordByUuid.get(parentUuid);
    if (!parentRecord) {
      break;
    }

    if (isTurnBoundaryUser(parentRecord)) {
      chain.push(parentRecord);
      break;
    }

    current = parentRecord;
  }

  return {
    latestAssistant,
    records: chain.reverse()
  };
}

function findLatestTrackedAssistant(
  records: ClaudeRecord[]
): CountableAssistantRecord | undefined {
  const latestAssistant = findLatestCountableAssistant(records);
  if (!latestAssistant?.uuid || !latestAssistant.timestamp) {
    return undefined;
  }

  return latestAssistant as CountableAssistantRecord;
}

function isCountableAssistant(record: ClaudeRecord | undefined): boolean {
  if (!record || record.type !== "assistant" || record.isApiErrorMessage) {
    return false;
  }

  const usage = record.message?.usage;
  if (!usage) {
    return false;
  }

  if (
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return false;
  }

  return record.message?.model !== "<synthetic>";
}

function isTurnBoundaryUser(record: ClaudeRecord): boolean {
  return record.type === "user" && !isToolResultOnlyUser(record);
}

function isToolResultOnlyUser(record: ClaudeRecord): boolean {
  if (record.type !== "user") {
    return false;
  }

  const content = record.message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }

  return content.every(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block.type ?? undefined) === "tool_result"
  );
}

function accumulateRecordContentMetrics(
  metrics: ContentMetrics,
  record: ClaudeRecord
): void {
  const content = record.message?.content;
  if (typeof content === "string") {
    addContentMetric(
      metrics,
      record.type === "assistant" ? "assistantText" : "userText",
      content.length
    );
    return;
  }

  if (!Array.isArray(content)) {
    return;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    switch (block.type) {
      case "text":
        addContentMetric(
          metrics,
          record.type === "assistant" ? "assistantText" : "userText",
          typeof block.text === "string" ? block.text.length : 0
        );
        break;
      case "thinking":
        addContentMetric(
          metrics,
          "assistantThinking",
          typeof block.thinking === "string" ? block.thinking.length : 0
        );
        break;
      case "tool_use":
        addContentMetric(
          metrics,
          "assistantToolUse",
          estimateValueLength({
            name: (block as ClaudeToolUseContentBlock).name,
            input: (block as ClaudeToolUseContentBlock).input
          })
        );
        break;
      case "tool_result":
        addContentMetric(
          metrics,
          "toolResult",
          estimateValueLength(block.content)
        );
        break;
      default:
        addContentMetric(metrics, "other", estimateValueLength(block));
        break;
    }
  }
}

function addContentMetric(
  metrics: ContentMetrics,
  category: TurnContentCategory,
  chars: number
): void {
  metrics[category].blocks += 1;
  metrics[category].chars += Math.max(0, chars);
}

function estimateValueLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }

  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + estimateValueLength(entry), 0);
  }

  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).length;
  }

  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function collectAssistantKinds(record: ClaudeRecord): string[] {
  const content = record.message?.content;
  const kinds = new Set<string>();

  if (typeof content === "string" && content.trim().length > 0) {
    kinds.add("text");
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }

      kinds.add(typeof block.type === "string" ? block.type : "other");
    }
  }

  return Array.from(kinds.values());
}

function collectAssistantToolNames(record: ClaudeRecord): string[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolNames = new Set<string>();
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      block.type === "tool_use" &&
      typeof (block as ClaudeToolUseContentBlock).name === "string"
    ) {
      toolNames.add((block as ClaudeToolUseContentBlock).name!);
    }
  }

  return Array.from(toolNames.values());
}

function findDominantTokenBucket(
  breakdown: UsageBreakdown
): TokenBucketKind | null {
  const candidates: Array<[TokenBucketKind, number]> = [
    ["inputTokens", breakdown.inputTokens],
    ["outputTokens", breakdown.outputTokens],
    ["cacheWriteTokens", breakdown.cacheWriteTokens],
    ["cacheReadTokens", breakdown.cacheReadTokens]
  ];
  const dominant = candidates.reduce((best, current) =>
    current[1] > best[1] ? current : best
  );

  return dominant[1] > 0 ? dominant[0] : null;
}

function findDominantContentCategory(
  metrics: ContentMetrics
): TurnContentCategory | null {
  const entries = Object.entries(metrics) as Array<[TurnContentCategory, ContentMetrics[TurnContentCategory]]>;
  const dominant = entries.reduce(
    (best, current) => (current[1].chars > best[1].chars ? current : best),
    entries[0]
  );

  return dominant && dominant[1].chars > 0 ? dominant[0] : null;
}

function parseJsonlText(text: string): {
  records: ClaudeRecord[];
  trailingPartial: string;
} {
  if (text.length === 0) {
    return {
      records: [],
      trailingPartial: ""
    };
  }

  const parts = text.split(/\r?\n/);
  let trailingPartial = "";
  if (!text.endsWith("\n") && !text.endsWith("\r")) {
    const lastPart = parts.pop() ?? "";
    const parsedLastPart = parseRecordLine(lastPart);
    if (parsedLastPart) {
      parts.push(lastPart);
    } else {
      trailingPartial = lastPart;
    }
  }
  const records: ClaudeRecord[] = [];

  for (const line of parts) {
    const parsed = parseRecordLine(line);
    if (parsed) {
      records.push(parsed);
    }
  }

  return {
    records,
    trailingPartial
  };
}

function parseRecordLine(line: string): ClaudeRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as ClaudeRecord;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function summarizeSessionFile(jsonlPath: string): Promise<SessionMatch | null> {
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, DEFAULT_REFRESH_ENCODING);
  } catch {
    return null;
  }

  const parsed = parseJsonlText(content);
  const latestAssistant = findLatestCountableAssistant(parsed.records);
  if (!latestAssistant?.timestamp || !latestAssistant.cwd) {
    return null;
  }

  return {
    sessionId:
      latestAssistant.sessionId ?? path.basename(jsonlPath, path.extname(jsonlPath)),
    jsonlPath,
    cwd: latestAssistant.cwd,
    lastAssistantAt: latestAssistant.timestamp
  };
}

function chooseBestSession(
  candidates: SessionMatch[],
  workspaceOrder: string[]
): SessionMatch | null {
  for (const workspacePath of workspaceOrder) {
    const matching = candidates.filter((candidate) =>
      workspaceMatchesCwd(workspacePath, candidate.cwd)
    );

    if (matching.length > 0) {
      return matching.sort(compareSessionActivity)[0];
    }
  }

  return null;
}

function compareSessionActivity(left: SessionMatch, right: SessionMatch): number {
  return (
    new Date(right.lastAssistantAt).getTime() -
    new Date(left.lastAssistantAt).getTime()
  );
}

function buildWorkspacePreferenceOrder(
  workspaceFolders: string[],
  preferredWorkspaceFolder?: string
): string[] {
  const orderedPaths = new Map<string, string>();

  if (preferredWorkspaceFolder) {
    orderedPaths.set(normalizeFsPath(preferredWorkspaceFolder), preferredWorkspaceFolder);
  }

  for (const workspaceFolder of workspaceFolders) {
    orderedPaths.set(normalizeFsPath(workspaceFolder), workspaceFolder);
  }

  return Array.from(orderedPaths.values());
}

async function getClaudeRoots(dataDirectory?: string): Promise<string[]> {
  const candidateRoots: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidatePath: string | undefined): void => {
    if (!candidatePath) {
      return;
    }

    const normalized = normalizeFsPath(candidatePath);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidateRoots.push(candidatePath);
    }
  };

  if (dataDirectory?.trim()) {
    addCandidate(dataDirectory.trim());
  } else {
    const envValue = process.env[CLAUDE_CONFIG_DIR_ENV]?.trim();
    if (envValue) {
      for (const envPath of envValue.split(",")) {
        addCandidate(envPath.trim());
      }
    }

    addCandidate(path.join(os.homedir(), ".claude"));
    addCandidate(
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "claude")
    );
  }

  const validRoots: string[] = [];
  for (const rootPath of candidateRoots) {
    try {
      const projectsPath = path.join(rootPath, PROJECTS_DIR_NAME);
      const stats = await fs.stat(projectsPath);
      if (stats.isDirectory()) {
        validRoots.push(rootPath);
      }
    } catch {
      // Ignore invalid candidates.
    }
  }

  return validRoots;
}

async function findJsonlFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function visitDirectory(directoryPath: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  await visitDirectory(rootPath);
  return files;
}
