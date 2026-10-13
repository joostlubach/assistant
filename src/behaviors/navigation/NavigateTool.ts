import { reaction } from 'mobx'
import { matchPath } from 'react-router-dom'
import { z } from 'zod'
import { Assistant } from '../../Assistant'
import {
  AssistantTarget,
  AssistantTool,
  AssistantToolContext,
  AssistantToolError,
} from '../../AssistantTool'
import { NavigationBehavior } from './NavigationBehavior'
import { Page } from './Page'

export class NavigateTool extends AssistantTool<typeof schema, AssistantTarget> {

  constructor(
    private readonly behavior: NavigationBehavior,
    private readonly pages: Page[],
  ) {
    super()
  }

  public readonly name = 'navigate'
  public readonly schema = schema
  public readonly description = 'Takes the user to a page of the app, by its path. The panel stays open. Only use it when the user asks to go somewhere, or to see something.'

  public subject({path}: z.output<typeof schema>) {
    return path
  }

  public target(_input: z.output<typeof schema>, result: AssistantTarget) {
    return result
  }

  public async execute({path}: z.output<typeof schema>, {assistant}: AssistantToolContext): Promise<AssistantTarget> {
    const pathname = path.split(/[?#]/)[0]
    if (!this.pages.some(it => matchPath({path: it.pattern, end: true}, pathname) != null)) {
      throw new AssistantToolError(`There is no page at "${path}".`)
    }

    this.behavior.navigate?.(path)
    await this.waitForPage(assistant)
    return {path}
  }

  private async waitForPage(assistant: Assistant) {
    return new Promise<void>(resolve => {
      let quietTimer: ReturnType<typeof setTimeout> | null = null

      const done = () => {
        dispose()
        if (quietTimer != null) { clearTimeout(quietTimer) }
        clearTimeout(maxTimer)
        resolve()
      }

      const restartQuietTimer = () => {
        if (quietTimer != null) { clearTimeout(quietTimer) }
        quietTimer = setTimeout(done, quietTime)
      }

      const dispose = reaction(
        () => [this.behavior.path, assistant.additionalBehaviors],
        restartQuietTimer,
        {fireImmediately: true},
      )
      const maxTimer = setTimeout(done, maxTime)
    })
  }

}

const schema = z.object({
  path: z.string().startsWith('/').describe('The path of the page, like `/producer/productions/-`.'),
})


const quietTime = 400
const maxTime = 5000
