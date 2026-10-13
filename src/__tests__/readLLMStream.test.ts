import { describe, expect, it, vi } from 'vitest'
import { LLMStreamError, readLLMStream } from '../llm/readLLMStream'
import { LLMStreamEvent } from '../llm/types'
import { eventStream, response, text } from './helpers'

describe('readLLMStream', () => {

  it('reads events that are split across chunks, and resolves to the response they end in', async () => {
    const events: LLMStreamEvent[] = [
      {type: 'text', index: 0, delta: 'Hello'},
      {type: 'text', index: 0, delta: ' world'},
      {type: 'done', response: response([text('Hello world')])},
    ]
    const onEvent = vi.fn()

    const result = await readLLMStream(eventStream(events, 7), onEvent)

    expect(result.content).toEqual([text('Hello world')])
    expect(onEvent.mock.calls.map(it => it[0])).toEqual(events.slice(0, 2))
  })

  it('throws the error that the stream ends in', async () => {
    const stream = eventStream([
      {type: 'text', index: 0, delta: 'Hel'},
      {type: 'error', error: {code: 'rate_limit', message: 'Slow down'}},
    ])

    const error = await readLLMStream(stream, () => {}).catch(it => it)
    expect(error).toBeInstanceOf(LLMStreamError)
    expect(error).toMatchObject({code: 'rate_limit', message: 'Slow down'})
  })

  it('throws when the stream ends without a response', async () => {
    const error = await readLLMStream(eventStream([{type: 'text', index: 0, delta: 'Hel'}]), () => {}).catch(it => it)
    expect(error).toBeInstanceOf(LLMStreamError)
    expect(error).toMatchObject({code: 'unavailable'})
  })

})
