import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, Copy, Send, Webhook } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type {
  DesktopWebhookDeliveryRecord,
  DesktopWebhookListenerConfig,
  DesktopWebhookListenerStatus,
  DesktopWebhookLocalTestResult,
} from '@craft-agent/shared/config'
import type { Workspace } from '@craft-agent/core/types'
import {
  SettingsCard,
  SettingsCardFooter,
  SettingsInputRow,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'webhooks',
}

interface WebhookFormState {
  enabled: boolean
  host: string
  port: string
  publicBaseUrl: string
  workspaceId: string
  triggerId: string
}

function isNotionEnrollmentPending(result: DesktopWebhookLocalTestResult | null): boolean {
  if (!result?.response || typeof result.response !== 'object') return false
  return (result.response as { enrollmentPending?: unknown }).enrollmentPending === true
}

function webhookConfigToForm(config: DesktopWebhookListenerConfig, workspaceId = ''): WebhookFormState {
  return {
    enabled: config.enabled,
    host: config.host,
    port: String(config.port),
    publicBaseUrl: config.publicBaseUrl ?? '',
    workspaceId: config.lastWorkspaceId || workspaceId,
    triggerId: config.lastTriggerId || 'test-trigger',
  }
}

function webhookFormToConfig(form: WebhookFormState): DesktopWebhookListenerConfig {
  return {
    enabled: form.enabled,
    host: form.host.trim() || '127.0.0.1',
    port: parseInt(form.port, 10) || 9797,
    publicBaseUrl: form.publicBaseUrl.trim() || undefined,
    lastWorkspaceId: form.workspaceId.trim() || undefined,
    lastTriggerId: form.triggerId.trim() || undefined,
  }
}

export default function WebhooksSettingsPage() {
  const [form, setForm] = useState<WebhookFormState>({
    enabled: false,
    host: '127.0.0.1',
    port: '9797',
    publicBaseUrl: '',
    workspaceId: '',
    triggerId: 'test-trigger',
  })
  const [savedForm, setSavedForm] = useState<WebhookFormState>(form)
  const [status, setStatus] = useState<DesktopWebhookListenerStatus | null>(null)
  const [health, setHealth] = useState<unknown>(null)
  const [testResult, setTestResult] = useState<DesktopWebhookLocalTestResult | null>(null)
  const [deliveries, setDeliveries] = useState<DesktopWebhookDeliveryRecord[]>([])
  const [secret, setSecret] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [error, setError] = useState<string>()

  const configDirty = JSON.stringify({
    enabled: form.enabled,
    host: form.host,
    port: form.port,
    publicBaseUrl: form.publicBaseUrl,
    workspaceId: form.workspaceId,
    triggerId: form.triggerId,
  }) !== JSON.stringify({
    enabled: savedForm.enabled,
    host: savedForm.host,
    port: savedForm.port,
    publicBaseUrl: savedForm.publicBaseUrl,
    workspaceId: savedForm.workspaceId,
    triggerId: savedForm.triggerId,
  })

  const loadSettings = useCallback(async () => {
    try {
      const [config, listenerStatus, workspaceList, deliveryList] = await Promise.all([
        window.electronAPI.getDesktopWebhookListenerConfig(),
        window.electronAPI.getDesktopWebhookListenerStatus(),
        window.electronAPI.getWorkspaces(),
        window.electronAPI.getDesktopWebhookDeliveries(),
      ])
      const defaultWorkspaceId = workspaceList[0]?.id ?? ''
      const formState = webhookConfigToForm(config, defaultWorkspaceId)
      if (formState.workspaceId && !workspaceList.some((workspace) => workspace.id === formState.workspaceId)) {
        formState.workspaceId = defaultWorkspaceId
      }
      setForm(formState)
      setSavedForm(formState)
      setStatus(listenerStatus)
      setWorkspaces(workspaceList)
      setDeliveries(deliveryList)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  useEffect(() => {
    const workspaceId = form.workspaceId.trim()
    const triggerId = form.triggerId.trim()
    setTestResult(null)
    if (!workspaceId || !triggerId) {
      setSecret(null)
      return
    }

    let cancelled = false
    window.electronAPI.getDesktopWebhookTriggerSecret(workspaceId, triggerId)
      .then((value) => {
        if (!cancelled) setSecret(value)
      })
      .catch(() => {
        if (!cancelled) setSecret(null)
      })
    return () => {
      cancelled = true
    }
  }, [form.workspaceId, form.triggerId])

  const refreshStatus = async () => {
    const [listenerStatus, deliveryList] = await Promise.all([
      window.electronAPI.getDesktopWebhookListenerStatus(),
      window.electronAPI.getDesktopWebhookDeliveries(form.workspaceId || undefined, form.triggerId || undefined),
    ])
    setStatus(listenerStatus)
    setDeliveries(deliveryList)
  }

  const save = async () => {
    setError(undefined)
    const port = parseInt(form.port, 10)
    if (isNaN(port) || port < 1024 || port > 65535) {
      setError('Port must be between 1024 and 65535')
      return
    }

    setIsSaving(true)
    try {
      await window.electronAPI.setDesktopWebhookListenerConfig(webhookFormToConfig(form))
      const savedConfig = await window.electronAPI.getDesktopWebhookListenerConfig()
      const saved = {
        ...webhookConfigToForm(savedConfig, form.workspaceId),
        triggerId: form.triggerId,
      }
      setForm(saved)
      setSavedForm(saved)
      await refreshStatus()
      toast.success('Webhook listener settings saved')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(message)
    } finally {
      setIsSaving(false)
    }
  }

  const reset = () => {
    setForm(savedForm)
    setError(undefined)
  }

  const check = async () => {
    setError(undefined)
    setIsTesting(true)
    try {
      const result = await window.electronAPI.checkDesktopWebhookListener()
      setHealth(result)
      await refreshStatus()
      if (result.ok) toast.success('Local listener is reachable')
      else toast.error(result.error ?? 'Local listener check failed')
    } finally {
      setIsTesting(false)
    }
  }

  const sendTest = async () => {
    setError(undefined)
    const workspaceId = form.workspaceId.trim()
    const triggerId = form.triggerId.trim()
    if (!workspaceId || !triggerId) {
      setError('Workspace and trigger id are required')
      return
    }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.sendDesktopWebhookLocalTest(workspaceId, triggerId)
      setTestResult(result)
      setSecret(await window.electronAPI.getDesktopWebhookTriggerSecret(workspaceId, triggerId))
      await refreshStatus()
      if (isNotionEnrollmentPending(result)) {
        toast.success('Notion verification armed for 10 minutes. Copy the one-time endpoint into Notion.')
      } else if (result.ok) toast.success('Dry-run webhook test received')
      else toast.error(result.error ?? 'Dry-run webhook test failed')
    } finally {
      setIsTesting(false)
    }
  }

  const rotateSecret = async () => {
    setError(undefined)
    const workspaceId = form.workspaceId.trim()
    const triggerId = form.triggerId.trim()
    if (!workspaceId || !triggerId) {
      setError('Workspace and trigger id are required')
      return
    }
    setSecret(await window.electronAPI.rotateDesktopWebhookTriggerSecret(workspaceId, triggerId))
    toast.success('Webhook secret rotated')
  }

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    )
  }

  const host = form.host.trim() || '127.0.0.1'
  const port = form.port.trim() || '9797'
  const localBaseUrl = `http://${host}:${port}`
  const publicBaseUrl = (form.publicBaseUrl.trim() || localBaseUrl).replace(/\/+$/, '')
  const endpoint = `${publicBaseUrl}/webhooks/${encodeURIComponent(form.workspaceId.trim() || '<workspaceId>')}/${encodeURIComponent(form.triggerId.trim() || '<triggerId>')}`
  const enrollmentPending = isNotionEnrollmentPending(testResult)
  const displayedEndpoint = enrollmentPending ? testResult!.endpoint : endpoint
  const curl = [
    `curl -X POST "${endpoint}?dryRun=1&test=1"`,
    '-H "Content-Type: application/json"',
    `-H "Authorization: Bearer ${secret ?? '<rotate-secret-first>'}"`,
    `-d '{"source":"generic","eventType":"test.event","title":"Local webhook test"}'`,
  ].join(' \\\n  ')

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title="Webhooks" />
      <ScrollArea className="flex-1">
        <div className="px-5 py-7 max-w-3xl mx-auto space-y-5">
          <SettingsSection title="Listener">
            <SettingsCard>
              <SettingsToggle
                label="Local webhook listener"
                description="Accept inbound HTTP webhooks on this desktop app."
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm(f => ({ ...f, enabled }))}
              />
              <SettingsInputRow label="Host" value={form.host} onChange={(host) => setForm(f => ({ ...f, host }))} placeholder="127.0.0.1" />
              <SettingsInputRow label="Port" value={form.port} onChange={(nextPort) => setForm(f => ({ ...f, port: nextPort }))} placeholder="9797" />
              <SettingsInputRow
                label="Public base URL"
                description="Use your Cloudflare Tunnel HTTPS origin here."
                value={form.publicBaseUrl}
                onChange={(publicBaseUrl) => setForm(f => ({ ...f, publicBaseUrl }))}
                placeholder="https://example.trycloudflare.com"
                type="url"
              />
              <SettingsRow label="Status">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`size-2 rounded-full ${status?.running ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                  <span className="text-xs text-muted-foreground truncate">
                    {status?.running ? status.url : 'Stopped'}
                  </span>
                </div>
              </SettingsRow>
            </SettingsCard>

            {status?.lastError && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{status.lastError}</span>
              </div>
            )}

            {error && <p className="text-xs text-destructive px-1">{error}</p>}

            {configDirty && (
              <SettingsCardFooter>
                <Button variant="outline" size="sm" onClick={reset} disabled={isSaving}>Reset</Button>
                <Button size="sm" onClick={save} disabled={isSaving}>
                  {isSaving ? <Spinner className="mr-1.5" /> : null}
                  Save
                </Button>
              </SettingsCardFooter>
            )}
          </SettingsSection>

          <SettingsSection title="Test">
            <SettingsCard>
              <SettingsRow label="Workspace" description="Incoming URL path uses the workspace id.">
                <select
                  value={form.workspaceId}
                  onChange={(event) => setForm(f => ({ ...f, workspaceId: event.target.value }))}
                  className="h-8 w-[200px] rounded-md bg-muted/50 px-2 text-xs outline-none"
                >
                  {workspaces.length === 0 ? (
                    <option value="">No workspace</option>
                  ) : workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                  ))}
                </select>
              </SettingsRow>
              <SettingsInputRow label="Trigger id" value={form.triggerId} onChange={(triggerId) => setForm(f => ({ ...f, triggerId }))} placeholder="notion-page-created" />
              <SettingsRow label="Endpoint">
                <div className="flex items-center gap-1.5 min-w-0 max-w-[360px]">
                  <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded truncate">{displayedEndpoint}</code>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => copy(displayedEndpoint, enrollmentPending ? 'One-time Notion endpoint' : 'Endpoint')}>
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </SettingsRow>
              <SettingsRow label="Secret">
                <div className="flex items-center gap-1.5">
                  <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded max-w-[160px] truncate">
                    {secret ? '••••••••••••••••' : 'Not configured'}
                  </code>
                  {secret && (
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => copy(secret, 'Webhook secret')}>
                      <Copy className="h-3 w-3" />
                    </Button>
                  )}
                  <Button variant="outline" size="sm" className="h-6 text-[11px] px-2" onClick={rotateSecret}>Rotate</Button>
                </div>
              </SettingsRow>
              <SettingsRow label="curl">
                <div className="flex items-center gap-1.5 min-w-0 max-w-[360px]">
                  <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded truncate">{curl.replace(/\s+/g, ' ')}</code>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => copy(curl, 'curl')}>
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </SettingsRow>
            </SettingsCard>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={check} disabled={isTesting}>
                <Activity className="h-3.5 w-3.5 mr-1.5" />
                Check local listener
              </Button>
              <Button size="sm" onClick={sendTest} disabled={isTesting || !form.workspaceId || !form.triggerId}>
                <Send className="h-3.5 w-3.5 mr-1.5" />
                Send local test
              </Button>
            </div>

            {(health || testResult) && (
              <div className="rounded-lg border bg-muted/35 p-3">
                <div className="flex items-center gap-2 text-xs font-medium mb-2">
                  <Webhook className="h-3.5 w-3.5" />
                  Test result
                </div>
                <pre className="text-[11px] leading-4 overflow-auto max-h-64 whitespace-pre-wrap break-words text-muted-foreground">
                  {JSON.stringify(testResult ?? health, null, 2)}
                </pre>
              </div>
            )}

            {deliveries.length > 0 && (
              <div className="rounded-lg border bg-muted/20">
                <div className="px-3 py-2 text-xs font-medium border-b">Recent deliveries</div>
                <div className="divide-y">
                  {deliveries.slice(0, 5).map((delivery) => (
                    <div key={delivery.id} className="px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-mono truncate">{delivery.matcherValue ?? delivery.path}</div>
                          <div className="text-muted-foreground">
                            {new Date(delivery.ts).toLocaleTimeString()} · {delivery.dryRun ? 'dry-run' : 'live'} · {delivery.matchedCount ?? 0} matched
                          </div>
                        </div>
                        <span className={delivery.ok ? 'text-green-600' : 'text-destructive'}>{delivery.statusCode}</span>
                      </div>
                      {delivery.verificationToken && (
                        <div className="mt-2 flex items-center gap-1.5">
                          <span className="text-muted-foreground">Verification token</span>
                          <code className="font-mono bg-muted px-1.5 py-0.5 rounded truncate max-w-[260px]">
                            {delivery.verificationToken}
                          </code>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => copy(delivery.verificationToken!, 'Verification token')}>
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                      {delivery.normalizedEvent !== undefined && delivery.normalizedEvent !== null && (
                        <pre className="mt-2 text-[11px] leading-4 overflow-auto max-h-40 whitespace-pre-wrap break-words text-muted-foreground bg-background/60 rounded p-2">
                          {JSON.stringify(delivery.normalizedEvent, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  )
}
