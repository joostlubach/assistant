import { LLMContentBlock, LLMResponse, LLMStopReason, LLMStreamEvent } from '../llm/types'

/**
 * A stream of newline-delimited events, as the server relays them, cut into chunks of the given size.
 */
export function eventStream(events: LLMStreamEvent[], chunkSize: number = Infinity): ReadableStream<Uint8Array> {
  const text = events.map(it => JSON.stringify(it)).join('\n') + '\n'
  const bytes = new TextEncoder().encode(text)

  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += Math.min(chunkSize, bytes.length)) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize))
      }
      controller.close()
    },
  })
}

export function response(content: LLMContentBlock[], stopReason: LLMStopReason = 'end_turn'): LLMResponse {
  return {
    model:       'test',
    content:     content,
    stop_reason: stopReason,
    usage:       {input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0},
  }
}

/** The events of a response: its text blocks streamed, and then the response itself. */
export function responseEvents(content: LLMContentBlock[], stopReason: LLMStopReason = 'end_turn'): LLMStreamEvent[] {
  return [
    ...content.flatMap((block, index): LLMStreamEvent[] => block.type === 'text' ? [{type: 'text', index, delta: block.text}] : []),
    {type: 'done', response: response(content, stopReason)},
  ]
}

export function toolUse(id: string, name: string, input: unknown = {}): LLMContentBlock {
  return {type: 'tool_use', id, name, input}
}

export function text(text: string): LLMContentBlock {
  return {type: 'text', text}
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(it => { resolve = it })
  return {promise, resolve}
}
