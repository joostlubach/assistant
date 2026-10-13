import { z } from 'zod'
import type { Assistant } from './Assistant'
import { LLMImageBlock, LLMTextBlock, LLMTool } from './llm/types'
import { AssistantInteraction } from './types'

/**
 * A tool the assistant can call. Tools run here, in the app, so that what they do shows up right away. Each behavior
 * brings its own tools, with a context of its own.
 */
export abstract class AssistantTool<S extends z.ZodType = z.ZodType, R = unknown, C extends AssistantToolContext = AssistantToolContext> {

  public abstract readonly name: string
  public abstract readonly description: string
  public abstract readonly schema: S

  public abstract execute(input: z.output<S>, context: C): R | Promise<R>

  /**
   * What the call is about, like the ID of a component, to show it in the conversation.
   */
  public subject(_input: z.output<S>, _context: C): string | null {
    return null
  }

  /**
   * What the call changed or looked at, so that the user can be taken there from the conversation.
   */
  public target(_input: z.output<S>, _result: R, _context: C): AssistantTarget | null {
    return null
  }

  public get definition(): LLMTool {
    const {$schema, ...schema} = z.toJSONSchema(this.schema, {io: 'input', unrepresentable: 'any'})
    return {
      name:         this.name,
      description:  this.description,
      input_schema: schema,
    }
  }

  /**
   * Validates the input and runs the tool. Anything that goes wrong is reported back to the LLM rather than thrown.
   */
  public async run(rawInput: unknown, context: C): Promise<AssistantToolRun> {
    const parsed = this.schema.safeParse(rawInput)
    if (!parsed.success) {
      return {subject: null, target: null, output: `Invalid input:\n${z.prettifyError(parsed.error)}`, error: true}
    }

    const subject = this.subject(parsed.data, context)
    try {
      const result = await this.perform(parsed.data, context)
      const target = this.target(parsed.data, result, context)
      return {subject, target, output: this.serialize(result, context), error: false}
    } catch (error) {
      if (!(error instanceof AssistantToolError)) {
        console.error(error)
      }
      return {subject, target: null, output: error instanceof Error ? error.message : String(error), error: true}
    }
  }

  protected async perform(input: z.output<S>, context: C): Promise<R> {
    return await this.execute(input, context)
  }

  protected serialize(result: R, _context: C): AssistantToolOutput {
    if (result instanceof AssistantToolContent) { return result.blocks }
    return typeof result === 'string' ? result : JSON.stringify(result ?? {ok: true})
  }

}

/**
 * What every tool gets to work with. Behaviors extend it with what their tools need.
 */
export interface AssistantToolContext {
  assistant: Assistant

  /** Asks something of the user, like answering a question or uploading a file, which ends the turn. */
  interact: (interaction: AssistantInteraction) => void
}

/**
 * Something in the app that the user can be taken to. Without a path, it is on the page where the call was made.
 */
export interface AssistantTarget {
  path?: string
  area?: string
  ids?:  string[]
}

export type AssistantToolOutput = string | Array<LLMTextBlock | LLMImageBlock>

export interface AssistantToolRun {
  subject: string | null
  target:  AssistantTarget | null
  output:  AssistantToolOutput
  error:   boolean
}

/**
 * Tool output other than text, like an image. Return it from `execute` to have it sent as is.
 */
export class AssistantToolContent {

  constructor(
    public readonly blocks: Array<LLMTextBlock | LLMImageBlock>,
  ) {}

}

/**
 * An error that is meant for the LLM, like an unknown ID.
 */
export class AssistantToolError extends Error {}
