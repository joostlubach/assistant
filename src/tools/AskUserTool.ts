import { z } from 'zod'
import { AssistantTool, AssistantToolContext } from '../AssistantTool'

export class AskUserTool extends AssistantTool<typeof schema> {

  public readonly name = 'ask_user'
  public readonly schema = schema
  public readonly description = 'Asks the user a question, with a few options to choose from; they can also type an answer of their own. Their answer comes in their next message, so end your turn after asking, without making changes that depend on it.'

  public execute(input: z.output<typeof schema>, {interact}: AssistantToolContext) {
    interact({type: 'question', ...input})
    return 'The question is shown to the user. End your turn now; their answer will be their next message.'
  }

}

const schema = z.object({
  question: z.string().max(1000).describe('The question, in the language of the user, short and specific.'),
  options:  z.array(z.object({
    label:       z.string().max(100).describe('The answer, as the user would give it.'),
    description: z.string().max(300).optional().describe('What it would mean, if that is not obvious from the label.'),
  })).min(2).max(4).describe('The likely answers, most recommended first.'),
})

export type AssistantQuestion = z.output<typeof schema>
