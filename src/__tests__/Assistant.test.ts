import { makeAutoObservable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Assistant, AssistantHost } from '../Assistant'
import { AssistantBehavior } from '../AssistantBehavior'
import { AssistantAttachmentReader } from '../attachments/AssistantAttachmentReader'
import { AssistantAttachment } from '../attachments/AttachmentsContainer'
import { AssistantTarget, AssistantTool } from '../AssistantTool'
import { LLMContentBlock, LLMRequest } from '../llm/types'
import {
  AssistantSessionData,
  AssistantSessionContent,
  AssistantSessionDocument,
  AssistantSessionID,
  AssistantSessions,
} from '../sessions'
import { AssistantUserEntry } from '../types'
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

  describe('attachments', () => {

    it('cannot send the input until its attachments have been read', async () => {
      const read = deferred()
      const reader: AssistantAttachmentReader<'image'> = {
        kind:   'image',
        accept: {'image/png': ['.png']},
        read:   async () => {
          await read.promise
          return {data: null, preview: new Blob(['preview'])}
        },
      }
      const {assistant} = setup([[text('Nice')]], [], {attachmentReaders: [reader]})
      assistant.attachments.attach([new File(['logo'], 'logo.png', {type: 'image/png'})])

      expect(assistant.canSendCurrent).toBe(false)

      read.resolve()
      await settled(assistant)
      expect(assistant.canSendCurrent).toBe(true)
    })

    it('shows the previews of what is sent until it has been uploaded, and then refers to the uploads', async () => {
      const upload = deferred<string>()
      const attachmentBlocks = vi.fn(async () => [text('Attached')])
      const reader: AssistantAttachmentReader<'image'> = {
        kind:   'image',
        accept: {'image/vnd.adobe.photoshop': ['.psd']},
        read:   async () => ({data: null, preview: new Blob(['flattened'])}),
      }
      const {assistant, requests} = setup([[text('Nice')]], [], {
        attachmentReaders: [reader],
        uploadAttachment:  () => upload.promise,
        attachmentBlocks,
      })
      const psd = new File(['layers'], 'design.psd')
      assistant.attachments.attach([psd])
      await settled(assistant)

      const sending = assistant.sendCurrent()
      expect((assistant.entries[0] as AssistantUserEntry).images).toEqual([expect.any(Blob)])

      upload.resolve('media:12')
      await sending

      expect(assistant.entries[0]).toEqual({type: 'user', text: '', images: ['media:12']})
      expect(attachmentBlocks).toHaveBeenCalledWith([expect.objectContaining({kind: 'image', file: psd, image: 'media:12'})])
      expect(requests[0].messages[0].content).toContainEqual(text('Attached'))
    })

    it('keeps showing the previews of attachments that are only kept in memory, but does not store them', async () => {
      const attachmentBlocks = vi.fn(async () => [])
      const {assistant, sessions} = setup([[text('Nice')]], [], {uploadAttachment: async () => null, attachmentBlocks})
      const logo = readyImage('logo.png')

      await assistant.send('Look', [logo], {images: ['media:3']})
      await settled(assistant)

      expect((assistant.entries[0] as AssistantUserEntry).images).toEqual([logo.preview, 'media:3'])
      expect(attachmentBlocks).toHaveBeenCalledWith([expect.objectContaining({file: logo.file, image: null})])
      expect(sessions.stored.get(1)?.entries?.[0]).toEqual({type: 'user', text: 'Look', images: ['media:3']})
    })

    it('does not store the previews of attachments that could not be uploaded', async () => {
      const {assistant, sessions} = setup([], [], {uploadAttachment: async () => { throw new Error('Upload failed') }})

      await assistant.send('Look', [readyImage('logo.png')])
      await settled(assistant)

      expect(sessions.stored.get(1)?.entries?.[0]).toEqual({type: 'user', text: 'Look', images: []})
    })

  })

  describe('sending', () => {

    it('sends a note to the LLM that is not shown, and shows extra images', async () => {
      const {assistant, requests} = setup([[text('Good choice')]])

      await assistant.send('This one', [], {images: ['media:3'], llmNote: 'I chose photo3.'})

      expect(assistant.entries[0]).toEqual({type: 'user', text: 'This one', images: ['media:3']})
      expect(requests[0].messages[0].content.slice(1)).toEqual([text('This one'), text('I chose photo3.')])
    })

  })

  describe('failed attachments', () => {

    it('reports attachments that could not be sent, which cannot be retried', async () => {
      const question = {question: 'Which logo?', options: [{label: 'A'}, {label: 'B'}]}
      const uploadAttachment = vi.fn(async () => { throw new Error('Upload failed') })
      const {assistant, requests} = setup([[toolUse('t1', 'ask_user', question)]], [], {uploadAttachment})
      await assistant.send('Make a logo')

      // After a question, the conversation ends in tool results, which could otherwise be continued.
      await assistant.send('This one', [readyImage('logo.png')])

      expect(assistant.status).toBe('failed')
      expect(assistant.entries[assistant.entries.length - 1]).toEqual({type: 'error', code: 'attachments', message: 'Upload failed', retryable: false})

      await assistant.retry()
      expect(requests).toHaveLength(1)
    })

    it('reports a failure of a behavior to add to the attachments in the same way', async () => {
      const failing = behavior('failing', {attachmentBlocks: async () => { throw new Error('Unreadable') }})
      const {assistant} = setup([], [failing])

      await assistant.send('Look', [readyImage('logo.png')])

      expect(assistant.entries[assistant.entries.length - 1]).toMatchObject({code: 'attachments', message: 'Unreadable', retryable: false})
    })

  })

  describe('attachment blocks of behaviors', () => {

    it('sends what behaviors add of the attachments after what the host sends', async () => {
      const general = behavior('general', {attachmentBlocks: async () => [text('General')]})
      const specific = behavior('specific', {attachmentBlocks: async attachments => [text(`Specific: ${attachments[0].file.name}`)]})
      const {assistant, requests} = setup([[text('Nice')]], [general], {attachmentBlocks: async () => [text('Host')]})
      assistant.addBehavior(specific)

      await assistant.send('Look', [readyImage('logo.png')])

      expect(requests[0].messages[0].content.slice(1)).toEqual([text('Host'), text('General'), text('Specific: logo.png'), text('Look')])
    })

    it('asks nothing of behaviors without attachments', async () => {
      const attachmentBlocks = vi.fn(async () => [text('Unexpected')])
      const {assistant, requests} = setup([[text('Hi')]], [behavior('general', {attachmentBlocks})])

      await assistant.send('Hello')

      expect(attachmentBlocks).not.toHaveBeenCalled()
      expect(requests[0].messages[0].content.slice(1)).toEqual([text('Hello')])
    })

  })

  describe('behavior state', () => {

    it('stores what behaviors keep with the session, by name, and restores it when the session is opened', async () => {
      const general = statefulBehavior('general')
      const specific = statefulBehavior('specific')
      const {assistant, sessions} = setup([[text('Hi')]], [general])
      assistant.addBehavior(specific)

      general.value = 'g1'
      specific.value = 's1'
      await assistant.send('Hello')
      await settled(assistant)
      expect(sessions.stored.get(1)?.state).toEqual({general: 'g1', specific: 's1'})

      assistant.newSession()
      expect(general.value).toBeNull()
      expect(specific.value).toBeNull()

      await assistant.openSession(1)
      expect(general.value).toBe('g1')
      expect(specific.value).toBe('s1')
    })

    it('keeps the state of a behavior that was removed, for when it is added again', async () => {
      const specific = statefulBehavior('specific')
      const {assistant, sessions} = setup([[text('One')], [text('Two')]])
      const remove = assistant.addBehavior(specific)

      specific.value = 'kept'
      remove()
      await assistant.send('Elsewhere')
      await settled(assistant)
      expect(sessions.stored.get(1)?.state).toEqual({specific: 'kept'})

      specific.value = null
      assistant.addBehavior(specific)
      expect(specific.value).toBe('kept')
    })

    it('keeps the stored state of behaviors that are not active', async () => {
      const {assistant, sessions} = setup([[text('Hi')]])
      sessions.store({...session(1, 'Earlier'), state: {elsewhere: 'stored'}})

      await assistant.openSession(1)
      await assistant.send('More')
      await settled(assistant)

      expect(sessions.stored.get(1)?.state).toEqual({elsewhere: 'stored'})
    })

    it('stores no state when no behavior keeps any', async () => {
      const {assistant, sessions} = setup([[text('Hi')]])

      await assistant.send('Hello')
      await settled(assistant)

      expect(sessions.created[0]).not.toHaveProperty('state')
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

function setup(responses: LLMContentBlock[][], generalBehaviors: AssistantBehavior[] = [], overrides: Partial<AssistantHost> = {}) {
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
    uploadAttachment: async attachment => `image:${attachment.file.name}`,
    attachmentBlocks: async () => [],
    ...overrides,
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

function readyImage(name: string): AssistantAttachment {
  const file = new File(['image'], name, {type: 'image/png'})
  return {kind: 'image', file, status: 'ready', data: null, preview: file, error: null}
}

function statefulBehavior(name: string) {
  return {
    ...behavior(name),
    value:        null as unknown,
    restoreState: function (state: unknown) { this.value = state },
    saveState:    function () { return this.value },
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
