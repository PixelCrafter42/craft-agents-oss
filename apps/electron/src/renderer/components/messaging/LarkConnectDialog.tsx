/** Lark / Feishu one-click app registration with a manual credential fallback. */

import * as React from 'react'
import { Check, ExternalLink, RefreshCw, Settings2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import { SettingsSecretInput } from '@/components/settings'

interface LarkConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  reconfigure?: boolean
  initialDomain?: LarkDomain
  onSaved?: () => void
}

type LarkDomain = 'lark' | 'feishu'
type RegistrationState =
  | { state: 'idle' | 'starting' }
  | { state: 'ready'; attemptId: string; url: string; expiresAt: number; phase: string }
  | { state: 'connected'; identity?: string }
  | { state: 'expired' | 'error'; error?: string }

type TestResult =
  | { state: 'idle' | 'testing' | 'success' }
  | { state: 'error'; error: string }

export function LarkConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  initialDomain = 'lark',
  onSaved,
}: LarkConnectDialogProps) {
  const { t } = useTranslation()
  const [advanced, setAdvanced] = React.useState(false)
  const [registration, setRegistration] = React.useState<RegistrationState>({ state: 'idle' })
  const [appId, setAppId] = React.useState('')
  const [appSecret, setAppSecret] = React.useState('')
  const [domain, setDomain] = React.useState<LarkDomain>(initialDomain)
  const [saving, setSaving] = React.useState(false)
  const [test, setTest] = React.useState<TestResult>({ state: 'idle' })
  const completedRef = React.useRef(false)
  const activeAttemptId = registration.state === 'ready' ? registration.attemptId : undefined

  const startRegistration = React.useCallback(async () => {
    setRegistration({ state: 'starting' })
    try {
      const result = await window.electronAPI.beginLarkRegistration({
        region: domain,
        repairExisting: reconfigure,
      })
      setRegistration({
        state: 'ready',
        attemptId: result.attemptId,
        url: result.verificationUrl,
        expiresAt: result.expiresAt,
        phase: 'waiting',
      })
    } catch (error) {
      setRegistration({
        state: 'error',
        error: error instanceof Error ? error.message : t('settings.messaging.lark.authError'),
      })
    }
  }, [domain, reconfigure, t])

  React.useEffect(() => {
    if (!open) {
      setAdvanced(false)
      setRegistration({ state: 'idle' })
      setAppId('')
      setAppSecret('')
      setDomain(initialDomain)
      setSaving(false)
      setTest({ state: 'idle' })
      completedRef.current = false
      return
    }
    if (!advanced) void startRegistration()
  }, [advanced, initialDomain, open, startRegistration])

  React.useEffect(() => {
    if (!open || !activeAttemptId) return
    const attemptId = activeAttemptId
    const timer = window.setInterval(async () => {
      try {
        const status = await window.electronAPI.getLarkRegistrationStatus(attemptId)
        if (status.state === 'connected') {
          window.clearInterval(timer)
          setRegistration({ state: 'connected', identity: status.identity })
          if (!completedRef.current) {
            completedRef.current = true
            toast.success(t('settings.messaging.lark.authSuccess'))
            onSaved?.()
          }
        } else if (status.state === 'expired') {
          window.clearInterval(timer)
          setRegistration({ state: 'expired', error: status.error })
        } else if (status.state === 'error' || status.state === 'cancelled') {
          window.clearInterval(timer)
          setRegistration({ state: 'error', error: status.error })
        } else {
          setRegistration((current) =>
            current.state === 'ready' ? { ...current, phase: status.state } : current,
          )
        }
      } catch (error) {
        window.clearInterval(timer)
        setRegistration({
          state: 'error',
          error: error instanceof Error ? error.message : t('settings.messaging.lark.authError'),
        })
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [activeAttemptId, open, onSaved, t])

  const cancelRegistration = React.useCallback(() => {
    if (registration.state === 'ready') {
      void window.electronAPI.cancelLarkRegistration(registration.attemptId).catch(() => {})
    }
  }, [registration])

  const handleOpenChange = (next: boolean) => {
    if (!next) cancelRegistration()
    onOpenChange(next)
  }

  const handleAdvanced = () => {
    if (!advanced) cancelRegistration()
    setAdvanced((value) => !value)
  }

  const ready = appId.trim().length > 0 && appSecret.trim().length > 0

  const handleTest = async () => {
    if (!ready) return
    setTest({ state: 'testing' })
    try {
      const result = await window.electronAPI.testLarkCredentials({
        appId: appId.trim(), appSecret: appSecret.trim(), domain,
      })
      setTest(result.success
        ? { state: 'success' }
        : { state: 'error', error: result.error ?? t('common.error') })
    } catch (error) {
      setTest({ state: 'error', error: error instanceof Error ? error.message : t('common.error') })
    }
  }

  const handleSave = async () => {
    if (!ready) return
    setSaving(true)
    try {
      await window.electronAPI.saveLarkCredentials({
        appId: appId.trim(), appSecret: appSecret.trim(), domain,
      })
      toast.success(t('settings.messaging.lark.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.messaging.lark.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const phaseLabel = registration.state === 'ready' && registration.phase === 'saving'
    ? t('settings.messaging.lark.authSaving')
    : t('settings.messaging.lark.authScanning')

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.lark.reconfigureTitle')
              : t('settings.messaging.lark.connectTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.messaging.lark.authDescription')}</DialogDescription>
        </DialogHeader>

        {!advanced ? (
          <div className="flex min-h-[300px] flex-col items-center justify-center gap-4 py-2">
            <div className="flex gap-2">
              <Button
                variant={domain === 'lark' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDomain('lark')}
              >
                {t('settings.messaging.lark.domainLark')}
              </Button>
              <Button
                variant={domain === 'feishu' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDomain('feishu')}
              >
                {t('settings.messaging.lark.domainFeishu')}
              </Button>
            </div>
            {(registration.state === 'idle' || registration.state === 'starting') && (
              <><Spinner className="text-[28px]" /><p className="text-sm text-muted-foreground">{t('common.loading')}</p></>
            )}
            {registration.state === 'ready' && (
              <>
                <div className="rounded-xl bg-white p-3 shadow-minimal">
                  <QRCodeSVG value={registration.url} size={220} level="M" />
                </div>
                <p className="text-center text-sm text-muted-foreground">{phaseLabel}</p>
                <Button variant="outline" size="sm" onClick={() => window.electronAPI.openUrl(registration.url)}>
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                  {t('settings.messaging.lark.authOpen')}
                </Button>
              </>
            )}
            {registration.state === 'connected' && (
              <div className="flex flex-col items-center gap-3 text-center">
                <Check className="h-12 w-12 text-emerald-500" />
                <p className="font-medium">{t('settings.messaging.lark.authSuccess')}</p>
                {registration.identity && <p className="text-sm text-muted-foreground">{registration.identity}</p>}
              </div>
            )}
            {(registration.state === 'error' || registration.state === 'expired') && (
              <div className="flex flex-col items-center gap-3 text-center">
                <X className="h-10 w-10 text-destructive" />
                <p className="text-sm text-muted-foreground">
                  {registration.state === 'expired'
                    ? t('settings.messaging.lark.authExpired')
                    : registration.error ?? t('settings.messaging.lark.authError')}
                </p>
                <Button variant="outline" size="sm" onClick={() => void startRegistration()}>
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                  {t('settings.messaging.lark.authRetry')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="whitespace-pre-line text-xs text-muted-foreground">{t('settings.messaging.lark.instructions')}</p>
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">{t('settings.messaging.lark.domainLabel')}</div>
              <div className="flex gap-2">
                <Button variant={domain === 'lark' ? 'default' : 'outline'} size="sm" onClick={() => setDomain('lark')} disabled={saving}>
                  {t('settings.messaging.lark.domainLark')}
                </Button>
                <Button variant={domain === 'feishu' ? 'default' : 'outline'} size="sm" onClick={() => setDomain('feishu')} disabled={saving}>
                  {t('settings.messaging.lark.domainFeishu')}
                </Button>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">{t('settings.messaging.lark.appIdLabel')}</div>
              <SettingsSecretInput value={appId} onChange={setAppId} placeholder={t('settings.messaging.lark.appIdPlaceholder')} disabled={saving} />
            </div>
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">{t('settings.messaging.lark.appSecretLabel')}</div>
              <SettingsSecretInput value={appSecret} onChange={setAppSecret} placeholder={t('settings.messaging.lark.appSecretPlaceholder')} disabled={saving} />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleTest} disabled={!ready || test.state === 'testing' || saving}>
                {test.state === 'testing' && <Spinner className="mr-1 text-[14px]" />}
                {t('settings.messaging.lark.testConnection')}
              </Button>
              {test.state === 'success' && <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><Check className="h-3.5 w-3.5" />{t('settings.messaging.lark.testOk')}</span>}
              {test.state === 'error' && <span className="inline-flex items-center gap-1 text-xs text-destructive"><X className="h-3.5 w-3.5" />{test.error}</span>}
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={handleAdvanced} disabled={saving}>
            <Settings2 className="mr-1.5 h-4 w-4" />
            {advanced ? t('settings.messaging.lark.authCreate') : t('settings.messaging.lark.advancedSetup')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} disabled={saving}>
              {registration.state === 'connected' ? t('common.close') : t('common.cancel')}
            </Button>
            {advanced && (
              <Button size="sm" onClick={handleSave} disabled={!ready || test.state !== 'success' || saving}>
                {saving && <Spinner className="mr-1 text-[14px]" />}
                {t('settings.messaging.lark.save')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
