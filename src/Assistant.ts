import { sortBy, truncate, uniq } from 'lodash'
import Logger from 'logger'
import { action, computed, makeObservable, observable, runInAction, toJS } from 'mobx'
import { Disposable } from 'react-util'
import { bindMethods, errorMessage } from 'ytil'
import { AssistantBehavior } from './AssistantBehavior'
import { AssistantConfig } from './AssistantConfig'
import {
  AssistantTarget,
  AssistantTool,
  AssistantToolContext,
  AssistantToolOutput,
} from './AssistantTool'
import { AssistantAttachment, AttachmentsContainer } from './AttachmentsContainer'
import { thumbnailURL } from './images/thumbnailURL'
import { AgentLoop, AgentLoopTransport, AgentToolRun } from './llm/AgentLoop'
import { LLMStreamError } from './llm/readLLMStream'
import { LLMContentBlock, LLMTextBlock, LLMToolUseBlock } from './llm/types'
import { AssistantSessionDocument, AssistantSessionID, AssistantSessions } from './sessions'
import { AskUserTool } from './tools/AskUserTool'
import {
  AssistantEntry,
  AssistantErrorCode,
  AssistantInteraction,
  AssistantReplyEntry,
  AssistantThinkingEntry,
} from './types'

export class Assistant extends Disposable {

  constructor(
    private readonly host: AssistantHost,
    private readonly config: AssistantConfig,
  ) {
    super()

    this.loop = this.createLoop()

    makeObservable(this)
    bindMethods(this)

    this.disposer(() => this.abortController?.abort())
    this.disposer(() => this.attachments.dispose())
  }

  private readonly logger = new Logger('Assistant')

  // #region State

  private abortController: AbortController | null = null

  @observable
  private accessor _entries: AssistantEntry[] = []

  @computed
  public get entries() { return [...this._entries] }

  @observable
  private accessor _status: AssistantStatus = 'idle'
  public get status() { return this._status }

  @action
  private setStatus(status: AssistantStatus) {
    this._status = status
  }

  @computed
  public get running() {
    return this._status === 'running'
  }

  @observable
  public accessor input: string = ''

  @action
  public setInput(draft: string) {
    this.input = draft
  }

  /** What the user is about to send along. */
  public readonly attachments = new AttachmentsContainer()

  @computed
  public get canSend() {
    if (this.running) { return false }
    if (this.loadingCurrentSession) { return false }
    if (this.currentSession?.archived) { return false }
    return true
  }

  @computed
  public get canSendCurrent() {
    if (!this.canSend) { return false }

    const hasDraft = this.input.trim() !== ''
    const hasAttachments = this.attachments.count > 0
    return hasDraft || hasAttachments
  }

  // #endregion

  // #region Starting

  private started: boolean = false

  /**
   * Starts everything up: continues where the user left off. Until then, the assistant is inert.
   */
  public async start() {
    if (this.started) { return }
    this.started = true

    const latest = await this.host.sessions.latest()
    if (latest != null && this.currentSessionId == null) {
      await this.openSession(latest)
    }
  }

  // #endregion

  // #region Behaviors

  /**
   * The behaviors that are active throughout, from the config, sorted by name.
   */
  @computed
  public get generalBehaviors(): AssistantBehavior[] {
    return sortBy(this.config.generalBehaviors, it => it.name)
  }

  /**
   * Behaviors added by the part of the app that the user is in.
   */
  @observable.shallow
  private accessor _additionalBehaviors = new Set<AssistantBehavior>()

  /**
   * The behaviors added by the part of the app that the user is in, sorted by name.
   */
  @computed
  public get additionalBehaviors(): AssistantBehavior[] {
    return sortBy([...this._additionalBehaviors], it => it.name)
  }

  /**
   * All behaviors, general ones first. This is the order of the prompt.
   */
  @computed
  public get behaviorsGeneralFirst(): AssistantBehavior[] {
    return [...this.generalBehaviors, ...this.additionalBehaviors]
  }

  /**
   * All behaviors, additional ones first. The most specific one gets to go first, like for revealing.
   */
  @computed
  public get behaviorsAdditionalFirst(): AssistantBehavior[] {
    return [...this.additionalBehaviors, ...this.generalBehaviors]
  }

  /**
   * The additional behaviors when something was sent last. Used to derive "new" behaviors for better contextual hinting.
   */
  @observable.ref
  private accessor _behaviorsAtLastSend: Set<AssistantBehavior> = new Set()

  /**
   * The additional behaviors that were added since the last send.
   */
  @computed
  public get newBehaviors(): AssistantBehavior[] {
    return this.additionalBehaviors.filter(it => !this._behaviorsAtLastSend.has(it))
  }

  @action
  public addBehavior(behavior: AssistantBehavior) {
    this._additionalBehaviors.add(behavior)
    return this.removeBehavior.bind(this, behavior)
  }

  @action
  public removeBehavior(behavior: AssistantBehavior) {
    this._additionalBehaviors.delete(behavior)
  }

  /**
   * Gets the full list of currently available tools.
   */
  @computed
  private get tools(): ToolEntry[] {
    return [
      ...coreTools.map(it => [it, null] as [AssistantTool, null]),
      ...this.behaviorsGeneralFirst.flatMap(behavior => behavior.tools.map(it => [it, behavior] as [AssistantTool, AssistantBehavior])),
    ]
  }

  @computed
  public get hints(): string[] {
    return this.hintsFor(this.behaviorsAdditionalFirst)
  }

  @computed
  public get newHints(): string[] {
    return this.hintsFor(this.newBehaviors)
  }

  private hintsFor(behaviors: AssistantBehavior[]) {
    return uniq(behaviors.flatMap(it => it.hints?.() ?? [])).slice(0, maxHints)
  }

  // #endregion

  // #region Actions

  public async send(text: string, attachments: AssistantAttachment[] = []) {
    return await this.appendAndRun(text, attachments)
  }

  public async sendCurrent() {
    if (!this.canSendCurrent) { return }

    const text = this.input.trim()
    const attachments = this.attachments.take()
    runInAction(() => { this.input = '' })
    await this.appendAndRun(text, attachments)
  }

  @action
  public async retry() {
    if (!this.canSend) { return }
    if (this._entries.length === 0) { return }

    const last = this._entries[this._entries.length - 1]
    if (last.type !== 'error' || !last.retryable) { return }

    this._entries = this._entries.slice(0, -1)
    await this.runTurn()
  }

  public stop() {
    this.abortController?.abort()
  }

  public reveal(target: AssistantTarget) {
    for (const behavior of this.behaviorsAdditionalFirst) {
      if (behavior.reveal?.(target)) {
        return
      }
    }
  }

  // #endregion

  // #region Sessions

  @observable.ref
  private accessor _currentSessionDocument: AssistantSessionDocument | null = null

  @computed
  public get currentSessionId() {
    if (this._currentSessionDocument == null) { return null }
    return this._currentSessionDocument.id
  }

  @computed
  public get loadingCurrentSession() {
    if (this._currentSessionDocument == null) { return false }
    return this._currentSessionDocument.fetching
  }

  @computed
  public get currentSession() {
    if (this._currentSessionDocument == null) { return null }
    return this._currentSessionDocument.data
  }

  @computed
  public get isCurrentSessionArchived() {
    return this.currentSession?.archived ?? false
  }

  /**
   * Starts a new session. That is, it just prepares for it. It's only started when something is sent.
   */
  @action
  public newSession() {
    this.reset()
    this._currentSessionDocument = null
  }

  public async openSession(id: AssistantSessionID) {
    if (this.running) { return }
    if (id === this.currentSessionId) { return }

    this.reset()
    
    const conversation = this.conversation
    const document = this.host.sessions.document(id)
    
    runInAction(() => {
      this._currentSessionDocument = document
    })
    await document.fetch()
    
    if (conversation === this.conversation) {
      this.restore(document.data)
    }
  }

  @action
  private restore(session: AssistantSessionDocument['data']) {
    this.loop.load(toJS(session?.messages ?? []))
    this._entries = session?.entries ?? []
  }

  public async archiveSession(id: AssistantSessionID) {
    if (id === this.currentSessionId) {
      await this.wrapUpCurrentTurn()
      await this.savingCurrentSession
    }

    const document = this.host.sessions.document(id)
    await document.update({archived: true})
  }

  public async unarchiveSession(id: AssistantSessionID) {
    const document = this.host.sessions.document(id)
    await document.update({archived: false})
  }

  public async removeSession(id: AssistantSessionID) {
    const current = id === this.currentSessionId
    if (current) {
      await this.wrapUpCurrentTurn()
      await this.savingCurrentSession
    }

    const document = this.host.sessions.document(id)
    await document.delete()

    if (current) {
      this.newSession()
    }
  }

  private async wrapUpCurrentTurn() {
    this.stop()
    await this.turn
  }

  @action
  private reset() {
    this.stop()
    this.conversation++
    this.loop.reset()
    this.lastContext = null
    this._behaviorsAtLastSend = new Set()
    this._entries = []
    this._status = 'idle'
  }

  // #endregion

  // #region Session saving

  private savingCurrentSession: Promise<void> | null = null
  private saveAgain: boolean = false

  private saveCurrentSession() {
    if (this.savingCurrentSession != null) {
      this.saveAgain = true
    } else {
      this.savingCurrentSession = this.saveLoop().finally(() => {
        this.savingCurrentSession = null
      })
    }
  }

  private async saveLoop() {
    do {
      this.saveAgain = false
      try {
        await this.saveNow()
      } catch (error) {
        const message = errorMessage(error)
        this.logger.error(message, error)
      }
    } while (this.saveAgain)
  }

  private async saveNow() {
    if (this._entries.length === 0) { return }

    if (this._currentSessionDocument == null) {
      await this.createSession()
    } else {
      await this._currentSessionDocument.update({
        messages: this.loop.messages,
        entries:  toJS(this._entries),
      })
    }
  }

  private async createSession() {
    const conversation = this.conversation
    const userEntries = this._entries.filter(it => it.type === 'user')

    const id = await this.host.sessions.create({
      title:    userEntries.length > 0 ? truncate(userEntries[0].text, {length: 100}) : null,
      messages: this.loop.messages,
      entries:  toJS(this._entries),
    })
    if (conversation !== this.conversation) {
      // A new conversation was started in the mean time.
      return
    }
    if (id == null) {
      this.logger.warning(`Unable to create session`)
      return
    }

    runInAction(() => {
      this._currentSessionDocument = this.host.sessions.document(id)
    })
  }

  // #endregion

  // #region Running

  private readonly loop: AgentLoop

  private turn: Promise<void> | null = null
  private conversation: number = 0

  private async appendAndRun(text: string, attachments: AssistantAttachment[] = []) {
    if (!this.canSend) { return }
    runInAction(() => {
      this._behaviorsAtLastSend = new Set(this._additionalBehaviors)
    })

    const images = await Promise.all(attachments.map(it => thumbnailURL(it.file)))
    this.addEntry({type: 'user', text, images})

    await this.runTurn(async () => {
      const context = this.contextText()
      this.lastContext = context
      this.loop.append({
        role:    'user',
        content: [
          {type: 'text', text: context},
          ...await this.host.attachmentBlocks(attachments),
          ...(text === '' ? [] : [{type: 'text' as const, text}]),
        ],
      })
      this.saveCurrentSession()
    })
  }

  private async runTurn(prepare?: () => Promise<void>) {
    const turn = this.runTurnImpl(prepare)
    this.turn = turn
    try {
      await turn
    } finally {
      if (this.turn === turn) {
        this.turn = null 
      }
    }
  }

  private async runTurnImpl(prepare?: () => Promise<void>) {
    const conversation = this.conversation

    const abortController = new AbortController()
    this.abortController = abortController
    this.setStatus('running')

    try {
      await prepare?.()
      const end = await this.loop.run(abortController.signal)
      if (end === 'refusal' || end === 'max_tokens' || end === 'too_many_turns') {
        this.addError(end)
      }
      this.setStatus('idle')
    } catch (error) {
      this.loop.closeDanglingToolUses()
      if (abortController.signal.aborted) {
        this.setStatus('idle')
      } else if (error instanceof LLMStreamError) {
        this.addError('provider', error.message)
        this.setStatus('failed')
      } else {
        console.error(error)
        this.addError('unknown')
        this.setStatus('failed')
      }
    } finally {
      this.abortController = null
      if (conversation === this.conversation) { 
        this.saveCurrentSession() 
      }
    }
  }

  private createLoop() {
    // The entries that show the text and reasoning blocks of the current response, by block index.
    const shown = new Map<number, number>()

    return new AgentLoop(this.host.transport, {
      system:           () => [this.config.prompt, ...this.behaviorsGeneralFirst.map(it => it.prompt)].join('\n\n'),
      tools:            () => this.tools.map(([tool]) => tool.definition),
      runTool:          block => this.runTool(block),
      afterToolResults: () => this.contextUpdate(),
      onResponseStart:  () => shown.clear(),
      onText:           (index, type, text) => this.showBlock(shown, index, type === 'text' ? 'assistant' : 'thinking', text),
      checkpoint:       () => this.saveCurrentSession(),
    })
  }

  @action
  private showBlock(shown: Map<number, number>, blockIndex: number, type: 'assistant' | 'thinking', text: string) {
    const entryIndex = shown.get(blockIndex)
    if (entryIndex != null) {
      (this._entries[entryIndex] as AssistantReplyEntry | AssistantThinkingEntry).text = text
    } else if (text.trim() !== '') {
      shown.set(blockIndex, this._entries.length)
      this.addEntry({type, text})
    }
  }

  private async runTool(block: LLMToolUseBlock): Promise<AgentToolRun> {
    const found = this.tools.find(([tool]) => tool.name === block.name)
    if (found == null) {
      return {
        result: {
          type:        'tool_result', 
          tool_use_id: block.id, 
          content:     `Tool "${block.name}" is not available here: the user is no longer in the part of the app it belongs to.`, 
          is_error:    true,
        }, 
        endTurn: false,
      }
    }

    const [tool, behavior] = found

    const asked: {interaction?: AssistantInteraction} = {}
    const base: AssistantToolContext = {
      assistant: this,
      interact:  interaction => { asked.interaction = interaction },
    }

    // Allow the behavior to augment the context.
    const context = behavior != null ? behavior.toolContext(base) : base

    const run = await tool.run(block.input, context)
    const {subject, output, target, error} = run

    if (target != null) {
      for (const behavior of this.behaviorsGeneralFirst) {
        behavior.modifyToolTarget?.(target)
      }
    }

    const interaction = error ? null : asked.interaction ?? null
    if (interaction != null) {
      this.addEntry(interaction)
    } else {
      this.addEntry({type: 'tool', tool: block.name, subject, target, error})
    }

    return {
      ...toolResult(block.id, output, error),
      // The response comes as the user's next message.
      endTurn: interaction != null,
    }
  }

  // #endregion

  // #region Context

  /** The context as last sent to the LLM. */
  private lastContext: string | null = null

  private contextText() {
    const lines = this.behaviorsGeneralFirst.flatMap(it => it.context())
    return `<context>\n${lines.join('\n')}\n</context>`
  }

  /** Tells the LLM when the context changed during its turn, like when the user went elsewhere. */
  private contextUpdate(): LLMTextBlock[] {
    const context = this.contextText()
    if (context === this.lastContext) { return [] }

    this.lastContext = context
    return [{type: 'text', text: `The context changed:\n${context}`}]
  }

  @action
  private addEntry(entry: AssistantEntry) {
    this._entries = [...this._entries, entry]
  }

  /**
   * The conversation can only be continued after a message of the user's (or tool results): LLMs don't accept one
   * ending in their own message.
   */
  private addError(code: AssistantErrorCode, message?: string) {
    this.addEntry({type: 'error', code, message, retryable: this.loop.canContinue})
  }

  // #endregion

}

/**
 * What the assistant needs from the app: how to reach the LLM, where to store sessions, and how to send attachments.
 */
export interface AssistantHost {
  transport: AgentLoopTransport
  sessions:  AssistantSessions

  /** Builds the blocks that show the attachments to the LLM, like after uploading them. */
  attachmentBlocks(attachments: AssistantAttachment[]): Promise<LLMContentBlock[]>
}

export type AssistantStatus = 'idle' | 'running' | 'failed'

export type ToolEntry = [
  tool: AssistantTool<any, any, any>, 
  behavior: AssistantBehavior | null
]

const coreTools: AssistantTool[] = [
  new AskUserTool(),
]

const maxHints = 4

/**
 * A tool result can only hold text, so other output, like images, follows the results of the turn, marked with the
 * tool use it belongs to.
 */
function toolResult(toolUseId: string, output: AssistantToolOutput, error: boolean): Omit<AgentToolRun, 'endTurn'> {
  if (typeof output === 'string') {
    return {
      result: {type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: error || undefined},
    }
  }

  return {
    result: {type: 'tool_result', tool_use_id: toolUseId, content: `The output follows the tool results, under "Output of ${toolUseId}".`, is_error: error || undefined},
    extra:  [{type: 'text', text: `Output of ${toolUseId}:`}, ...output],
  }
}
