import { AssistantTarget } from './AssistantTool'
import { AssistantQuestion } from './tools/AskUserTool'

/**
 * An entry in the conversation as shown to the user.
 */
export type AssistantEntry =
  | AssistantUserEntry
  | AssistantReplyEntry
  | AssistantThinkingEntry
  | AssistantToolEntry
  | AssistantInteraction
  | AssistantErrorEntry

export interface AssistantUserEntry {
  type:   'user'
  text:   string
  images: string[]
}

export interface AssistantReplyEntry {
  type: 'assistant'
  text: string
}

/** A summary of the assistant's reasoning. */
export interface AssistantThinkingEntry {
  type: 'thinking'
  text: string
}

export interface AssistantToolEntry {
  type:    'tool'
  tool:    string
  subject: string | null
  target:  AssistantTarget | null
  error:   boolean
}

/**
 * The kinds of things the assistant can ask of the user, by type. Apps add their own by augmenting this interface:
 *
 * ```ts
 * declare module 'assistant' {
 *   interface AssistantInteractions {
 *     asset_request: AssetRequestEntry
 *   }
 * }
 * ```
 */
export interface AssistantInteractions {
  question: AssistantQuestionEntry
}

/**
 * Something the assistant asks of the user, which ends its turn. The user's response is their next message.
 */
export type AssistantInteraction = AssistantInteractions[keyof AssistantInteractions]

export interface AssistantQuestionEntry extends AssistantQuestion {
  type: 'question'
}

export interface AssistantErrorEntry {
  type:      'error'
  code:      AssistantErrorCode
  /** What the LLM's provider said went wrong. */
  message?:  string
  retryable: boolean
}

export type AssistantErrorCode = 'unknown' | 'provider' | 'refusal' | 'max_tokens' | 'too_many_turns'
