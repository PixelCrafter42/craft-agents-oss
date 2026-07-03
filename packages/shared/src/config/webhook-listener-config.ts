/** Desktop webhook listener configuration. */
export interface DesktopWebhookListenerConfig {
  /** Whether the desktop app should run the local HTTP listener. */
  enabled: boolean;
  /** Bind host. Defaults to loopback; users can expose it with Cloudflare Tunnel. */
  host: string;
  /** Local HTTP port. */
  port: number;
  /** Optional public HTTPS base URL used for copyable endpoints. */
  publicBaseUrl?: string;
  /** Last workspace selected in Settings -> Webhooks test tools. */
  lastWorkspaceId?: string;
  /** Last trigger id selected in Settings -> Webhooks test tools. */
  lastTriggerId?: string;
}

export interface DesktopWebhookListenerStatus {
  running: boolean;
  host: string;
  port: number;
  url: string;
  enabled: boolean;
  startedAt?: number;
  lastError?: string;
}

export interface DesktopWebhookDeliveryRecord {
  id: string;
  ts: number;
  method: string;
  path: string;
  workspaceId?: string;
  triggerId?: string;
  statusCode: number;
  ok: boolean;
  dryRun?: boolean;
  auth: 'none' | 'passed' | 'failed';
  matcherValue?: string;
  matchedCount?: number;
  verificationToken?: string;
  normalizedEvent?: unknown;
  error?: string;
}

export interface DesktopWebhookLocalTestResult {
  ok: boolean;
  endpoint: string;
  statusCode?: number;
  response?: unknown;
  error?: string;
}

export const DEFAULT_DESKTOP_WEBHOOK_LISTENER_CONFIG: DesktopWebhookListenerConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 9797,
};
