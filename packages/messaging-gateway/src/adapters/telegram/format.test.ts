import { describe, expect, it } from 'bun:test'
import {
  escapeTelegramMarkdown,
  formatForTelegram,
  formatPlainTextForTelegram,
} from './format'

describe('formatForTelegram', () => {
  it('renders headings as bold Telegram MarkdownV2 lines', () => {
    expect(formatForTelegram('# Release Notes')).toBe('*Release Notes*')
  })

  it('renders common inline Markdown entities', () => {
    expect(formatForTelegram('Hello **bold** and _em_ ~~gone~~.')).toBe(
      'Hello *bold* and _em_ ~gone~\\.',
    )
  })

  it('escapes raw Telegram MarkdownV2 punctuation in plain text', () => {
    expect(formatForTelegram('snake_case (x) #1!')).toBe(
      'snake\\_case \\(x\\) \\#1\\!',
    )
  })

  it('renders unordered and ordered lists with escaped markers', () => {
    expect(formatForTelegram('- first item\n- a_b')).toBe(
      '\\- first item\n\\- a\\_b',
    )
    expect(formatForTelegram('2. first\n3. second')).toBe(
      '2\\. first\n3\\. second',
    )
  })

  it('renders inline links and escapes closing parens in URLs', () => {
    expect(formatForTelegram('[Open](<https://example.com/a)b>)')).toBe(
      '[Open](https://example.com/a\\)b)',
    )
  })

  it('renders inline and fenced code without escaping normal code punctuation', () => {
    expect(formatForTelegram('Use `a_b()` now.')).toBe('Use `a_b()` now\\.')
    expect(formatForTelegram('```ts\nconst value = `x_y`;\n```')).toBe(
      '```ts\nconst value = \\`x_y\\`;\n```',
    )
  })

  it('renders blockquotes using Telegram MarkdownV2 quote markers', () => {
    expect(formatForTelegram('> quoted #1')).toBe('>quoted \\#1')
  })
})

describe('formatPlainTextForTelegram', () => {
  it('escapes source Markdown so fallback messages remain plain text', () => {
    expect(formatPlainTextForTelegram('**bold**')).toBe('\\*\\*bold\\*\\*')
  })
})

describe('escapeTelegramMarkdown', () => {
  it('escapes every Telegram MarkdownV2 special character', () => {
    expect(escapeTelegramMarkdown('_*[]()~`>#+-=|{}.!\\')).toBe(
      '\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\',
    )
  })
})
