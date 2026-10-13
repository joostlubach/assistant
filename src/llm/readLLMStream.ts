import { LLMErrorCode, LLMResponse, LLMStreamEvent } from './types'

/**
 * Reads the newline-delimited events that the server relays, and resolves to the response they end in.
 */
export async function readLLMStream(body: ReadableStream<Uint8Array>, onEvent: (event: LLMStreamEvent) => void): Promise<LLMResponse> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  while (true) {
    const {value, done} = await reader.read()
    if (done) { break }

    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.trim() === '') { continue }

      const event = JSON.parse(line) as LLMStreamEvent
      if (event.type === 'done') { return event.response }
      if (event.type === 'error') { throw new LLMStreamError(event.error.code, event.error.message) }
      onEvent(event)
    }
  }

  throw new LLMStreamError('unavailable', 'The response ended unexpectedly')
}

export class LLMStreamError extends Error {

  constructor(
    public readonly code: LLMErrorCode,
    message: string,
  ) {
    super(message)
  }

}
