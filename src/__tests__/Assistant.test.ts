import { makeAutoObservable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Assistant, AssistantHost } from '../Assistant'
import { AssistantBehavior } from '../AssistantBehavior'
import { AssistantTarget, AssistantTool } from '../AssistantTool'
import { LLMContentBlock, LLMRequest } from '../llm/types'
import {
  AssistantSessionData,
  AssistantSessionContent,
  AssistantSessionDocument,
  AssistantSessionID,
  AssistantSessions,
} from '../sessions'
import { deferred, eventStream, responseEvents, text, toolUse } from './helpers'

describe('Assistant', () => {

  describe('sessions', () => {

    it('creates the session on the first send without interrupting the turn', async () => {
      const {assistant, sessions} = setup([[text('Hi there')]])

      await assistant.send('Hello')
      await settled(assistant)

      expect(assistant.entries).toEqual([
        {type: 'user', text: 'Hello', images: []},
        {type: 'assistant', text: 'Hi there'},
      ])
      expect(assistant.status).toBe('idle')
      expect(assistant.currentSessionId).toBe(1)
      expect(sessions.created).toHaveLength(1)

      // The final save of the turn goes to the session that was created, with the whole conversation.
      expect(sessions.stored.get(1)?.messages).toHaveLength(2)
      expect(sessions.stored.get(1)?.entries).toHaveLength(2)
    })

    it('cannot send while a session is loading', async () => {
      const {assistant, sessions} = setup([])
      sessions.store(session(1, 'Earlier'))
      const fetch = sessions.holdFetch(1)

      const opening = assistant.openSession(1)
      expect(assistant.loadingCurrentSession).toBe(true)
      expect(assistant.canSend).toBe(false)

      fetch.resolve()
      await opening

      expect(assistant.canSend).toBe(true)
      expect(assistant.entries).toEqual(session(1, 'Earlier').entries)
    })

    it('ignores a session that finishes loading after another one was opened', async () => {
      const {assistant, sessions} = setup([])
      sessions.store(session(1, 'First'))
      sessions.store(session(2, 'Second'))
      const first = sessions.holdFetch(1)

      const openingFirst = assistant.openSession(1)
      await assistant.openSession(2)
      first.resolve()
      await openingFirst

      expect(assistant.currentSessionId).toBe(2)
      expect(assistant.entries).toEqual(session(2, 'Second').entries)
    })

    it('starts a new session with an empty conversation', async () => {
      const {assistant, requests} = setup([[text('One')], [text('Two')]])
      await assistant.send('First')
      await settled(assistant)

      assistant.newSession()
      expect(assistant.entries).toEqual([])
      expect(assistant.currentSessionId).toBeNull()

      await assistant.send('Second')
      expect(requests[1].messages).toHaveLength(1)
      expect(requests[1].messages[0].content).toContainEqual(text('Second'))
    })

    it('continues a session that was stored halfway through a turn', async () => {
      const {assistant, sessions, requests} = setup([[text('Continued')]])
      sessions.store({
        ...session(1, 'Halfway'),
        messages: [
          {role: 'user', content: [text('Go')]},
          {role: 'assistant', content: [toolUse('t1', 'something')]},
        ],
      })

      await assistant.openSession(1)
      await assistant.send('Go on')

      const results = requests[0].messages.flatMap(it => it.content).filter(it => it.type === 'tool_result')
      expect(results).toEqual([{type: 'tool_result', tool_use_id: 't1', content: 'Not run: the turn was interrupted.', is_error: true}])
    })

    it('continues where the user left off when it starts', async () => {
      const {assistant, sessions} = setup([])
      sessions.store(session(1, 'Old'))
      sessions.store(session(2, 'Latest'))

      await assistant.start()
      expect(assistant.currentSessionId).toBe(2)

      // Only once.
      assistant.newSession()
      await assistant.start()
      expect(assistant.currentSessionId).toBeNull()
    })

    it('cannot continue an archived session', async () => {
      const {assistant, sessions} = setup([])
      sessions.store({...session(1, 'Archived'), archived: true})

      await assistant.openSession(1)
      expect(assistant.isCurrentSessionArchived).toBe(true)
      expect(assistant.canSend).toBe(false)
    })

  })

  describe('tools', () => {

    it('runs the tools of its behaviors, and completes their targets', async () => {
      const general = behavior('general', {
        modifyToolTarget: target => { target.path ??= '/current' },
      })
      const specific = behavior('specific', {tools: [new EchoTool()]})
      const {assistant, requests} = setup([[toolUse('t1', 'echo', {value: 'hi'})], [text('Done')]], [general])
      assistant.addBehavior(specific)

      await assistant.send('Echo')

      expect(requests[0].tools?.map(it => it.name)).toEqual(['ask_user', 'echo'])
      expect(assistant.entries[1]).toEqual({type: 'tool', tool: 'echo', subject: 'hi', target: {path: '/current', ids: ['hi']}, error: false})
      expect(requests[1].messages[2].content[0]).toEqual({type: 'tool_result', tool_use_id: 't1', content: 'echo: hi'})
    })

    it('tells the LLM about a tool that is no longer available', async () => {
      const {assistant, requests} = setup([[toolUse('t1', 'gone')], [text('Sorry')]])

      await assistant.send('Go')

      expect(requests[1].messages[2].content[0]).toMatchObject({type: 'tool_result', tool_use_id: 't1', is_error: true})
    })

    it('ends its turn when it asks the user something', async () => {
      const question = {question: 'Which one?', options: [{label: 'A'}, {label: 'B'}]}
      const {assistant, requests} = setup([[toolUse('t1', 'ask_user', question)], [text('Should not be requested')]])

      await assistant.send('Go')

      expect(requests).toHaveLength(1)
      expect(assistant.entries[1]).toEqual({type: 'question', ...question})
    })

  })

  describe('behaviors', () => {

    it('puts general behaviors first in the prompt, and lets specific ones reveal first', async () => {
      const revealed: string[] = []
      const general = behavior('general', {prompt: 'General', reveal: () => { revealed.push('general'); return true }})
      const specific = behavior('specific', {prompt: 'Specific', reveal: () => { revealed.push('specific'); return false }})
      const {assistant, requests} = setup([[text('Hi')]], [general])
      assistant.addBehavior(specific)

      await assistant.send('Hello')
      assistant.reveal({path: '/somewhere'})

      expect(requests[0].system).toBe('System\n\nGeneral\n\nSpecific')
      expect(revealed).toEqual(['specific', 'general'])
    })

    it('hints at what the user can ask in the parts of the app they came to since they last asked something', async () => {
      const first = behavior('first', {hints: () => ['First hint']})
      const second = behavior('second', {hints: () => ['Second hint']})
      const {assistant} = setup([[text('Hi')]])
      const removeFirst = assistant.addBehavior(first)

      expect(assistant.newHints).toEqual(['First hint'])
      await assistant.send('Hello')
      expect(assistant.newHints).toEqual([])

      removeFirst()
      assistant.addBehavior(second)
      expect(assistant.newHints).toEqual(['Second hint'])
    })

  })

})

function setup(responses: LLMContentBlock[][], generalBehaviors: AssistantBehavior[] = []) {
  const requests: LLMRequest[] = []
  let index = 0

  const sessions = new FakeSessions()
  const host: AssistantHost = {
    sessions,
    transport: vi.fn(async (request: LLMRequest) => {
      requests.push(structuredClone(request))
      const content = responses[index++] ?? [text('(no more responses)')]
      return eventStream(responseEvents(content, content.some(it => it.type === 'tool_use') ? 'tool_use' : 'end_turn'))
    }),
    attachmentBlocks: async () => [],
  }

  const assistant = new Assistant(host, {prompt: 'System', generalBehaviors})
  return {assistant, sessions, requests}
}

/** Waits for the saves that a turn leaves behind. */
async function settled(assistant: Assistant) {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
  await (assistant as any).savingCurrentSession
}

function behavior(name: string, overrides: Partial<AssistantBehavior> = {}): AssistantBehavior {
  return {
    name:        name,
    prompt:      name,
    tools:       [],
    context:     () => [],
    toolContext: base => base,
    ...overrides,
  }
}

function session(id: number, title: string): AssistantSessionData {
  return {
    id:       id,
    title:    title,
    archived: false,
    messages: [{role: 'user', content: [text(title)]}, {role: 'assistant', content: [text(`Re: ${title}`)]}],
    entries:  [{type: 'user', text: title, images: []}, {type: 'assistant', text: `Re: ${title}`}],
  }
}

class EchoTool extends AssistantTool<typeof echoSchema, string> {

  public readonly name = 'echo'
  public readonly description = 'Echoes'
  public readonly schema = echoSchema

  public execute({value}: z.output<typeof echoSchema>) {
    return `echo: ${value}`
  }

  public subject({value}: z.output<typeof echoSchema>) {
    return value
  }

  public target({value}: z.output<typeof echoSchema>): AssistantTarget {
    return {ids: [value]}
  }

}

const echoSchema = z.object({value: z.string()})

class FakeSessions implements AssistantSessions {

  public readonly stored = new Map<AssistantSessionID, AssistantSessionData>()
  public readonly created: AssistantSessionContent[] = []

  private readonly documents = new Map<AssistantSessionID, FakeSessionDocument>()
  private readonly heldFetches = new Map<AssistantSessionID, Promise<void>>()
  private nextID = 1

  public store(session: AssistantSessionData) {
    this.stored.set(session.id, structuredClone(session))
    this.nextID = Math.max(this.nextID, Number(session.id) + 1)
  }

  /** Keeps the next fetch of a session pending until it is resolved. */
  public holdFetch(id: AssistantSessionID) {
    const fetch = deferred()
    this.heldFetches.set(id, fetch.promise)
    return fetch
  }

  public document(id: AssistantSessionID) {
    let document = this.documents.get(id)
    if (document == null) {
      document = new FakeSessionDocument(this, id)
      this.documents.set(id, document)
    }
    return document
  }

  public async create(content: AssistantSessionContent) {
    this.created.push(structuredClone(content))

    const id = this.nextID++
    this.stored.set(id, {id, title: content.title ?? null, archived: false, ...structuredClone(content)})
    return id
  }

  public async latest() {
    const active = [...this.stored.values()].filter(it => !it.archived)
    return active[active.length - 1]?.id ?? null
  }

  public async waitForFetch(id: AssistantSessionID) {
    const held = this.heldFetches.get(id)
    this.heldFetches.delete(id)
    await held
  }

}

class FakeSessionDocument implements AssistantSessionDocument {

  constructor(
    private readonly sessions: FakeSessions,
    public readonly id: AssistantSessionID,
  ) {
    makeAutoObservable<this, 'sessions'>(this, {sessions: false, id: false})
  }

  public data: AssistantSessionData | null = null
  public fetching: boolean = false

  public async fetch() {
    this.fetching = true
    await this.sessions.waitForFetch(this.id)

    runInAction(() => {
      const stored = this.sessions.stored.get(this.id)
      this.data = stored == null ? null : structuredClone(stored)
      this.fetching = false
    })
  }

  public async update(data: Partial<AssistantSessionContent & {archived: boolean}>) {
    const stored = this.sessions.stored.get(this.id)
    if (stored == null) { return }

    const updated = {...stored, ...structuredClone(data)}
    this.sessions.stored.set(this.id, updated)
    runInAction(() => {
      this.data = {...updated}
    })
  }

  public async delete() {
    this.sessions.stored.delete(this.id)
  }

}
