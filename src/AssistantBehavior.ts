import { AssistantTarget, AssistantTool, AssistantToolContext } from './AssistantTool'
import { AssistantUploadedAttachment } from './attachments/AttachmentsContainer'
import { LLMContentBlock } from './llm/types'

/**
 * What the assistant knows and can do in a part of the app: a section of the system prompt, and the tools that go
 * with it. A behavior is active while its part of the app is shown, and the assistant combines all active ones.
 */
export interface AssistantBehavior<C extends AssistantToolContext = any> {

  /** Identifies the behavior, and orders it in the prompt. */
  readonly name: string

  /** Shows the user what the assistant is helping with. */
  label?(): string

  /** Goes with the label. Its meaning is up to the app, like the name of an icon. */
  readonly icon?: string

  /** Suggestions of what the user could ask here, in their language, most useful first. */
  hints?(): string[]

  /** A section of the system prompt. It should be static, so that it is cached along with the tools. */
  readonly prompt: string

  readonly tools: Array<AssistantTool<any, any, C>>

  /** What the user sees right now, sent along with each message. */
  context(): string[]

  toolContext(base: AssistantToolContext): C

  /** Completes the target of a tool call, like with the page it was made on. */
  modifyToolTarget?(target: AssistantTarget): void

  /**
   * Adds to what is sent of the attachments, after what the host sends, like how its tools can use them. It should name
   * the files it is about, as there may be more than one.
   */
  attachmentBlocks?(attachments: AssistantUploadedAttachment[]): Promise<LLMContentBlock[]>

  /** Takes the user to a target of one of its tools, if it is shown here. */
  reveal?(target: AssistantTarget): boolean

  /**
   * Takes on what it kept for the conversation, or `null` for a conversation without it. Called when it is added, and
   * whenever another conversation is shown.
   */
  restoreState?(state: unknown | null): void

  /**
   * What it keeps for the conversation, stored with its session under the name of the behavior. It should be small
   * and plain: keep files and the like in memory, and refer to them here.
   */
  saveState?(): unknown

}
