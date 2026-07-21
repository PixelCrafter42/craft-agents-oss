import { describe, expect, it } from 'bun:test'
import {
  buildTelegramRichMessage,
  markdownToTelegramBlocks,
} from './rich-message'

describe('Telegram Bot API 10.2 rich block builder', () => {
  it('turns AI Markdown into programmable headings, lists, quotes, tables, code, and math', () => {
    const blocks = markdownToTelegramBlocks([
      '# Report',
      '',
      '- [x] shipped',
      '- pending',
      '',
      '> private note',
      '',
      '| Metric | Value |',
      '|:---|---:|',
      '| Speed | **42 ms** |',
      '',
      '```ts',
      'const answer = 42',
      '```',
      '',
      '$$E = mc^2$$',
    ].join('\n'))

    expect(blocks).toMatchObject([
      { type: 'heading', size: 1, text: 'Report' },
      {
        type: 'list',
        items: [
          { has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: 'shipped' }] },
          { blocks: [{ type: 'paragraph', text: 'pending' }] },
        ],
      },
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'private note' }] },
      {
        type: 'table',
        cells: [
          [
            { text: 'Metric', is_header: true, align: 'left', valign: 'top' },
            { text: 'Value', is_header: true, align: 'right', valign: 'top' },
          ],
          [
            { text: 'Speed', align: 'left', valign: 'top' },
            { text: { type: 'bold', text: '42 ms' }, align: 'right', valign: 'top' },
          ],
        ],
      },
      { type: 'pre', language: 'ts', text: 'const answer = 42' },
      { type: 'mathematical_expression', expression: 'E = mc^2' },
    ])
  })

  it('creates structured HTTP media blocks and a draft-only thinking block', () => {
    expect(markdownToTelegramBlocks('![Chart](https://example.com/chart.png "Latest chart")')).toMatchObject([
      {
        type: 'photo',
        photo: { type: 'photo', media: 'https://example.com/chart.png' },
        caption: { text: 'Latest chart' },
      },
    ])
    expect(buildTelegramRichMessage('💭 thinking…', { draft: true })).toEqual({
      blocks: [{ type: 'thinking', text: '💭 thinking…' }],
    })
  })
})
