import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, unlinkSync } from 'node:fs'
import { Readable } from 'node:stream'
import * as lark from '@larksuiteoapi/node-sdk'
import { LarkAdapter } from '../index'
import type { ButtonPress, IncomingMessage } from '../../../types'

const downloadedTempPaths: string[] = []

afterEach(() => {
  for (const path of downloadedTempPaths.splice(0)) {
    try {
      unlinkSync(path)
    } catch {
      // best-effort temp cleanup
    }
  }
})

function connectedAdapter(channel: object): LarkAdapter {
  const adapter = new LarkAdapter()
  Object.assign(adapter as unknown as Record<string, unknown>, {
    channel,
    connected: true,
  })
  return adapter
}

describe('LarkAdapter — Channel/CardKit integration', () => {
  it('disconnects old listeners before reconnecting and selects the configured domain', async () => {
    const options: lark.LarkChannelOptions[] = []
    const channels: Array<{
      handlers: Map<string, Set<(...args: any[]) => unknown>>
      disconnects: number
    }> = []
    const adapter = new LarkAdapter((input) => {
      options.push(input)
      const state = {
        handlers: new Map<string, Set<(...args: any[]) => unknown>>(),
        disconnects: 0,
      }
      channels.push(state)
      return {
        botIdentity: { name: 'Craft Agent' },
        on(event: string, handler: (...args: any[]) => unknown) {
          const handlers = state.handlers.get(event) ?? new Set()
          handlers.add(handler)
          state.handlers.set(event, handlers)
          return () => handlers.delete(handler)
        },
        connect: async () => {},
        disconnect: async () => { state.disconnects += 1 },
      } as unknown as lark.LarkChannel
    })

    await adapter.initialize({
      token: JSON.stringify({ appId: 'cli_cn', appSecret: 'secret', domain: 'feishu' }),
    })
    await adapter.initialize({
      token: JSON.stringify({ appId: 'cli_global', appSecret: 'secret', domain: 'lark' }),
    })

    expect(options.map((entry) => entry.domain)).toEqual([lark.Domain.Feishu, lark.Domain.Lark])
    expect(channels[0]?.disconnects).toBe(1)
    expect([...channels[0]!.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true)
    expect(channels[1]?.handlers.get('message')?.size).toBe(1)
    await adapter.destroy()
    expect(channels[1]?.disconnects).toBe(1)
  })

  it('removes listeners and disconnects when the initial connection fails', async () => {
    const handlers = new Set<(...args: any[]) => unknown>()
    let disconnects = 0
    const adapter = new LarkAdapter(() => ({
      on(_event: string, handler: (...args: any[]) => unknown) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      connect: async () => { throw new Error('handshake failed') },
      disconnect: async () => { disconnects += 1 },
    }) as unknown as lark.LarkChannel)

    await expect(adapter.initialize({
      token: JSON.stringify({ appId: 'cli_test', appSecret: 'secret', domain: 'lark' }),
    })).rejects.toThrow('handshake failed')

    expect(handlers.size).toBe(0)
    expect(disconnects).toBe(1)
    expect(adapter.isConnected()).toBe(false)
  })

  it('sends a schema-2 markdown button card once without a placeholder patch', async () => {
    const sends: Array<{ input: any; opts: any }> = []
    const adapter = connectedAdapter({
      send: async (_to: string, input: unknown, opts: unknown) => {
        sends.push({ input, opts })
        return { messageId: 'om_card' }
      },
    })

    const sent = await adapter.sendButtons(
      'oc_chat',
      '# Approve?',
      [{ id: 'allow', label: 'Allow', data: 'request-1' }],
      { replyToMessageId: 'om_source', replyInThread: true },
    )

    expect(sent.messageId).toBe('om_card')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.opts).toEqual({ replyTo: 'om_source', replyInThread: true })
    const card = sends[0]?.input.card
    expect(card.schema).toBe('2.0')
    expect(card.body.elements[0].tag).toBe('markdown')
    expect(card.body.elements[1].behaviors[0].value).toEqual({
      buttonId: 'allow',
      data: 'request-1',
    })
  })

  it('correlates card presses from the real callback message id', async () => {
    const presses: ButtonPress[] = []
    const adapter = connectedAdapter({})
    adapter.onButtonPress(async (press) => { presses.push(press) })

    await (adapter as any).handleCardAction({
      messageId: 'om_real',
      chatId: 'oc_chat',
      operator: { openId: 'ou_user', name: 'Alice' },
      action: { tag: 'button', value: { buttonId: 'allow', data: 'request-1' } },
    })

    expect(presses).toEqual([{
      platform: 'lark',
      channelId: 'oc_chat',
      messageId: 'om_real',
      senderId: 'ou_user',
      senderName: 'Alice',
      buttonId: 'allow',
      data: 'request-1',
    }])
  })

  it('sends group-only interactions through the ephemeral API and preserves callback context', async () => {
    const requests: any[] = []
    const presses: ButtonPress[] = []
    const adapter = connectedAdapter({
      rawClient: {
        request: async (request: unknown) => {
          requests.push(request)
          return { data: { message_id: 'om_private' } }
        },
      },
    })
    adapter.onButtonPress(async (press) => { presses.push(press) })

    const sent = await adapter.sendEphemeralCard(
      'oc_chat',
      'ou_user',
      'Private status',
      [{ id: 'dismiss', label: 'Dismiss' }],
    )
    await (adapter as any).handleCardAction({
      messageId: sent.messageId,
      chatId: 'oc_chat',
      operator: { openId: 'ou_user' },
      action: { tag: 'button', value: { buttonId: 'dismiss' } },
    })

    expect(sent.messageId).toBe('om_private')
    expect(requests).toEqual([expect.objectContaining({
      url: '/open-apis/ephemeral/v1/send',
      method: 'POST',
      data: expect.objectContaining({
        open_id: 'ou_user',
        chat_id: 'oc_chat',
        msg_type: 'interactive',
        card: expect.objectContaining({ schema: '2.0' }),
      }),
    })])
    expect(presses[0]).toMatchObject({ chatType: 'group', senderId: 'ou_user' })
  })

  it('selects the native outbound media kind by file extension', async () => {
    const inputs: any[] = []
    const adapter = connectedAdapter({
      send: async (_to: string, input: unknown) => {
        inputs.push(input)
        return { messageId: `om_${inputs.length}` }
      },
    })

    await adapter.sendFile('oc_chat', Buffer.from('image'), 'photo.png')
    await adapter.sendFile('oc_chat', Buffer.from('audio'), 'voice.ogg')
    await adapter.sendFile('oc_chat', Buffer.from('video'), 'clip.mp4')
    await adapter.sendFile('oc_chat', Buffer.from('file'), 'report.pdf')

    expect(inputs.map((input) => Object.keys(input)[0])).toEqual([
      'image',
      'audio',
      'video',
      'file',
    ])
    expect(inputs[3].file.fileName).toBe('report.pdf')
  })

  it('keeps one native stream controller through update and finish', async () => {
    const contents: string[] = []
    const adapter = connectedAdapter({
      stream: async (_to: string, input: any) => {
        await input.markdown({
          messageId: 'om_stream',
          append: async () => {},
          setContent: async (content: string) => { contents.push(content) },
        })
        return { messageId: 'om_stream' }
      },
    })

    const handle = await adapter.beginNativeStream('oc_chat', 'thinking')
    await adapter.updateNativeStream(handle, 'partial')
    const sent = await adapter.finishNativeStream(handle, 'final')

    expect(handle.messageId).toBe('om_stream')
    expect(sent.messageId).toBe('om_stream')
    expect(contents).toEqual(['thinking', 'partial', 'final'])
  })

  it('rotates a stream before the platform timeout and continues without repeating the head', async () => {
    const cardContents: string[][] = []
    let streamCount = 0
    const adapter = connectedAdapter({
      stream: async (_to: string, input: any, opts: unknown) => {
        const contents: string[] = []
        cardContents.push(contents)
        streamCount += 1
        const messageId = `om_stream_${streamCount}`
        await input.markdown({
          messageId,
          append: async () => {},
          setContent: async (content: string) => { contents.push(content) },
        })
        expect(opts).toEqual({ replyTo: 'om_source' })
        return { messageId }
      },
    })

    const handle = await adapter.beginNativeStream(
      'oc_chat',
      'first part',
      { replyToMessageId: 'om_source' },
    )
    const record = (adapter as any).streams.get(handle.id)
    record.startedAt = 0
    await adapter.updateNativeStream(handle, 'first part and second part')
    await adapter.finishNativeStream(handle, 'first part and second part done')

    expect(streamCount).toBe(2)
    expect(cardContents[0]).toEqual(['first part'])
    expect(cardContents[1]?.some((content) =>
      content.includes('Continued') &&
      content.includes('and second part') &&
      !content.includes('first part'),
    )).toBe(true)
  })

  it('normalizes group reply and native-thread context without using Telegram threadId', async () => {
    const messages: IncomingMessage[] = []
    const adapter = connectedAdapter({})
    adapter.onMessage(async (message) => { messages.push(message) })

    await (adapter as any).handleIncomingMessage({
      messageId: 'om_source',
      chatId: 'oc_chat',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'Alice',
      content: 'hello',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      rootId: 'om_root',
      threadId: 'omt_thread',
      replyToMessageId: 'om_parent',
      createTime: 123,
    })

    expect(messages[0]).toMatchObject({
      chatType: 'group',
      rootMessageId: 'om_root',
      nativeThreadId: 'omt_thread',
      replyToMessageId: 'om_parent',
    })
    expect(messages[0]?.threadId).toBeUndefined()
  })

  it('downloads native audio and images through the message-resource API', async () => {
    const messages: IncomingMessage[] = []
    const calls: Array<{
      params: { type: string }
      path: { message_id: string; file_key: string }
    }> = []
    const voiceBytes = Buffer.from([
      0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28,
    ])
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    )
    const adapter = connectedAdapter({
      rawClient: {
        im: {
          v1: {
            messageResource: {
              get: async (payload: typeof calls[number]) => {
                calls.push(payload)
                const isImage = payload.params.type === 'image'
                const bytes = isImage ? pngBytes : voiceBytes
                return {
                  headers: { 'content-type': isImage ? 'image/png' : 'audio/opus' },
                  getReadableStream: () => Readable.from([
                    bytes.subarray(0, 5),
                    bytes.subarray(5),
                  ]),
                }
              },
            },
          },
        },
      },
    })
    adapter.onMessage(async (message) => { messages.push(message) })

    await (adapter as any).handleIncomingMessage({
      messageId: 'om_source',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderId: 'ou_user',
      content: '<audio key="file_v3_voice" duration="6s"/>',
      rawContentType: 'audio',
      resources: [
        { type: 'audio', fileKey: 'file_v3_voice', durationMs: 6000 },
        { type: 'image', fileKey: 'img_v3_screenshot' },
      ],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    })

    expect(calls).toEqual([
      {
        params: { type: 'file' },
        path: { message_id: 'om_source', file_key: 'file_v3_voice' },
      },
      {
        params: { type: 'image' },
        path: { message_id: 'om_source', file_key: 'img_v3_screenshot' },
      },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('')
    expect(messages[0]?.attachments).toHaveLength(2)

    const [voice, image] = messages[0]!.attachments!
    expect(voice).toMatchObject({
      type: 'audio',
      fileId: 'file_v3_voice',
      mimeType: 'audio/opus',
      fileSize: voiceBytes.byteLength,
    })
    expect(voice?.fileName).toMatch(/^audio-[a-f0-9]+\.opus$/)
    expect(image).toMatchObject({
      type: 'photo',
      fileId: 'img_v3_screenshot',
      mimeType: 'image/png',
      fileSize: pngBytes.byteLength,
    })
    expect(image?.fileName).toMatch(/^image-[a-f0-9]+\.png$/)

    for (const attachment of [voice, image]) {
      expect(attachment?.localPath).toBeTruthy()
      downloadedTempPaths.push(attachment!.localPath!)
    }
    expect(readFileSync(voice!.localPath!)).toEqual(voiceBytes)
    expect(readFileSync(image!.localPath!)).toEqual(pngBytes)
  })

  it('keeps plain messaging available and reports degraded when CardKit permission is missing', async () => {
    const states: Array<{ state: string; detail?: string }> = []
    let calls = 0
    const adapter = connectedAdapter({
      send: async (_to: string, input: any) => {
        calls += 1
        if (input.card) {
          throw { response: { data: { code: 300311 } } }
        }
        return { messageId: 'om_plain' }
      },
    })
    Object.assign(adapter as unknown as Record<string, unknown>, {
      runtimeCallback: (state: string, detail?: string) => states.push({ state, detail }),
    })

    const sent = await adapter.sendText('oc_chat', '# Still works')

    expect(sent.messageId).toBe('om_plain')
    expect(calls).toBe(2)
    expect(states.at(-1)?.state).toBe('degraded')
  })
})
