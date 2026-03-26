export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeMessage {
  role?: string;
  model?: string;
  id?: string;
  usage?: ClaudeUsage;
}

export interface ClaudeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isApiErrorMessage?: boolean;
  message?: ClaudeMessage;
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface SessionMatch {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  lastAssistantAt: string;
}

export interface TurnUsage {
  sessionId: string;
  assistantUuid: string;
  model: string;
  timestamp: string;
  breakdown: UsageBreakdown;
  transcriptPath: string;
}

export interface SessionSnapshot {
  session: SessionMatch;
  records: ClaudeRecord[];
  offset: number;
  trailingPartial: string;
}

export interface SessionDiscovery {
  claudeRoot: string | null;
  projectsPath: string | null;
  session: SessionMatch | null;
}

export interface TrackerConfig {
  dataDirectory?: string;
  preferredWorkspaceFolder?: string;
  workspaceFolders: string[];
}
