/**
 * WeixinConnectDialog — drives the weixin-agent-sdk QR login flow from the UI.
 */

import * as React from 'react'
import { Check, KeyRound } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@craft-agent/ui'
import { useActiveWorkspace } from '@/context/AppShellContext'
import type { WeixinUiEvent } from '../../../shared/types'

interface WeixinConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'show_qr'; qr: string }
  | { kind: 'verify_code'; retry?: boolean; message?: string }
  | { kind: 'connected'; name?: string }
  | { kind: 'error'; message: string }

export function WeixinConnectDialog({ open, onOpenChange, onConnected }: WeixinConnectDialogProps) {
  const { t } = useTranslation()
  const activeWorkspace = useActiveWorkspace()
  const activeWorkspaceId = activeWorkspace?.id
  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' })
  const [verifyCode, setVerifyCode] = React.useState('')
  const [submittingVerifyCode, setSubmittingVerifyCode] = React.useState(false)
  const [verifyCodeError, setVerifyCodeError] = React.useState<string | null>(null)
  const [recovering, setRecovering] = React.useState(false)

  React.useEffect(() => {
    if (!open || !activeWorkspaceId) return
    const off = window.electronAPI.onWeixinEvent(({ workspaceId, event }) => {
      if (workspaceId !== activeWorkspaceId) return
      handleEvent(event)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeWorkspaceId])

  React.useEffect(() => {
    if (!open || phase.kind !== 'idle') return
    setPhase({ kind: 'starting' })
    window.electronAPI
      .startWeixinConnect()
      .catch((err) => setPhase({ kind: 'error', message: errorMsg(err) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  React.useEffect(() => {
    if (!open) {
      setPhase({ kind: 'idle' })
      setRecovering(false)
    }
  }, [open])

  const resetVerifyState = React.useCallback(() => {
    setVerifyCode('')
    setVerifyCodeError(null)
    setSubmittingVerifyCode(false)
  }, [])

  // Shared restart path. `forget` first drops the persisted weixin session so
  // the next connect starts from a clean QR scan instead of resuming.
  const beginConnect = React.useCallback(
    async (forget: boolean) => {
      setRecovering(true)
      resetVerifyState()
      setPhase({ kind: 'starting' })
      try {
        if (forget) await window.electronAPI.forgetMessagingPlatform('weixin')
        await window.electronAPI.startWeixinConnect()
      } catch (err) {
        setPhase({ kind: 'error', message: errorMsg(err) })
      } finally {
        setRecovering(false)
      }
    },
    [resetVerifyState],
  )

  const restartConnect = React.useCallback(() => beginConnect(false), [beginConnect])
  const resetAndRestartConnect = React.useCallback(() => beginConnect(true), [beginConnect])

  const handleEvent = (event: WeixinUiEvent) => {
    switch (event.type) {
      case 'qr':
        setVerifyCode('')
        setVerifyCodeError(null)
        setPhase({ kind: 'show_qr', qr: event.qr })
        return
      case 'verify_code_required':
        resetVerifyState()
        setPhase({
          kind: 'verify_code',
          retry: event.retry,
          message: event.message,
        })
        return
      case 'connected':
        setPhase({ kind: 'connected', name: event.name ?? event.userId ?? event.accountId })
        setTimeout(() => {
          if (onConnected) {
            onConnected()
          } else {
            onOpenChange(false)
          }
        }, 1200)
        return
      case 'disconnected':
        if (event.reason) setPhase({ kind: 'error', message: event.reason })
        return
      case 'unavailable':
        setPhase({ kind: 'error', message: event.message })
        return
      case 'error':
        setPhase({ kind: 'error', message: event.message })
        return
    }
  }

  const submitVerifyCode = async (event: React.FormEvent) => {
    event.preventDefault()
    const code = verifyCode.trim()
    if (!code) {
      setVerifyCodeError(t('dialog.weixin.verifyCodeEmpty'))
      return
    }
    setSubmittingVerifyCode(true)
    setVerifyCodeError(null)
    try {
      await window.electronAPI.submitWeixinVerifyCode(code)
      setPhase({ kind: 'starting' })
    } catch (err) {
      setVerifyCodeError(errorMsg(err))
      setSubmittingVerifyCode(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('dialog.weixin.title')}</DialogTitle>
          <DialogDescription>{t('dialog.weixin.description')}</DialogDescription>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          {t('dialog.weixin.selfChatHint')}
        </p>

        <div className="flex flex-col gap-4 py-2">
          {phase.kind === 'starting' && (
            <StatusRow icon={<Spinner className="text-[16px]" />}>
              {t('dialog.weixin.starting')}
            </StatusRow>
          )}

          {phase.kind === 'show_qr' && (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg bg-white p-4">
                <QRCodeSVG value={phase.qr} size={240} level="M" />
              </div>
              <p className="whitespace-pre-line text-center text-sm text-muted-foreground">
                {t('dialog.weixin.qrInstructions')}
              </p>
            </div>
          )}

          {phase.kind === 'verify_code' && (
            <form className="flex flex-col gap-3" onSubmit={submitVerifyCode}>
              <StatusRow icon={<KeyRound className="h-4 w-4 text-amber-500" />}>
                {phase.retry
                  ? t('dialog.weixin.verifyCodeRetry')
                  : t('dialog.weixin.verifyCodeTitle')}
              </StatusRow>
              <p className="text-sm text-muted-foreground">
                {t('dialog.weixin.verifyCodeInstructions')}
              </p>
              <div className="flex gap-2">
                <Input
                  value={verifyCode}
                  onChange={(event) => setVerifyCode(event.target.value)}
                  placeholder={t('dialog.weixin.verifyCodePlaceholder')}
                  inputMode="numeric"
                  autoFocus
                  disabled={submittingVerifyCode}
                />
                <Button type="submit" disabled={submittingVerifyCode}>
                  {submittingVerifyCode ? t('dialog.weixin.verifyCodeSubmitting') : t('dialog.weixin.verifyCodeSubmit')}
                </Button>
              </div>
              {verifyCodeError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                  {verifyCodeError}
                </div>
              )}
            </form>
          )}

          {phase.kind === 'connected' && (
            <StatusRow icon={<Check className="h-4 w-4 text-emerald-500" />}>
              {phase.name
                ? t('dialog.weixin.connectedAs', { name: phase.name })
                : t('dialog.weixin.connected')}
            </StatusRow>
          )}

          {phase.kind === 'error' && (
            <div className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3">
              <div className="text-sm text-destructive">
                {phase.message}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void restartConnect()}
                  disabled={recovering}
                >
                  {recovering ? t('dialog.weixin.recovering') : t('dialog.weixin.tryAgain')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => void resetAndRestartConnect()}
                  disabled={recovering}
                >
                  {t('dialog.weixin.resetConnection')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StatusRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {icon}
      <span>{children}</span>
    </div>
  )
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
