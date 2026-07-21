import { describe, expect, it } from 'bun:test'
import * as lark from '@larksuiteoapi/node-sdk'
import { LarkAdapter } from '../index'
import type { ButtonPress, IncomingMessage } from '../../../types'

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
