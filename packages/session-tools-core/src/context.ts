/**
 * Session Tools Core - Context Interface
 *
 * Defines the abstract context interface that both Claude (in-process)
 * and Codex (subprocess) implementations must provide.
 *
 * This enables writing tool handlers once and running them in both environments.
 */

import type {
  AuthRequest,
  ToolResult,
  SourceConfig,
  GoogleService,
  SlackService,
  MicrosoftService,
  McpSourceConfig,
} from './types.ts';

// ============================================================
// Source Credential Types
// ============================================================

/**
 * Loaded source with context for credential operations.
 * Note: guide field omitted as credential manager doesn't use it.
 */
export interface LoadedSource {
  config: SourceConfig;
  folderPath: string;
  workspaceRootPath: string;
  workspaceId: string;
}

// ============================================================
// Callback Interface
// ============================================================

/**
 * Callbacks for session tool operations.
 * Both Claude and Codex implement this interface differently:
 * - Claude: Direct function calls via registry
 * - Codex: JSON messages over stderr
 */
export interface SessionToolCallbacks {
  /**
   * Called when a plan is submitted.
   * Claude: calls onPlanSubmitted callback
   * Codex: sends __CALLBACK__ message to stderr
   */
  onPlanSubmitted(planPath: string): void;

  /**
   * Called when authentication is requested.
   * Claude: calls onAuthRequest callback + forceAbort
   * Codex: sends __CALLBACK__ message to stderr
   */
  onAuthRequest(request: AuthRequest): void;
}

// ============================================================
// File System Interface
// ============================================================

/**
 * File system abstraction for portability.
 * Allows mocking in tests and different implementations in different environments.
 */
export interface FileSystemInterface {
  /** Check if file/directory exists */
  exists(path: string): boolean;

  /** Read file as UTF-8 string */
  readFile(path: string): string;

  /** Read file as Buffer (for binary/images) */
  readFileBuffer(path: string): Buffer;

  /** Write file */
  writeFile(path: string, content: string): void;

  /** Check if path is a directory */
  isDirectory(path: string): boolean;

  /** List directory contents */
  readdir(path: string): string[];

  /** Get file stats */
  stat(path: string): { size: number; isDirectory(): boolean };
}

// ============================================================
// Credential Manager Interface
// ============================================================

/**
 * Credential manager abstraction.
 * Claude has full access to credential stores.
 * Codex may have limited or no access (relies on main process).
 */
export interface CredentialManagerInterface {
  /**
   * Check if a source has valid, non-expired credentials
   */
  hasValidCredentials(source: LoadedSource): Promise<boolean>;

  /**
   * Get the current access token for a source (null if expired/missing)
   */
  getToken(source: LoadedSource): Promise<string | null>;

  /**
   * Refresh the access token for a source
   */
  refresh(source: LoadedSource): Promise<string | null>;
}

/**
 * OAuth credentials for an LLM connection.
 */
export interface LlmOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
}

/**
 * Minimal LLM connection metadata exposed to session tools.
 */
export interface LlmConnectionInfo {
  slug: string;
  providerType?: string;
  authType?: string;
  piAuthProvider?: string;
}

/**
 * LLM credential manager abstraction.
 * Desktop-backed contexts can provide this for tools that need the user's
 * existing model-provider OAuth token without exposing unrelated credentials.
 */
export interface LlmCredentialManagerInterface {
  getOAuth(connectionSlug: string): Promise<LlmOAuthCredential | null>;
  setOAuth?(connectionSlug: string, credentials: LlmOAuthCredential): Promise<void>;
  refreshOAuth?(connectionSlug: string, credentials: LlmOAuthCredential): Promise<LlmOAuthCredential | null>;
}

// ============================================================
// Validator Interface
// ============================================================

/**
 * Config validation interface.
 * Claude uses full Zod validators from packages/shared.
 * Codex uses simplified validators from session-tools-core.
 */
export interface ValidatorInterface {
  validateConfig(): import('./types.js').ValidationResult;
  validateSource(workspaceRootPath: string, sourceSlug: string): import('./types.js').ValidationResult;
  validateAllSources(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateStatuses(workspaceRootPath: string): import('./types.js').ValidationResult;
  validatePreferences(): import('./types.js').ValidationResult;
  validatePermissions(workspaceRootPath: string, sourceSlug?: string): import('./types.js').ValidationResult;
  validateAutomations(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateToolIcons(): import('./types.js').ValidationResult;
  validateAll(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateSkill(workspaceRootPath: string, skillSlug: string): import('./types.js').ValidationResult;
}

// ============================================================
// Session Tool Context
// ============================================================

/**
 * Main context interface for session tools.
 *
 * Both Claude and Codex create their own implementation of this interface:
 * - Claude: createClaudeContext() with direct access to Electron internals
 * - Codex: createCodexContext() with callback IPC and limited capabilities
 */
export interface SessionToolContext {
  // ============================================================
  // Session Info
  // ============================================================

  /** Unique session identifier */
  sessionId: string;

  /** Absolute path to workspace folder (~/.craft-agent/workspaces/{id}) */
  workspacePath: string;

  /** Path to sources folder within workspace */
  get sourcesPath(): string;

  /** Path to skills folder within workspace */
  get skillsPath(): string;

  /** Path to session's plans folder */
  plansFolderPath: string;

  /** Working directory (project root) for the session, if set */
  workingDirectory?: string;

  /** Current LLM connection slug for the session, if known */
  llmConnectionSlug?: string;

  // ============================================================
  // Callbacks (transport-agnostic)
  // ============================================================

  callbacks: SessionToolCallbacks;

  // ============================================================
  // File System
  // ============================================================

  fs: FileSystemInterface;

  // ============================================================
  // Validators (optional - may use basic or full)
  // ============================================================

  validators?: ValidatorInterface;

  // ============================================================
  // Optional Capabilities
  // ============================================================

  /**
   * Get credential manager for source authentication checks.
   * Only available in Claude (has keychain access).
   */
  credentialManager?: CredentialManagerInterface;

  /**
   * Get credential manager for LLM connection OAuth tokens.
   * Only available in desktop contexts with access to the credential store.
   */
  llmCredentialManager?: LlmCredentialManagerInterface;

  /**
   * List configured LLM connections so tools can discover compatible OAuth
   * connections when the current session uses a different provider.
   */
  listLlmConnections?(): LlmConnectionInfo[];

  /**
   * Load a source config from the workspace.
   */
  loadSourceConfig(sourceSlug: string): SourceConfig | null;

  /**
   * Save a source config to the workspace.
   */
  saveSourceConfig?(source: SourceConfig): void;

  /**
   * Infer Google service from URL.
   */
  inferGoogleService?(url?: string): GoogleService | undefined;

  /**
   * Infer Slack service from URL.
   */
  inferSlackService?(url?: string): SlackService | undefined;

  /**
   * Infer Microsoft service from URL.
   */
  inferMicrosoftService?(url?: string): MicrosoftService | undefined;

  /**
   * Check if Google OAuth is configured.
   */
  isGoogleOAuthConfigured?(clientId?: string, clientSecret?: string): boolean;

  // ============================================================
  // Icon Management (for source_test)
  // ============================================================

  /**
   * Check if a value is a URL that can be used as an icon.
   */
  isIconUrl?(value: string): boolean;

  /**
   * Download an icon from URL to the source folder.
   * Returns the path to the cached icon, or null if download failed.
   */
  downloadSourceIcon?(sourceSlug: string, iconUrl: string): Promise<string | null>;

  /**
   * Derive a service URL from a source config (for favicon fetching).
   */
  deriveServiceUrl?(source: SourceConfig): string | null;

  /**
   * Get a high-quality logo URL from a service URL.
   */
  getHighQualityLogoUrl?(serviceUrl: string, slug: string): Promise<string | null>;

  /**
   * Download an icon to a specific destination path.
   */
  downloadIcon?(destPath: string, url: string, tag: string): Promise<string | null>;

  // ============================================================
  // MCP Connection Validation (for source_test)
  // ============================================================

  /**
   * Validate a stdio MCP connection by spawning the command.
   */
  validateStdioMcpConnection?(config: StdioMcpConfig): Promise<StdioValidationResult>;

  /**
   * Validate an HTTP/SSE MCP connection.
   */
  validateMcpConnection?(config: HttpMcpConfig): Promise<McpValidationResult>;

  // ============================================================
  // API Testing (for source_test)
  // ============================================================

  /**
   * Test an API source connection with full credential handling.
   */
  testApiSource?(source: SourceConfig): Promise<ApiTestResult>;

  /**
   * Test a Google source (OAuth token validation).
   */
  testGoogleSource?(source: SourceConfig): Promise<ApiTestResult>;

  // ============================================================
  // Preferences (for update_user_preferences)
  // ============================================================

  /**
   * Submit developer feedback. Injected by each backend:
   * - Claude: writes JSON files to ~/.craft-agent/feedback/
   * - Codex/Pi: could send over IPC or write directly
   */
  submitFeedback?(feedback: import('./types.ts').DeveloperFeedback): void;

  /**
   * Update user preferences. Injected by each backend:
   * - Claude: calls updatePreferences() from config/preferences.ts
   * - Codex/session-mcp-server: writes directly to preferences.json
   * - Pi: calls updatePreferences() from config/preferences.ts
   */
  updatePreferences?(updates: Record<string, unknown>): void;

  // ============================================================
  // Session Self-Management (for set_session_labels, etc.)
  // ============================================================

  /** Set labels on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionLabels?(sessionId: string | undefined, labels: string[]): void | Promise<void>;

  /** Set status on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionStatus?(sessionId: string | undefined, status: string): void | Promise<void>;

  /** Get detailed info about a session. Defaults to current session if no ID given. Injected by backend. */
  getSessionInfo?(sessionId?: string): SessionInfo | null;

  /** List sessions in the workspace with pagination. Injected by backend. */
  listSessions?(options?: ListSessionsOptions): ListSessionsResult;

  /**
   * List sessions in the workspace that have enabled, persisted messaging bindings.
   * Unlike listSessions + getMessagingBindings, this is backed by the
   * workspace messaging index so callers can filter by platform in one query.
   */
  listMessagingSessions?(options?: ListMessagingSessionsOptions): ListMessagingSessionsResult;

  /**
   * List background tasks (running + recently-terminal) for a session from the
   * main-process registry. Defaults to the current session if no ID given.
   * Injected by backend (SessionManager). Returns [] in backends that don't
   * track background tasks.
   */
  listBackgroundTasks?(sessionId?: string): BackgroundTaskInfo[];

  /** Resolve label display names to IDs against configured labels. Injected by backend. */
  resolveLabels?(labels: string[]): ResolvedLabelsResult;

  /** Resolve a status display name to its ID against configured statuses. Injected by backend. */
  resolveStatus?(status: string): ResolvedStatusResult;

  /**
   * Create a Craft Agents Task (board card + task.yaml + orchestrator session)
   * WITHOUT running it. Slug derivation, node synthesis, and spec validation
   * happen behind this callback where the task primitives live. Injected by
   * backend (SessionManager); undefined in backends that don't run alongside
   * it (e.g. the Codex MCP subprocess) — the handler degrades gracefully.
   */
  createTask?(input: CreateTaskInput): Promise<CreateTaskResult>;

  // ============================================================
  // Inter-Session Messaging
  // ============================================================

  /**
   * Send a message to another session. Injected by backend (SessionManager).
   * Resolves with how the message was received so the sender can give the model
   * a truthful ack (delivered immediately vs. queued behind a busy turn) instead
   * of an unconditional "message sent".
   */
  sendAgentMessage?(sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>): Promise<SendAgentMessageResult>;

  /** Send a local file to a messaging channel bound to this session. Injected by messaging gateway. */
  sendMessagingFile?(request: SendMessagingFileRequest): Promise<SendMessagingFileResult>;

  /**
   * Activate a source in the running session: add to enabledSourceSlugs,
   * build its MCP/API servers, apply to the agent.
   *
   * Only available in backends that run alongside SessionManager (Claude in-process, Pi subprocess).
   * Codex and other backends leave this undefined — callers should degrade gracefully (restart required).
   *
   * `availability` is always `'next-turn'` when activation succeeds: both Claude SDK
   * (frozen `mcpServers` at `query()` start) and Pi (subprocess reloads proxy tools
   * on the next `handlePrompt`) require the current turn to end before new tools
   * are callable. The backend handles this via the existing source_activated + auto_retry
   * machinery — the current turn is aborted and the renderer resends the user's
   * original message with a `[{slug} activated]` suffix.
   */
  activateSourceInSession?(sourceSlug: string): Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'next-turn';
  }>;

  // ============================================================
  // Messaging Gateway (for list/unbind messaging channels)
  // ============================================================

  /** Get messaging bindings for a session. Injected by backend when messaging is configured. */
  getMessagingBindings?(sessionId: string): Array<{
    platform: string;
    channelId: string;
    /** Telegram supergroup forum topic id; undefined for DMs / non-Telegram. */
    threadId?: number;
    channelName?: string;
    enabled: boolean;
  }>;

  /** Unbind messaging channels from a session. Returns count of removed bindings. */
  unbindMessagingChannel?(sessionId: string, platform?: string): number;

  // ============================================================
  // Session Paths (for transform_data / render_template)
  // ============================================================

  /**
   * Absolute path to the session directory.
   * Used by transform_data for resolving input files.
   */
  sessionPath?: string;

  /**
   * Absolute path to the session's data directory.
   * Used by transform_data and render_template for output files.
   */
  dataPath?: string;
}

/** Messaging platforms supported by the workspace gateway. */
export type MessagingPlatform = 'telegram' | 'weixin' | 'lark' | 'whatsapp';

/** @deprecated Use MessagingPlatform. Kept for send-file API compatibility. */
export type MessagingFilePlatform = MessagingPlatform;

/** Options for listing sessions with enabled, persisted messaging bindings. */
export interface ListMessagingSessionsOptions {
  /** Filter to one messaging platform. Omit to return all platforms. */
  platform?: MessagingPlatform;
  /** Case-insensitive substring match on session name, channel name, or channel id. */
  search?: string;
  /** Maximum unique sessions to return. Defaults to 20, max 100. */
  limit?: number;
  /** Number of matching sessions to skip. */
  offset?: number;
}

/** One enabled, persisted messaging binding attached to a session. */
export interface MessagingSessionBindingInfo {
  bindingId: string;
  platform: MessagingPlatform;
  channelId: string;
  /** Telegram forum topic id; undefined for DMs and non-Telegram platforms. */
  threadId?: number;
  channelName?: string;
  /** Unix-ms timestamp when the binding was created. */
  boundAt: number;
}

/** Compact session metadata plus the enabled bindings matched by the query. */
export interface MessagingSessionListItem {
  id: string;
  name: string;
  labels: string[];
  status: string;
  createdAt: number;
  updatedAt?: number;
  bindings: MessagingSessionBindingInfo[];
}

/** Paginated result from list_messaging_sessions. */
export interface ListMessagingSessionsResult {
  total: number;
  returned: number;
  sessions: MessagingSessionListItem[];
}

export interface SendMessagingFileRequest {
  path: string;
  name?: string;
  caption?: string;
  platform?: MessagingFilePlatform;
  channelId?: string;
  /** Telegram supergroup forum topic id. Required to disambiguate topic-bound bindings sharing one channelId. */
  threadId?: number;
}

export interface SendMessagingFileResult {
  platform: MessagingFilePlatform;
  channelId: string;
  messageId: string;
  fileName: string;
  threadId?: number;
}

// ============================================================
// Session Self-Management Types — Resolution
// ============================================================

/** Result of resolving label names/IDs against configured labels. */
export interface ResolvedLabelsResult {
  /** Resolved label IDs (ready to store) */
  resolved: string[];
  /** Labels that couldn't be matched to any configured label */
  unknown: string[];
  /** All valid label IDs (for error messages) */
  available: string[];
  /**
   * Optional per-input rejection reason, keyed by the original input string.
   * Populated by `resolveSessionLabels()` from `@craft-agent/shared/labels`.
   * Handlers use this to build clearer errors (e.g. "label X doesn't accept a value").
   */
  reasons?: Record<string, string>;
}

/** Result of resolving a status name/ID against configured statuses. */
export interface ResolvedStatusResult {
  /** Matched status ID, or null if unknown */
  resolved: string | null;
  /** All valid status IDs (for error messages) */
  available: string[];
  /**
   * Category of the matched status ('open' | 'closed'), when resolved. Lets the
   * status tool reject agent-driven *closed* transitions (the human owns closure)
   * while still allowing open ones like `needs-review`.
   */
  category?: 'open' | 'closed';
}

// ============================================================
// Session Self-Management Types
// ============================================================

/** Full metadata for a single session (returned by get_session_info). */
/** Input for create_task — structured fields, mapped onto a TaskSpec by the backend. */
export interface CreateTaskInput {
  /** Short task title shown on the board (also drives the slug). */
  title: string;
  /** What the task should accomplish — becomes the task goal and the initial node prompt. */
  description: string;
  /** Freeform rubric the final result is verified against. */
  acceptanceCriteria?: string;
  /** Source slugs enabled on the task's sessions. */
  sources?: string[];
  /** Skill slugs applied to dispatched task prompts. */
  skills?: string[];
  /** LLM connection slug serving `model`. */
  llmConnection?: string;
  /** Model id for the task's sessions (workspace default when omitted). */
  model?: string;
  /** Working directory for the task's sessions. */
  workingDirectory?: string;
  /** Project to bind the task to. Defaults to the invoking session's project. */
  projectId?: string;
}

/** Result of create_task. */
export interface CreateTaskResult {
  slug: string;
  orchestratorSessionId: string;
  taskLabelId?: string;
  /** Fail-soft problems (unknown source/skill slugs, label failure, …). */
  warnings: string[];
}

export interface SessionInfo {
  id: string;
  name: string;
  labels: string[];
  status: string;
  permissionMode: string;
  createdAt: number;
  updatedAt?: number;
  workingDirectory?: string;
  projectId?: string;
  employeeId?: string;
  employeeSlug?: string;
  employeeName?: string;
  llmConnection?: string;
  model?: string;
  isActive: boolean;
}

/** Compact session summary (returned by list_sessions). */
export interface SessionListItem {
  id: string;
  name: string;
  labels: string[];
  status: string;
  createdAt: number;
  projectId?: string;
  employeeId?: string;
  employeeSlug?: string;
  employeeName?: string;
}

/** Options for list_sessions filtering and pagination. */
export interface ListSessionsOptions {
  status?: string;
  label?: string;
  employeeId?: string;
  employeeSlug?: string;
  employeeName?: string;
  search?: string;
  sortBy?: 'recent' | 'name' | 'status' | 'employee';
  limit?: number;
  offset?: number;
}

/** Paginated result from list_sessions. */
export interface ListSessionsResult {
  total: number;
  returned: number;
  sessions: SessionListItem[];
}

/**
 * Result of delivering a cross-session message (send_agent_message).
 * Lets the sender report the truth instead of an unconditional "sent".
 */
export interface SendAgentMessageResult {
  /**
   * - `delivered`: the target was idle, so it will start processing the message now.
   * - `queued`: the target was mid-turn; the message is enqueued and will be
   *   processed after the current turn finishes.
   */
  delivery: 'delivered' | 'queued';
  /** Whether the target session was processing a turn when the message arrived. */
  targetBusy: boolean;
}

/**
 * A background task tracked by the main process (returned by
 * list_background_tasks). This is the cross-subprocess source of truth: the
 * SDK's in-subprocess task tools only see tasks launched in the CURRENT
 * subprocess, so they cannot report a task from a prior turn's (torn-down)
 * subprocess. `status: 'orphaned'` means the owning turn ended before a terminal
 * notification arrived — the task most likely died with its subprocess.
 */
export interface BackgroundTaskInfo {
  taskId: string;
  intent?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned';
  /** ms timestamp when the task was backgrounded */
  startTime: number;
  /** seconds elapsed since start (derived at query time) */
  elapsedSeconds: number;
  /** ms timestamp when the task reached a terminal/orphaned status, if any */
  completedAt?: number;
}

// ============================================================
// MCP Validation Types
// ============================================================

/**
 * Config for stdio MCP connection validation
 */
export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Config for HTTP/SSE MCP connection validation.
 * Derived from McpSourceConfig to stay in sync automatically (DRY).
 *
 * `accessToken` is the resolved OAuth / bearer token for sources whose
 * credential lives in the credential store (no `headerNames`). The probe
 * forwards it to the underlying impl, which builds an
 * `Authorization: Bearer …` header — matching the runtime path.
 */
export type HttpMcpConfig = Required<Pick<McpSourceConfig, 'url'>>
  & Pick<McpSourceConfig, 'authType' | 'headers' | 'headerNames' | 'transport'>
  & { accessToken?: string };

/**
 * Result from stdio MCP validation
 */
export interface StdioValidationResult {
  success: boolean;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from HTTP MCP validation
 */
export interface McpValidationResult {
  success: boolean;
  error?: string;
  needsAuth?: boolean;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from API source test
 */
export interface ApiTestResult {
  success: boolean;
  status?: number;
  error?: string;
  hint?: string;
}

// ============================================================
// Context Factory Helpers
// ============================================================

/**
 * Create a basic file system implementation using Node.js fs.
 */
export function createNodeFileSystem(): FileSystemInterface {
  // Dynamic import to work in both environments
  const fs = require('node:fs');

  return {
    exists: (path: string) => fs.existsSync(path),
    readFile: (path: string) => fs.readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => fs.readFileSync(path),
    writeFile: (path: string, content: string) => fs.writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => fs.existsSync(path) && fs.statSync(path).isDirectory(),
    readdir: (path: string) => fs.readdirSync(path),
    stat: (path: string) => {
      const stats = fs.statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };
}
