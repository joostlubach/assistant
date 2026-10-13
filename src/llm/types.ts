/**
 * The wire types of the LLM endpoint that the assistant talks to: what it sends, and what streams back. They follow
 * the providers that are supported (Anthropic, OpenAI, AWS Bedrock).
 */

export interface LLMRequest {
  system:       string
  messages:     LLMMessage[]
  tools?:       LLMTool[]
  tool_choice?: LLMToolChoice
  max_tokens?:  number

  /** Asks the model to think first, where it can. */
  reasoning?: LLMReasoning

  /** Asks for the system prompt and conversation to be cached, where the provider needs to be told. */
  cache?: boolean
}

export interface LLMMessage {
  role:    'user' | 'assistant'
  content: LLMContentBlock[]
}

export type LLMContentBlock =
  | LLMTextBlock
  | LLMImageBlock
  | LLMDocumentBlock
  | LLMToolUseBlock
  | LLMToolResultBlock
  | LLMReasoningBlock

export interface LLMTextBlock {
  type: 'text'
  text: string
}

export interface LLMImageBlock {
  type:       'image'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  /** Base64 encoded. */
  data:       string
}

export interface LLMDocumentBlock {
  type:       'document'
  media_type: 'application/pdf'
  /** Base64 encoded. */
  data:       string
  title?:     string
}

export interface LLMToolUseBlock {
  type:  'tool_use'
  id:    string
  name:  string
  input: unknown
}

export interface LLMToolResultBlock {
  type:        'tool_result'
  tool_use_id: string
  content:     string
  is_error?:   boolean
}

/**
 * What the model thought. Only the provider that produced it can make sense of its `data`, so it is left out when the
 * conversation goes to another one.
 */
export interface LLMReasoningBlock {
  type:     'reasoning'
  provider: LLMProviderType
  text:     string
  data?:    unknown
}

export interface LLMTool {
  name:         string
  description:  string
  input_schema: Record<string, unknown>
}

export type LLMToolChoice =
  | {type: 'auto'}
  | {type: 'tool', name: string}

export interface LLMReasoning {
  effort:   'low' | 'medium' | 'high'
  /** Whether a summary of the reasoning should come along, to show. */
  summary?: boolean
}

export interface LLMResponse {
  model:       string
  content:     LLMContentBlock[]
  stop_reason: LLMStopReason
  usage:       LLMUsage
}

export type LLMStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'

/**
 * Events of a streamed response. `index` is the index of the block in the response's content. It always ends with
 * `done` or, over the wire, `error`.
 */
export type LLMStreamEvent =
  | {type: 'text', index: number, delta: string}
  | {type: 'reasoning', index: number, delta: string}
  | {type: 'usage', usage: LLMUsage}
  | {type: 'done', response: LLMResponse}
  | {type: 'error', error: {code: LLMErrorCode, message: string}}

export type LLMErrorCode = 'disabled' | 'authentication' | 'rate_limit' | 'unavailable' | 'invalid_request' | 'unknown'

export interface LLMUsage {
  input_tokens:       number
  output_tokens:      number
  cache_read_tokens:  number
  cache_write_tokens: number
}

export type LLMProviderType = 'anthropic' | 'openai' | 'bedrock'
