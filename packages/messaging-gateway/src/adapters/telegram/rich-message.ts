/**
 * Telegram Bot API 10.2 rich-message wire types and builders.
 *
 * grammY/@grammyjs/types in the current lockfile predates these shapes. Keep
 * the compatibility layer at the adapter boundary so it can be deleted once
 * the dependency exposes the same API.
 */

export type TelegramRichText =
  | string
  | TelegramRichText[]
  | { type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'spoiler' | 'marked'; text: TelegramRichText }
  | { type: 'url'; text: TelegramRichText; url: string }
  | { type: 'mathematical_expression'; expression: string }

export interface TelegramRichBlockCaption {
  text: TelegramRichText
  credit?: TelegramRichText
}

export interface TelegramRichBlockTableCell {
  text?: TelegramRichText
  is_header?: true
  colspan?: number
  rowspan?: number
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
}

type TelegramInputMediaOf<T extends 'animation' | 'audio' | 'photo' | 'video' | 'voice_note'> = {
  type: T
  /** A Telegram file_id/URL or grammY InputFile. */
  media: unknown
}

export type TelegramInputMedia =
  | TelegramInputMediaOf<'animation'>
  | TelegramInputMediaOf<'audio'>
  | TelegramInputMediaOf<'photo'>
  | TelegramInputMediaOf<'video'>
  | TelegramInputMediaOf<'voice_note'>

export interface TelegramInputRichMessageMedia {
  id: string
  media: TelegramInputMedia
}

export interface TelegramInputRichBlockListItem {
  blocks: TelegramInputRichBlock[]
  has_checkbox?: true
  is_checked?: true
  value?: number
  type?: 'a' | 'A' | 'i' | 'I' | '1'
}

export type TelegramInputRichBlock =
  | { type: 'paragraph'; text: TelegramRichText }
  | { type: 'heading'; text: TelegramRichText; size: number }
  | { type: 'pre'; text: TelegramRichText; language?: string }
  | { type: 'footer'; text: TelegramRichText }
  | { type: 'divider' }
  | { type: 'mathematical_expression'; expression: string }
  | { type: 'anchor'; name: string }
  | { type: 'list'; items: TelegramInputRichBlockListItem[] }
  | { type: 'blockquote'; blocks: TelegramInputRichBlock[]; credit?: TelegramRichText }
  | { type: 'pullquote'; text: TelegramRichText; credit?: TelegramRichText }
  | {
      type: 'collage' | 'slideshow'
      blocks: TelegramInputRichBlock[]
      caption?: TelegramRichBlockCaption
    }
  | {
      type: 'table'
      cells: TelegramRichBlockTableCell[][]
      is_bordered?: true
      is_striped?: true
      caption?: TelegramRichText
    }
  | { type: 'details'; summary: TelegramRichText; blocks: TelegramInputRichBlock[]; is_open?: true }
  | {
      type: 'map'
      location: { latitude: number; longitude: number }
      zoom: number
      width: number
      height: number
      caption?: TelegramRichBlockCaption
    }
  | { type: 'animation'; animation: TelegramInputMediaOf<'animation'>; caption?: TelegramRichBlockCaption }
  | { type: 'audio'; audio: TelegramInputMediaOf<'audio'>; caption?: TelegramRichBlockCaption }
  | { type: 'photo'; photo: TelegramInputMediaOf<'photo'>; caption?: TelegramRichBlockCaption }
  | { type: 'video'; video: TelegramInputMediaOf<'video'>; caption?: TelegramRichBlockCaption }
  | { type: 'voice_note'; voice_note: TelegramInputMediaOf<'voice_note'>; caption?: TelegramRichBlockCaption }
  | { type: 'thinking'; text: TelegramRichText }

interface TelegramRichMessageOptions {
  media?: TelegramInputRichMessageMedia[]
  is_rtl?: boolean
  skip_entity_detection?: boolean
}

/** Bot API requires exactly one content representation. */
export type TelegramRichMessagePayload = TelegramRichMessageOptions & (
  | { blocks: TelegramInputRichBlock[]; html?: never; markdown?: never }
  | { html: string; blocks?: never; markdown?: never }
  | { markdown: string; blocks?: never; html?: never }
)

interface InlineMatch {
  index: number
  length: number
  value: TelegramRichText
}

function earliestInlineMatch(text: string): InlineMatch | null {
  const matches: InlineMatch[] = []
  const add = (match: RegExpMatchArray | null, build: (match: RegExpMatchArray) => TelegramRichText) => {
    if (!match || match.index === undefined) return
    matches.push({ index: match.index, length: match[0].length, value: build(match) })
  }

  add(text.match(/`([^`\n]+)`/), (m) => ({ type: 'code', text: m[1]! }))
  add(text.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/), (m) => ({
    type: 'url',
    text: parseInline(m[1]!),
    url: m[2]!,
  }))
  add(text.match(/\*\*([^*]+)\*\*/), (m) => ({ type: 'bold', text: parseInline(m[1]!) }))
  add(text.match(/__([^_]+)__/), (m) => ({ type: 'bold', text: parseInline(m[1]!) }))
  add(text.match(/~~([^~]+)~~/), (m) => ({ type: 'strikethrough', text: parseInline(m[1]!) }))
  add(text.match(/(?<!\*)\*([^*\n]+)\*(?!\*)/), (m) => ({ type: 'italic', text: parseInline(m[1]!) }))
  add(text.match(/(?<!_)_([^_\n]+)_(?!_)/), (m) => ({ type: 'italic', text: parseInline(m[1]!) }))
  add(text.match(/\$([^$\n]+)\$/), (m) => ({ type: 'mathematical_expression', expression: m[1]! }))

  matches.sort((a, b) => a.index - b.index || b.length - a.length)
  return matches[0] ?? null
}

export function parseInline(text: string): TelegramRichText {
  const parts: TelegramRichText[] = []
  let remaining = text
  while (remaining) {
    const match = earliestInlineMatch(remaining)
    if (!match) {
      parts.push(remaining)
      break
    }
    if (match.index > 0) parts.push(remaining.slice(0, match.index))
    parts.push(match.value)
    remaining = remaining.slice(match.index + match.length)
  }
  if (parts.length === 0) return ''
  return parts.length === 1 ? parts[0]! : parts
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function tableAlignment(cell: string): TelegramRichBlockTableCell['align'] {
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
  if (cell.endsWith(':')) return 'right'
  return 'left'
}

function mediaKindForUrl(url: string): TelegramInputMedia['type'] | null {
  const pathname = url.split(/[?#]/, 1)[0]!.toLowerCase()
  if (/\.(?:gif)$/.test(pathname)) return 'animation'
  if (/\.(?:jpe?g|png|webp|bmp|heic|heif)$/.test(pathname)) return 'photo'
  if (/\.(?:mp4|mov|m4v|webm)$/.test(pathname)) return 'video'
  if (/\.(?:mp3|m4a|ogg|oga|opus|wav|flac)$/.test(pathname)) return 'audio'
  return null
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  if (!line.trim()) return true
  if (/^#{1,6}\s+/.test(line) || /^```/.test(line) || /^\s*(?:[-*+] |\d+\. )/.test(line)) return true
  if (/^\s*>\s?/.test(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) return true
  if (/^\s*\$\$/.test(line) || /^\s*!\[[^\]]*\]\(https?:\/\//.test(line)) return true
  return line.includes('|') && isTableDivider(lines[index + 1] ?? '')
}

/** Convert common AI Markdown into Bot API 10.2 programmable blocks. */
export function markdownToTelegramBlocks(markdown: string): TelegramInputRichBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: TelegramInputRichBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = line.match(/^```\s*([^\s`]*)/)
    if (fence) {
      const content: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) content.push(lines[i++]!)
      if (i < lines.length) i += 1
      blocks.push({
        type: 'pre',
        text: content.join('\n'),
        ...(fence[1] ? { language: fence[1] } : {}),
      })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'heading', size: heading[1]!.length, text: parseInline(heading[2]!) })
      i += 1
      continue
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: 'divider' })
      i += 1
      continue
    }

    if (/^\s*\$\$/.test(line)) {
      const expression: string[] = []
      let current = line.replace(/^\s*\$\$/, '')
      let closed = current.includes('$$')
      if (closed) current = current.replace(/\$\$.*$/, '')
      if (current) expression.push(current)
      i += 1
      while (!closed && i < lines.length) {
        current = lines[i++]!
        closed = current.includes('$$')
        expression.push(closed ? current.replace(/\$\$.*$/, '') : current)
      }
      blocks.push({ type: 'mathematical_expression', expression: expression.join('\n').trim() })
      continue
    }

    const media = line.trim().match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["']([^"']+)["'])?\)$/)
    if (media) {
      const kind = mediaKindForUrl(media[2]!)
      if (kind) {
        const captionText = media[3] || media[1]
        const caption = captionText ? { text: parseInline(captionText) } : undefined
        const mediaValue = media[2]!
        if (kind === 'animation') {
          blocks.push({
            type: 'animation',
            animation: { type: kind, media: mediaValue },
            ...(caption ? { caption } : {}),
          })
        }
        if (kind === 'photo') {
          blocks.push({
            type: 'photo',
            photo: { type: kind, media: mediaValue },
            ...(caption ? { caption } : {}),
          })
        }
        if (kind === 'video') {
          blocks.push({
            type: 'video',
            video: { type: kind, media: mediaValue },
            ...(caption ? { caption } : {}),
          })
        }
        if (kind === 'audio') {
          blocks.push({
            type: 'audio',
            audio: { type: kind, media: mediaValue },
            ...(caption ? { caption } : {}),
          })
        }
        i += 1
        continue
      }
    }

    if (line.includes('|') && isTableDivider(lines[i + 1] ?? '')) {
      const headers = splitTableRow(line)
      const divider = splitTableRow(lines[i + 1]!)
      const cells: TelegramRichBlockTableCell[][] = [headers.map((text, index) => ({
        text: parseInline(text),
        is_header: true,
        align: tableAlignment(divider[index] ?? '---'),
        valign: 'top',
      }))]
      i += 2
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        cells.push(splitTableRow(lines[i]!).map((text, index) => ({
          text: parseInline(text),
          align: tableAlignment(divider[index] ?? '---'),
          valign: 'top',
        })))
        i += 1
      }
      blocks.push({ type: 'table', cells, is_bordered: true, is_striped: true })
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quote.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      }
      blocks.push({
        type: 'blockquote',
        blocks: [{ type: 'paragraph', text: parseInline(quote.join('\n')) }],
      })
      continue
    }

    const listMatch = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/)
    if (listMatch) {
      const ordered = Boolean(listMatch[2])
      const items: TelegramInputRichBlockListItem[] = []
      while (i < lines.length) {
        const item = lines[i]!.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/)
        if (!item || Boolean(item[2]) !== ordered) break
        let content = item[3]!
        const checkbox = content.match(/^\[([ xX])\]\s+(.+)$/)
        if (checkbox) content = checkbox[2]!
        items.push({
          blocks: [{ type: 'paragraph', text: parseInline(content) }],
          ...(checkbox ? { has_checkbox: true as const } : {}),
          ...(checkbox?.[1]?.toLowerCase() === 'x' ? { is_checked: true as const } : {}),
          ...(ordered ? { value: Number(item[2]), type: '1' as const } : {}),
        })
        i += 1
      }
      blocks.push({ type: 'list', items })
      continue
    }

    const paragraph = [line]
    i += 1
    while (i < lines.length && !isBlockStart(lines, i)) paragraph.push(lines[i++]!)
    blocks.push({ type: 'paragraph', text: parseInline(paragraph.join('\n').trim()) })
  }

  return blocks
}

export function buildTelegramRichMessage(
  markdown: string,
  options: { draft?: boolean } = {},
): TelegramRichMessagePayload {
  if (options.draft && /^\s*(?:\ud83d\udcad\s*)?thinking(?:\u2026|\.\.\.)?\s*$/i.test(markdown)) {
    return { blocks: [{ type: 'thinking', text: parseInline(markdown.trim()) }] }
  }
  const blocks = markdownToTelegramBlocks(markdown)
  return blocks.length > 0 ? { blocks } : { markdown }
}

export function buildTelegramRichMediaMessage(
  caption: string | undefined,
  media: TelegramInputMedia,
  id = 'attachment',
): TelegramRichMessagePayload {
  const linkType = media.type === 'photo'
    ? 'photo'
    : media.type === 'video' || media.type === 'animation'
      ? 'video'
      : 'audio'
  const mediaMarkdown = `![](tg://${linkType}?id=${id})`
  return {
    markdown: caption?.trim() ? `${caption.trim()}\n\n${mediaMarkdown}` : mediaMarkdown,
    media: [{ id, media }],
  }
}
