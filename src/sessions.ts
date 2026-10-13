import { LLMMessage } from './llm/types'
import { AssistantEntry } from './types'

/**
 * Where the assistant stores its sessions. The app implements it with its own data layer.
 */
export interface AssistantSessions {

  /** A stored session, which may still have to be fetched. */
  document(id: AssistantSessionID): AssistantSessionDocument

  /** Stores a new session, and resolves to its ID, or to `null` if it couldn't be stored. */
  create(content: AssistantSessionContent): Promise<AssistantSessionID | null>

  /** The most recent session that isn't archived, to continue where the user left off. */
  latest(): Promise<AssistantSessionID | null>

}

export interface AssistantSessionDocument {
  readonly id:       AssistantSessionID
  readonly data:     AssistantSessionData | null
  readonly fetching: boolean

  fetch(): Promise<void>
  update(data: Partial<AssistantSessionContent & {archived: boolean}>): Promise<void>
  delete(): Promise<void>
}

export interface AssistantSessionData {
  id:        AssistantSessionID
  title:     string | null
  archived:  boolean

  /** Left out of summaries, like in lists. */
  messages?: LLMMessage[]
  entries?:  AssistantEntry[]
  state?:    AssistantSessionState
}

export interface AssistantSessionContent {
  title?:   string | null
  messages: LLMMessage[]
  entries:  AssistantEntry[]
  state?:   AssistantSessionState
}

/** What the behaviors keep for the conversation, by behavior name. */
export type AssistantSessionState = Record<string, unknown>

export type AssistantSessionID = string | number
