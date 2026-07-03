/**
 * Automation System Type Definitions
 *
 * All types, interfaces, and type exports for the automations system.
 */

import type { PermissionMode } from '../agent/mode-types.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { WebhookReceivedPayload } from './event-bus.ts';

// ============================================================================
// Event Types
// ============================================================================

/** App events - handled by Craft */
export type AppEvent =
  | 'LabelAdd'
  | 'LabelRemove'
  | 'LabelConfigChange'
  | 'PermissionModeChange'
  | 'FlagChange'
  | 'SessionStatusChange'
  | 'WebhookReceived'
  | 'SchedulerTick';

/** Agent events - passed to Claude SDK */
export type AgentEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Setup';

export type AutomationEvent = AppEvent | AgentEvent;

export const APP_EVENTS: AppEvent[] = [
  'LabelAdd', 'LabelRemove', 'LabelConfigChange',
  'PermissionModeChange', 'FlagChange', 'SessionStatusChange',
  'WebhookReceived', 'SchedulerTick'
];

export const AGENT_EVENTS: AgentEvent[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PermissionRequest', 'Setup'
];

// ============================================================================
// Action Definitions
// ============================================================================

/** A prompt action - sends a prompt to Craft Agent */
export interface PromptAction {
  type: 'prompt';
  prompt: string;
  /** LLM connection slug for the created session (falls back to default if not found) */
  llmConnection?: string;
  /** Model ID for the created session (falls back to provider default if invalid) */
  model?: string;
  /**
   * Thinking level for the created session.
   * When omitted, falls back to the workspace default (then DEFAULT_THINKING_LEVEL).
   */
  thinkingLevel?: ThinkingLevel;
}

/** HTTP method for webhook actions */
export type WebhookHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Body format for webhook actions */
export type WebhookBodyFormat = 'json' | 'form' | 'raw';

/** Authentication shorthand for webhook actions */
export type WebhookAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string };

/** A webhook action - sends an HTTP request to an endpoint */
export interface WebhookAction {
  type: 'webhook';
  /** The URL to send the webhook to (http or https) */
  url: string;
  /** HTTP method (default: POST) */
  method?: WebhookHttpMethod;
  /** HTTP headers as key-value pairs */
  headers?: Record<string, string>;
  /** Body format: 'json' sends Content-Type application/json, 'form' URL-encodes, 'raw' sends as-is */
  bodyFormat?: WebhookBodyFormat;
  /** Request body — JSON object when bodyFormat is 'json' or 'form', string when 'raw' */
  body?: unknown;
  /** Capture response body in result (truncated to 4KB). Default: false */
  captureResponse?: boolean;
  /** Authentication shorthand (applied before custom headers) */
  auth?: WebhookAuth;
}

export type AutomationAction = PromptAction | WebhookAction;

export type AutomationMessagingPlatform = 'telegram' | 'whatsapp' | 'weixin' | 'lark';
export type AutomationMessagingResponseMode = 'streaming' | 'progress' | 'final_only';

/**
 * Output-only messaging target for sessions spawned by an automation.
 *
 * When set, the created session's assistant output is rendered to the
 * configured messaging channel without changing the channel's normal inbound
 * session binding.
 */
export interface AutomationMessagingTarget {
  /** Existing messaging binding to copy platform/channel/config from. */
  bindingId?: string;
  /** Platform target. Required when bindingId is omitted. */
  platform?: AutomationMessagingPlatform;
  /** Platform-native channel id. When omitted, the latest enabled binding for the platform is used. */
  channelId?: string;
  /** Telegram forum-topic id. Ignored by non-Telegram platforms. */
  threadId?: number;
  /** Display name used in logs/settings when no bindingId is provided. */
  channelName?: string;
  /** Override how agent output is rendered. Defaults to final_only. */
  responseMode?: AutomationMessagingResponseMode;
}

// ============================================================================
// Condition Types
// ============================================================================

/** Time-of-day and day-of-week condition */
export interface TimeCondition {
  condition: 'time';
  /** Start time in 24h HH:MM format */
  after?: string;
  /** End time in 24h HH:MM format */
  before?: string;
  /** Days of week (3-letter lowercase: mon, tue, wed, thu, fri, sat, sun) */
  weekday?: string[];
  /** IANA timezone (falls back to matcher timezone, then system local) */
  timezone?: string;
}

/** State/field check condition with HA-style from/to for transitions */
export interface StateCondition {
  condition: 'state';
  /** Field name to check (e.g. 'permissionMode', 'sessionStatus', 'labels', 'isFlagged') */
  field: string;
  /** Exact value match */
  value?: unknown;
  /** Transition: previous value (mapped via TRANSITION_FIELDS) */
  from?: unknown;
  /** Transition: new value (mapped via TRANSITION_FIELDS) */
  to?: unknown;
  /** Array membership check */
  contains?: string;
  /** Negation: matches anything except this value */
  not_value?: unknown;
}

/** Logical composition condition (and/or/not) */
export interface LogicalCondition {
  condition: 'and' | 'or' | 'not';
  conditions: AutomationCondition[];
}

/** Union of all condition types */
export type AutomationCondition = TimeCondition | StateCondition | LogicalCondition;

// ============================================================================
// Matcher Definition
// ============================================================================

export interface AutomationMatcher {
  /** Short 6-character hex ID for stable identification across config changes. */
  id?: string;
  /** Optional display name. If omitted, derived from the first action. */
  name?: string;
  /** Regex pattern for matching event data (not used for SchedulerTick) */
  matcher?: string;
  /** Cron expression for SchedulerTick events (5-field format) */
  cron?: string;
  /** IANA timezone for cron evaluation (e.g., "Europe/Budapest", "America/New_York") */
  timezone?: string;
  /** Permission mode for sessions created by prompt actions. */
  permissionMode?: PermissionMode;
  /** Labels to apply to sessions created by prompt actions */
  labels?: string[];
  /** Whether this automation matcher is enabled. Defaults to true. Set to false to disable without removing. */
  enabled?: boolean;
  /** Optional conditions that must all pass (AND) after matcher matches, before actions fire */
  conditions?: AutomationCondition[];
  /**
   * Optional Telegram forum-topic name. When set, sessions spawned by this
   * matcher are bound to a forum topic of this name in the workspace's paired
   * supergroup. The topic is created on first use and reused thereafter.
   * Multiple matchers using the same value share one topic.
   *
   * Silently ignored when:
   *   - No supergroup is paired in Settings → Messaging → Telegram
   *   - The Telegram bot is not connected
   *   - The bot lacks "Manage Topics" permission in the supergroup
   */
  telegramTopic?: string;
  /**
   * Output-only messaging target for sessions spawned by this matcher.
   *
   * Unlike `telegramTopic`, this does not create or move bindings; it only
   * routes outbound automation output to an existing or explicit messaging
   * channel. Useful for Weixin/WhatsApp/Lark notifications.
   */
  messagingTarget?: AutomationMessagingTarget;
  actions: AutomationAction[];
}

// ============================================================================
// Webhook Trigger Definitions
// ============================================================================

/** Input location for normalizing external webhook payloads. */
export type WebhookMappingSource = 'body' | 'header' | 'query' | 'constant';

/** A mapping rule that extracts one normalized event field from an incoming request. */
export interface WebhookMappingRule {
  /** Location to read from. */
  from: WebhookMappingSource;
  /** Primary dot path/key to read. */
  path?: string;
  /** Fallback dot paths/keys, tried after `path`. */
  paths?: string[];
  /** Constant value used when `from` is `constant`. */
  value?: unknown;
  /** Fallback value when no path resolves. */
  default?: unknown;
}

/** Authentication mode for inbound webhook triggers. Secret values live in encrypted credentials. */
export type WebhookTriggerAuth =
  | { type: 'none' }
  | { type: 'bearer' }
  | { type: 'header'; headerName: string }
  | { type: 'query'; queryParam?: string }
  | { type: 'hmac'; headerName: string; algorithm?: 'sha1' | 'sha256' | 'sha512'; prefix?: string }
  | { type: 'notion-signature' };

/** Non-secret webhook trigger configuration stored in automations.json. */
export interface WebhookTriggerConfig {
  /** Whether this endpoint accepts requests. Defaults to true. */
  enabled?: boolean;
  /** Optional human-readable name. */
  name?: string;
  /** Provider/source namespace used for matcher value, e.g. "notion". */
  source?: string;
  /** Default normalized event type, e.g. "database.page.created". */
  eventType?: string;
  /** Non-secret auth configuration. */
  auth?: WebhookTriggerAuth;
  /** Field mapping from arbitrary webhook payloads to normalized event fields. */
  mapping?: Record<string, WebhookMappingRule>;
}

export interface AutomationsConfig {
  automations: Partial<Record<AutomationEvent, AutomationMatcher[]>>;
  /** External webhook trigger definitions keyed by triggerId. */
  webhookTriggers?: Record<string, WebhookTriggerConfig>;
}

export type AutomationWebhookReceiveMode = 'dry-run' | 'live';

export interface AutomationWebhookMatchedAutomation {
  id?: string;
  name: string;
}

export interface AutomationWebhookReceiveInput {
  workspaceId: string;
  triggerId: string;
  mode: AutomationWebhookReceiveMode;
  payload: WebhookReceivedPayload;
  /** Used by desktop Settings local tests so listener/pipeline checks do not require user config. */
  allowMissingTrigger?: boolean;
}

export interface AutomationWebhookReceiveResult {
  ok: boolean;
  mode: AutomationWebhookReceiveMode;
  emitted: boolean;
  matcherValue: string;
  matchedAutomations: AutomationWebhookMatchedAutomation[];
  normalizedEvent: WebhookReceivedPayload;
  error?: string;
}

// ============================================================================
// Action Results
// ============================================================================

/** References parsed from a prompt (@name for sources and skills) */
export interface PromptReferences {
  /**
   * All @name references found in the prompt.
   * These could be sources (@linear, @github) or skills (@commit, @review-pr).
   * The caller should resolve which are sources vs skills based on available configurations.
   */
  mentions: string[];
}

/** Result of a prompt action - returns the prompt to be executed by caller */
export interface PromptActionResult {
  type: 'prompt';
  prompt: string;
  /** The expanded prompt with environment variables substituted */
  expandedPrompt: string;
  /** References to sources and skills found in the prompt */
  references: PromptReferences;
}

/** Result of a webhook action */
export interface WebhookActionResult {
  type: 'webhook';
  /** The URL that was called */
  url: string;
  /** HTTP status code from the response */
  statusCode: number;
  /** Whether the request was successful (2xx status) */
  success: boolean;
  /** Error message if the request failed */
  error?: string;
  /** Number of attempts made (1 = no retry, 2+ = retried) */
  attempts?: number;
  /** Total duration including retries, in ms */
  durationMs?: number;
  /** Captured response body (only when captureResponse is true, truncated to 4KB) */
  responseBody?: string;
}

export type ActionExecutionResult = PromptActionResult | WebhookActionResult;

/** A pending prompt with its metadata */
export interface PendingPrompt {
  /** The session ID this prompt should be sent to */
  sessionId: string | undefined;
  /** The automation matcher ID this prompt originated from */
  matcherId?: string;
  /** Human-readable automation name (from matcher.name or derived fallback) */
  automationName?: string;
  /** The expanded prompt text */
  prompt: string;
  /**
   * All @mentions found in the prompt (sources and skills).
   * The caller should resolve which are sources vs skills based on available configurations.
   */
  mentions: string[];
  /** Labels to apply to the created session */
  labels?: string[];
  /** Permission mode for the created session (from matcher config) */
  permissionMode?: PermissionMode;
  /** LLM connection slug for the created session (falls back to default if not found) */
  llmConnection?: string;
  /** Model ID for the created session (falls back to provider default if invalid) */
  model?: string;
  /** Thinking level for the created session (falls back to workspace default when omitted) */
  thinkingLevel?: ThinkingLevel;
  /** Forum-topic name to bind the new session to (Telegram supergroup, when paired). */
  telegramTopic?: string;
  /** Output-only messaging target for the created session. */
  messagingTarget?: AutomationMessagingTarget;
}

export interface AutomationResult {
  event: string;
  matched: number;
  results: ActionExecutionResult[];
  /** Prompts that should be executed by Craft Agent (with metadata) */
  pendingPrompts: PendingPrompt[];
}

// ============================================================================
// Validation Types
// ============================================================================

/** Internal validation result that includes the parsed config */
export type AutomationsValidationResult = {
  valid: boolean;
  errors: string[];
  config: AutomationsConfig | null;
};

// ============================================================================
// SDK Types
// ============================================================================

/**
 * SDK automation input type - union of all possible SDK event inputs
 */
export interface SdkAutomationInput {
  hook_event_name: string;
  // Tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  tool_use_id?: string;
  // Session events
  source?: string;  // startup, resume, clear, compact
  model?: string;
  // Subagent events
  agent_id?: string;
  agent_type?: string;
  // User prompt events
  prompt?: string;
  // Notification events
  message?: string;
  title?: string;
  // Error events
  error?: string;
}

/**
 * SDK automation callback signature (matches Claude SDK HookCallback type)
 */
export type SdkAutomationCallback = (
  input: SdkAutomationInput,
  toolUseId: string,
  options: { signal?: AbortSignal }
) => Promise<{ continue: boolean; reason?: string }>;

/**
 * SDK automation matcher format (matches Claude SDK HookCallbackMatcher type)
 * Note: The `hooks` field name is kept as-is to match the Claude SDK interface.
 */
export interface SdkAutomationCallbackMatcher {
  matcher?: string;
  timeout?: number;
  hooks: SdkAutomationCallback[];
}

// ============================================================================
// Session Metadata
// ============================================================================

/**
 * Lightweight session metadata for diffing.
 * Only includes fields that trigger automations.
 */
export interface SessionMetadataSnapshot {
  permissionMode?: string;
  labels?: string[];
  isFlagged?: boolean;
  sessionStatus?: string;
  /** Session name (user-defined or auto-generated) */
  sessionName?: string;
}
