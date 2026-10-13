import { readLLMStream } from './readLLMStream'
import {
  LLMContentBlock,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMTool,
  LLMToolResultBlock,
  LLMToolUseBlock,
} from './types'

/**
 * Runs a conversation with an LLM that can call tools: it requests a response, runs the tools that it calls, and sends
 * back their results, until the LLM is done. What the tools are and what they do is up to the delegate.
 */
export class AgentLoop {

  constructor(
    private readonly transport: AgentLoopTransport,
    private readonly delegate: AgentLoopDelegate,
  ) {}

  private _messages: LLMMessage[] = []
  public get messages() { return [...this._messages] }

  public load(messages: LLMMessage[]) {
    this._messages = [...messages]
    this.closeDanglingToolUses()
  }

  public append(message: LLMMessage) {
    this._messages.push(message)
  }

  public reset() {
    this._messages = []
  }

  /** An LLM only continues after a message of the user's (or tool results), not after its own. */
  public get canContinue() {
    const last = this._messages[this._messages.length - 1]
    return last?.role === 'user'
  }

  public async run(signal: AbortSignal): Promise<AgentLoopEnd> {
    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await this.request(signal)
      if (response == null || signal.aborted) { return 'aborted' }

      this._messages.push({role: 'assistant', content: response.content})

      if (response.stop_reason === 'refusal') {
        return 'refusal'
      }
      if (response.stop_reason === 'max_tokens') {
        this.closeDanglingToolUses()
        return 'max_tokens'
      }

      const toolUses = response.content.filter(it => it.type === 'tool_use')
      if (toolUses.length === 0) { return 'done' }

      // All results of a turn go back in a single message. Content that a tool result can't hold, like images,
      // follows the results.
      let endTurn = false
      const results: LLMToolResultBlock[] = []
      const extra: LLMContentBlock[] = []
      for (const toolUse of toolUses) {
        if (signal.aborted) { break }

        const run = await this.delegate.runTool(toolUse)
        results.push(run.result)
        extra.push(...run.extra ?? [])
        endTurn ||= run.endTurn
      }
      this._messages.push({role: 'user', content: [...results, ...extra, ...this.delegate.afterToolResults?.() ?? []]})
      if (signal.aborted) {
        this.closeDanglingToolUses()
        return 'aborted'
      }
      this.delegate.checkpoint?.()

      if (endTurn) { return 'done' }
    }

    return 'too_many_turns'
  }

  private async request(signal: AbortSignal): Promise<LLMResponse | null> {
    const stream = await this.transport({
      system:   this.delegate.system(),
      tools:    this.delegate.tools(),
      messages: this._messages,
    }, signal)

    // Canceled requests resolve to nothing.
    if (stream == null || signal.aborted) { return null }

    this.delegate.onResponseStart?.()

    // The text of the response's text and reasoning blocks so far, by block index.
    const texts = new Map<number, string>()
    return await readLLMStream(stream, event => {
      if ((event.type !== 'text' && event.type !== 'reasoning') || signal.aborted) { return }

      const text = (texts.get(event.index) ?? '') + event.delta
      texts.set(event.index, text)
      this.delegate.onText?.(event.index, event.type, text)
    })
  }

  /**
   * Every tool use needs a result before the conversation can continue, also when the turn was cut short.
   */
  public closeDanglingToolUses() {
    const assistantIndex = this._messages.findLastIndex(it => it.role === 'assistant')
    const last = this._messages[assistantIndex]
    if (last == null) { return }

    const answered = new Set(this._messages.slice(assistantIndex + 1).flatMap(message => (
      message.content.flatMap(it => it.type === 'tool_result' ? [it.tool_use_id] : [])
    )))
    const dangling = last.content.filter((it): it is LLMToolUseBlock => it.type === 'tool_use' && !answered.has(it.id))
    if (dangling.length === 0) { return }

    this._messages.push({
      role:    'user',
      content: dangling.map(it => ({
        type:        'tool_result',
        tool_use_id: it.id,
        content:     'Not run: the turn was interrupted.',
        is_error:    true,
      })),
    })
  }

}

/**
 * Sends a request to the LLM endpoint, and resolves to the stream of newline-delimited events that it relays. Resolves
 * to `null` when the request was canceled, and throws when it failed.
 */
export type AgentLoopTransport = (request: LLMRequest, signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>

export interface AgentLoopDelegate {
  system(): string
  tools(): LLMTool[]
  runTool(block: LLMToolUseBlock): Promise<AgentToolRun>

  /** Extra content to send along with the tool results, like what changed in the meantime. */
  afterToolResults?(): LLMContentBlock[]

  /** Called when a response starts streaming. Block indices passed to `onText` are relative to the response. */
  onResponseStart?(): void
  /** The text of a text or reasoning block so far. */
  onText?(index: number, type: 'text' | 'reasoning', text: string): void

  /** The conversation is in a consistent state, and can be stored. */
  checkpoint?(): void
}

export interface AgentToolRun {
  result: LLMToolResultBlock

  /** Content that goes after the results of the turn, as a tool result can only hold text. */
  extra?: LLMContentBlock[]

  /** Ends the turn after this round of tool calls, like when the user is asked something. */
  endTurn: boolean
}

export type AgentLoopEnd = 'done' | 'aborted' | 'refusal' | 'max_tokens' | 'too_many_turns'

// A safeguard against runaway loops; a large request may take a few dozen tool calls.
const maxTurns = 40
