import { LLMMessage } from './llm/types'
import { Result } from './Result'
import { AssistantEntry } from './types'

/**
 * Where the assistant stores its sessions. The app implements it with its own data layer.
 */
export interface AssistantSessions {

  /** The most recent session that isn't archived, to continue where the user left off. */
  latest(): Promise<Result<AssistantSessionID | null>>

  /** Stored sessions, most recent first, as summaries without their messages. */
  list(skip: number, take: number): Promise<Result<Session[]>>

  /** A stored session, or `null` if it doesn't exist. */
  load(id: AssistantSessionID): Promise<Result<Session | null>>

  /** Stores a new session, and resolves to its ID. */
  create(content: AssistantSessionContent): Promise<Result<AssistantSessionID>>

  save(id: AssistantSessionID, content: Partial<AssistantSessionContent & {archived: boolean}>): Promise<Result>
  delete(id: AssistantSessionID): Promise<Result>

}

export interface Session {
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
