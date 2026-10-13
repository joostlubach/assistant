import { AssistantTarget, AssistantTool, AssistantToolContext } from './AssistantTool'

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

  /** Takes the user to a target of one of its tools, if it is shown here. */
  reveal?(target: AssistantTarget): boolean

}
