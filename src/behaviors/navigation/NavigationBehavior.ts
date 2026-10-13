import { action, observable } from 'mobx'
import { NavigateFunction } from 'react-router-dom'
import { AssistantBehavior } from '../../AssistantBehavior'
import {
  AssistantTarget as ToolTarget,
  AssistantTool,
  AssistantToolContext as ToolContext,
} from '../../AssistantTool'
import { NavigateTool } from './NavigateTool'
import { Page, pageList } from './Page'

/**
 * Knows where the user is, and takes them to the pages of the app. Active everywhere.
 */
export class NavigationBehavior implements AssistantBehavior {

  constructor(
    options: NavigationBehaviorOptions,
  ) {
    this.prompt = navigationPrompt(options.pages)
    this.tools = [new NavigateTool(this, options.pages)]
  }

  public readonly name = 'navigation'
  public readonly prompt: string
  public readonly tools: AssistantTool<any, any, any>[]

  @observable
  private accessor _path: string | undefined = undefined
  public get path() { return this._path }
  
  private _navigate: NavigateFunction | undefined = undefined
  public get navigate() { return this._navigate }

  @action
  public connectRouter(path: string, navigate: NavigateFunction) {
    if (path !== this.path) {
      this._path = path
    }
    this._navigate = navigate
  }

  public context() {
    return [
      `The user is on page \`${this.path}\`${document.title === '' ? '' : ` ("${document.title}")`}.`,
    ]
  }

  public toolContext(base: ToolContext) {
    return base
  }

  public modifyToolTarget(target: ToolTarget) {
    target.path ??= this.path
  }

  public reveal(target: ToolTarget) {
    if (target.path == null || target.path === this.path) { return false }

    this.navigate?.(target.path)
    return true
  }

}

export interface NavigationBehaviorOptions {
  pages: Page[]
}

function navigationPrompt(pages: Page[]) {
  return `
# Finding your way in the app

You can take the user anywhere in the app with \`navigate\`. When the user asks where something is, or to see or open something, take them there, rather than describing how to get there.

Pages of the app, by path:

${pageList(pages)}

Some parts of the app give you more to work with when the user is there. When the user asks for help with something that belongs to such a part, and they are elsewhere, take them there first; you get the instructions and tools for it as soon as the page is open.
`.trim()
}
