import { AssistantBehavior } from './AssistantBehavior'

/**
 * What the assistant is in a part of the app: its instructions, and the behaviors it has throughout.
 */
export interface AssistantConfig {
  /** The system prompt, before the sections of the behaviors. */
  prompt: string

  /** Active throughout. They come first in the prompt, and reveal last. */
  generalBehaviors: AssistantBehavior[]

  /** The most requests to the LLM for one message of the user's, as a safeguard against runaway loops. By default 40. */
  maxTurns?: number
}
