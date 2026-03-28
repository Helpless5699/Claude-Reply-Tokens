export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeTextContentBlock {
  type: "text";
  text?: string;
}

export interface ClaudeThinkingContentBlock {
  type: "thinking";
  thinking?: string;
  signature?: string;
}

export interface ClaudeToolUseContentBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ClaudeToolResultContentBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ClaudeGenericContentBlock {
  type?: string;
  [key: string]: unknown;
}

export type ClaudeContentBlock =
  | ClaudeTextContentBlock
  | ClaudeThinkingContentBlock
  | ClaudeToolUseContentBlock
  | ClaudeToolResultContentBlock
  | ClaudeGenericContentBlock;

export interface ClaudeMessage {
  role?: string;
  model?: string;
  id?: string;
  content?: string | ClaudeContentBlock[];
  stop_reason?: string | null;
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

export type TokenBucketKind =
  | "inputTokens"
  | "outputTokens"
  | "cacheWriteTokens"
  | "cacheReadTokens";

export type TurnContentCategory =
  | "userText"
  | "toolResult"
  | "assistantToolUse"
  | "assistantThinking"
  | "assistantText"
  | "other";

export type PromptSourceKind =
  | "systemPrompt"
  | "skills"
  | "claudeMd"
  | "environment"
  | "builtInTools"
  | "mcpTools";

export interface ContentMetric {
  chars: number;
  blocks: number;
}

export type ContentMetrics = Record<TurnContentCategory, ContentMetric>;

export interface ClaudeTelemetryEvent {
  name: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  skillName?: string;
}

export interface ClaudeInstructionLoadBreakdown {
  fileCount: number;
  totalContentLength: number;
  userCount: number;
  projectCount: number;
  localCount: number;
  managedCount: number;
  automemCount: number;
  teammemCount: number;
}

export interface PromptSourceBreakdown {
  systemPrompt: number;
  skills: number;
  claudeMd: number;
  environment: number;
  builtInTools: number;
  mcpTools: number;
}

export interface PromptSourceAnalysis {
  promptCount: number;
  totalKnownValue: number;
  breakdown: PromptSourceBreakdown;
  dominantSource: PromptSourceKind | null;
  instructionLoads: ClaudeInstructionLoadBreakdown | null;
  hasConversationGap: boolean;
}

export type RecentUsageWindowKey = "1h" | "1d" | "3d" | "7d" | "30d";

export interface RecentUsageWindowAnalysis {
  key: RecentUsageWindowKey;
  label: string;
  startedAt: string;
  breakdown: UsageBreakdown;
  dominantTokenBucket: TokenBucketKind | null;
  assistantCalls: number;
  sessionCount: number;
}

export interface WorkspaceRecentUsageSummary {
  scopePath: string;
  generatedAt: string;
  windows: RecentUsageWindowAnalysis[];
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

export interface AssistantStepAnalysis {
  uuid: string;
  timestamp: string;
  model: string;
  stopReason: string | null;
  kinds: string[];
  toolNames: string[];
  breakdown: UsageBreakdown;
}

export interface TurnAnalysis {
  sessionId: string;
  assistantUuid: string;
  model: string;
  timestamp: string;
  turnStartedAt: string;
  transcriptPath: string;
  breakdown: UsageBreakdown;
  dominantTokenBucket: TokenBucketKind | null;
  promptSources: PromptSourceAnalysis | null;
  contentMetrics: ContentMetrics;
  dominantContentCategory: TurnContentCategory | null;
  steps: AssistantStepAnalysis[];
  recordCount: number;
}

export interface SessionSnapshot {
  session: SessionMatch;
  records: ClaudeRecord[];
  telemetryEvents: ClaudeTelemetryEvent[];
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
