import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ClaudeRecord,
  ClaudeUsage,
  SessionDiscovery,
  SessionMatch,
  SessionSnapshot,
  TrackerConfig,
  TurnUsage,
  UsageBreakdown
} from "./types";
import { normalizeFsPath, workspaceMatchesCwd } from "./utils";

const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const PROJECTS_DIR_NAME = "projects";
const DEFAULT_REFRESH_ENCODING = "utf8";

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
  const recordByUuid = buildRecordIndex(snapshot.records);
  const latestAssistant = findLatestCountableAssistant(snapshot.records);
  if (!latestAssistant?.uuid || !latestAssistant.timestamp) {
    return null;
  }

  const visited = new Set<string>();
  const breakdown = emptyBreakdown();
  let current: ClaudeRecord | undefined = latestAssistant;

  while (current?.uuid && !visited.has(current.uuid)) {
    visited.add(current.uuid);

    if (current.type === "user") {
      break;
    }

    if (isCountableAssistant(current)) {
      accumulateUsage(breakdown, current.message!.usage!);
    }

    const parentUuid = current.parentUuid ?? undefined;
    if (!parentUuid) {
      break;
    }

    const parentRecord = recordByUuid.get(parentUuid);
    if (!parentRecord || parentRecord.type === "user") {
      break;
    }

    current = parentRecord;
  }

  return {
    sessionId: snapshot.session.sessionId,
    assistantUuid: latestAssistant.uuid,
    model: latestAssistant.message?.model ?? "unknown",
    timestamp: latestAssistant.timestamp,
    breakdown,
    transcriptPath: snapshot.session.jsonlPath
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
