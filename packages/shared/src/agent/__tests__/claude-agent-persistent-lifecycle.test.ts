import { describe, expect, it, mock } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { AbortReason } from '../backend/types.ts'

function bareAgent(): any {
  const agent = Object.create(ClaudeAgent.prototype) as any
  agent.config = { session: { id: 'session-1' } }
  agent.activeTurnDepth = 0
  agent.currentQuery = null
  agent.currentQueryAbortController = null
  agent.persistentInput = null
  agent.persistentQuery = null
  agent.persistentIterator = null
  agent.persistentAbortController = null
  agent.activeTurnChannel = null
  agent.persistentConsumerActive = false
  agent.pendingSteerMessage = null
  agent.keepBackgroundTasksAlive = true
  return agent
}

describe('ClaudeAgent persistent-query lifecycle', () => {
  it('reports processing from the active turn, not from an idle keep-alive query', () => {
    const agent = bareAgent()
    agent.currentQuery = { interrupt: async () => {} }
    agent.persistentQuery = agent.currentQuery

    expect(agent.isProcessing()).toBe(false)
    agent.activeTurnDepth = 1
    expect(agent.isProcessing()).toBe(true)
    agent.activeTurnDepth = 0
    expect(agent.isProcessing()).toBe(false)
  })

  it('force-abort tears down every persistent query handle', () => {
    const agent = bareAgent()
    const endInput = mock(() => {})
    const returnIterator = mock(async () => ({ done: true, value: undefined }))
    const abort = mock(() => {})
    const query = { interrupt: async () => {} }

    agent.currentQuery = query
    agent.currentQueryAbortController = { abort }
    agent.persistentInput = { end: endInput }
    agent.persistentQuery = query
    agent.persistentIterator = { return: returnIterator }
    agent.persistentAbortController = agent.currentQueryAbortController

    agent.forceAbort(AbortReason.UserStop)

    expect(endInput).toHaveBeenCalledTimes(1)
    expect(returnIterator).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(agent.currentQuery).toBeNull()
    expect(agent.currentQueryAbortController).toBeNull()
    expect(agent.persistentQuery).toBeNull()
    expect(agent.persistentIterator).toBeNull()
  })

  it('clearHistory closes the persistent query before forgetting its SDK session', () => {
    const agent = bareAgent()
    const abort = mock(() => {})
    const query = { interrupt: async () => {} }
    agent.sessionId = 'sdk-session'
    agent.currentQuery = query
    agent.currentQueryAbortController = { abort }
    agent.persistentInput = { end: () => {} }
    agent.persistentQuery = query
    agent.persistentIterator = { return: async () => ({ done: true, value: undefined }) }
    agent.persistentAbortController = agent.currentQueryAbortController

    agent.clearHistory()

    expect(abort).toHaveBeenCalledTimes(1)
    expect(agent.persistentQuery).toBeNull()
    expect(agent.sessionId).toBeNull()
  })

  it('tears down the keep-alive query before running /compact', async () => {
    const agent = bareAgent()
    const abort = mock(() => {})
    const end = mock(() => {})
    const query = { interrupt: async () => {} }
    agent.currentQuery = query
    agent.currentQueryAbortController = { abort }
    agent.persistentInput = { end }
    agent.persistentQuery = query
    agent.persistentIterator = { return: async () => ({ done: true, value: undefined }) }
    agent.persistentAbortController = agent.currentQueryAbortController

    await agent.prepareForSdkSlashCommand('compact')

    expect(end).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(agent.currentQuery).toBeNull()
    expect(agent.currentQueryAbortController).toBeNull()
    expect(agent.persistentQuery).toBeNull()
  })

  it('waits for the old iterator to close before /compact may continue', async () => {
    const agent = bareAgent()
    let finishClose!: () => void
    const closeFinished = new Promise<void>((resolve) => { finishClose = resolve })
    const query = { interrupt: async () => {} }
    agent.currentQuery = query
    agent.currentQueryAbortController = { abort: () => {} }
    agent.persistentInput = { end: () => {} }
    agent.persistentQuery = query
    agent.persistentIterator = {
      return: () => closeFinished.then(() => ({ done: true, value: undefined })),
    }
    agent.persistentAbortController = agent.currentQueryAbortController

    let prepared = false
    const preparing = agent.prepareForSdkSlashCommand('compact').then(() => { prepared = true })
    await Promise.resolve()
    expect(prepared).toBe(false)

    finishClose()
    await preparing
    expect(prepared).toBe(true)
  })

  it('does not let an old consumer tear down a replacement query', async () => {
    const agent = bareAgent()
    let finishOld!: (result: IteratorResult<unknown>) => void
    const oldIterator = {
      next: () => new Promise<IteratorResult<unknown>>((resolve) => { finishOld = resolve }),
    }
    const oldQuery = { interrupt: async () => {} }
    agent.persistentInput = { end: () => {} }
    agent.persistentQuery = oldQuery
    agent.persistentIterator = oldIterator
    agent.persistentAbortController = { abort: () => {} }
    agent.currentQuery = oldQuery
    agent.currentQueryAbortController = agent.persistentAbortController

    agent.startPersistentConsumer()
    await Promise.resolve()
    agent.teardownPersistentQuery('replace-for-test')

    const replacementQuery = { interrupt: async () => {} }
    const replacementIterator = { next: async () => new Promise<IteratorResult<unknown>>(() => {}) }
    agent.persistentInput = { end: () => {} }
    agent.persistentQuery = replacementQuery
    agent.persistentIterator = replacementIterator
    agent.persistentAbortController = { abort: () => {} }
    agent.currentQuery = replacementQuery
    agent.currentQueryAbortController = agent.persistentAbortController

    finishOld({ done: true, value: undefined })
    await Promise.resolve()
    await Promise.resolve()

    expect(agent.persistentQuery).toBe(replacementQuery)
    expect(agent.persistentIterator).toBe(replacementIterator)
    expect(agent.currentQuery).toBe(replacementQuery)
  })
})
