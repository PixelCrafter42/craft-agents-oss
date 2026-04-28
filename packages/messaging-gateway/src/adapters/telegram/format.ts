/**
 * Markdown -> Telegram MarkdownV2 formatting.
 *
 * Telegram MarkdownV2 is not CommonMark. We parse common Markdown with marked,
 * then render only the entity forms Telegram supports and escape everything
 * else as plain text.
 */

import { lexer, type Token, type Tokens } from 'marked'

/** Characters that must be escaped in Telegram MarkdownV2. */
const TG_SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g
const TG_CODE_CHARS = /([`\\])/g
const TG_LINK_URL_CHARS = /([)\\])/g
const TG_LANGUAGE_CHARS = /[^A-Za-z0-9_-]/g

/** Escape text for Telegram MarkdownV2 parse mode. */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(TG_SPECIAL_CHARS, '\\$1')
}

/** Escape source text as plain MarkdownV2 without preserving Markdown styling. */
export function formatPlainTextForTelegram(text: string): string {
  return escapeTelegramMarkdown(text)
}

/** Convert common Markdown into Telegram MarkdownV2. */
export function formatForTelegram(text: string): string {
  if (!text) return ''
  const tokens = lexer(text, { gfm: true, breaks: false })
  return renderBlockTokens(tokens).trim()
}

/** Escape content inside Telegram code/pre entities. */
function escapeTelegramCode(text: string): string {
  return text.replace(TG_CODE_CHARS, '\\$1')
}

/** Escape the URL portion of a Telegram MarkdownV2 inline link. */
function escapeTelegramLinkUrl(url: string): string {
  return url.replace(TG_LINK_URL_CHARS, '\\$1')
}

function renderBlockTokens(tokens: readonly Token[]): string {
  const blocks: string[] = []

  for (const token of tokens) {
    const rendered = renderBlockToken(token).trimEnd()
    if (rendered) blocks.push(rendered)
  }

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n')
}

function renderBlockToken(token: Token): string {
  switch (token.type) {
    case 'space':
      return ''
    case 'heading':
      return renderHeading(token as Tokens.Heading)
    case 'paragraph':
      return renderInlineTokens((token as Tokens.Paragraph).tokens ?? [])
    case 'blockquote':
      return renderBlockquote(token as Tokens.Blockquote)
    case 'list':
      return renderList(token as Tokens.List)
    case 'code':
      return renderCodeBlock(token as Tokens.Code)
    case 'hr':
      return escapeTelegramMarkdown('---')
    case 'html':
      return escapeTelegramMarkdown(token.text)
    case 'table':
      return renderTable(token as Tokens.Table)
    case 'text':
      return token.tokens ? renderInlineTokens(token.tokens) : escapeTelegramMarkdown(token.text)
    default:
      return renderUnknownToken(token)
  }
}

function renderInlineTokens(tokens: readonly Token[]): string {
  return tokens.map(renderInlineToken).join('')
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case 'text':
      return token.tokens ? renderInlineTokens(token.tokens) : escapeTelegramMarkdown(token.text)
    case 'escape':
      return escapeTelegramMarkdown(token.text)
    case 'strong':
      return `*${renderInlineTokens((token as Tokens.Strong).tokens ?? [])}*`
    case 'em':
      return `_${renderInlineTokens((token as Tokens.Em).tokens ?? [])}_`
    case 'del':
      return `~${renderInlineTokens((token as Tokens.Del).tokens ?? [])}~`
    case 'codespan':
      return `\`${escapeTelegramCode(token.text)}\``
    case 'br':
      return '\n'
    case 'link':
      return renderLink(token as Tokens.Link)
    case 'image':
      return renderImage(token as Tokens.Image)
    case 'html':
      return escapeTelegramMarkdown(token.text)
    default:
      return renderUnknownToken(token)
  }
}

function renderHeading(token: Tokens.Heading): string {
  const text = renderPlainInlineTokens(token.tokens || [])
  return text ? `*${text}*` : ''
}

function renderBlockquote(token: Tokens.Blockquote): string {
  const body = renderBlockTokens(token.tokens).trim()
  if (!body) return ''
  return body
    .split('\n')
    .map((line) => `>${line}`)
    .join('\n')
}

function renderList(token: Tokens.List): string {
  const start = typeof token.start === 'number' ? token.start : 1

  return token.items
    .map((item, index) => {
      const marker = token.ordered ? `${start + index}\\.` : '\\-'
      const body = renderListItem(item)
      if (!body) return marker

      const lines = body.split('\n')
      const [first = '', ...rest] = lines
      const continuation = rest.map((line) => `  ${line}`).join('\n')
      return continuation ? `${marker} ${first}\n${continuation}` : `${marker} ${first}`
    })
    .join('\n')
}

function renderListItem(item: Tokens.ListItem): string {
  const body = renderBlockTokens(item.tokens).trim()
  if (!item.task) return body

  const checkbox = item.checked ? '\\[x\\]' : '\\[ \\]'
  return body ? `${checkbox} ${body}` : checkbox
}

function renderCodeBlock(token: Tokens.Code): string {
  const lang = (token.lang ?? '').replace(TG_LANGUAGE_CHARS, '')
  const opener = lang ? `\`\`\`${lang}` : '```'
  const body = escapeTelegramCode(token.text.replace(/\n$/, ''))
  return `${opener}\n${body}\n\`\`\``
}

function renderLink(token: Tokens.Link): string {
  const label = renderInlineTokens(token.tokens).trim() || escapeTelegramMarkdown(token.href)
  if (!token.href) return label
  return `[${label}](${escapeTelegramLinkUrl(token.href)})`
}

function renderImage(token: Tokens.Image): string {
  const label = escapeTelegramMarkdown(token.text || token.href)
  if (!token.href) return label
  return `[${label}](${escapeTelegramLinkUrl(token.href)})`
}

function renderTable(token: Tokens.Table): string {
  const rows = [token.header, ...token.rows]
  return rows
    .map((row) => row.map((cell) => renderInlineTokens(cell.tokens)).join(' \\| '))
    .join('\n')
}

function renderUnknownToken(token: Token): string {
  const maybeTokens = (token as { tokens?: Token[] }).tokens
  if (maybeTokens) return renderInlineTokens(maybeTokens)

  const maybeText = (token as { text?: unknown }).text
  if (typeof maybeText === 'string') return escapeTelegramMarkdown(maybeText)

  return escapeTelegramMarkdown(token.raw ?? '')
}

function renderPlainInlineTokens(tokens: readonly Token[]): string {
  return tokens.map(renderPlainInlineToken).join('')
}

function renderPlainInlineToken(token: Token): string {
  switch (token.type) {
    case 'text':
      return token.tokens ? renderPlainInlineTokens(token.tokens) : escapeTelegramMarkdown(token.text)
    case 'escape':
      return escapeTelegramMarkdown(token.text)
    case 'strong':
    case 'em':
    case 'del':
      return renderPlainInlineTokens((token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens ?? [])
    case 'codespan':
      return escapeTelegramMarkdown(token.text)
    case 'br':
      return '\n'
    case 'link':
      return renderPlainInlineTokens((token as Tokens.Link).tokens ?? []) ||
        escapeTelegramMarkdown((token as Tokens.Link).href)
    case 'image':
      return escapeTelegramMarkdown(token.text || token.href)
    case 'html':
      return escapeTelegramMarkdown(token.text)
    default:
      return renderUnknownToken(token)
  }
}
