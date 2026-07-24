import { useTranslation } from 'react-i18next'
import { calculateContextUsagePercent } from '@craft-agent/core/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { formatTokenCount } from './model-picker-helpers'

interface ContextUsageRingProps {
  usedTokens?: number
  contextWindow?: number
  isCompacting?: boolean
  isProcessing?: boolean
  onCompact?: () => void
}

/**
 * Compact, always-visible context meter for the chat input toolbar.
 *
 * The percentage is deliberately based on the model's full context window.
 * Auto-compaction thresholds are provider settings and must not redefine what
 * "context used" means in the UI.
 */
export function ContextUsageRing({
  usedTokens,
  contextWindow,
  isCompacting = false,
  isProcessing = false,
  onCompact,
}: ContextUsageRingProps) {
  const { t } = useTranslation()
  const percent = calculateContextUsagePercent(usedTokens, contextWindow)

  if (percent === null || usedTokens == null || usedTokens <= 0 || contextWindow == null) {
    return null
  }

  const label = `${t('chat.context')}: ${percent}% · ${formatTokenCount(usedTokens)} / ${formatTokenCount(contextWindow)}`
  const canCompact = !!onCompact && !isProcessing

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-disabled={!canCompact}
          onClick={() => {
            if (canCompact) onCompact()
          }}
          className={cn(
            'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.035] transition-colors select-none',
            canCompact
              ? 'cursor-pointer hover:bg-foreground/[0.075]'
              : 'cursor-default',
            percent > 90
              ? 'text-destructive'
              : percent > 70
                ? 'text-warning'
                : 'text-foreground/55',
          )}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 32 32"
            className={cn('absolute inset-0 h-8 w-8 -rotate-90', isCompacting && 'animate-spin')}
          >
            <circle
              cx="16"
              cy="16"
              r="12"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.24"
              strokeWidth="2.5"
            />
            <circle
              cx="16"
              cy="16"
              r="12"
              fill="none"
              pathLength="100"
              stroke="currentColor"
              strokeDasharray="100"
              strokeDashoffset={100 - percent}
              strokeLinecap="round"
              strokeWidth="2.5"
              className="transition-[stroke-dashoffset] duration-300"
            />
          </svg>
          <span className="relative text-[8px] font-bold leading-none tracking-[-0.04em] tabular-nums">
            {percent}%
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
