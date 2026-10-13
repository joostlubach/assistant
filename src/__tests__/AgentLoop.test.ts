import { describe, expect, it, vi } from 'vitest'
import { AgentLoop, AgentLoopDelegate, AgentToolRun } from '../llm/AgentLoop'
import { LLMContentBlock, LLMRequest, LLMStopReason, LLMToolUseBlock } from '../llm/types'
import { eventStream, responseEvents, text, toolUse } from './helpers'

describe('AgentLoop', () => {

  it('ends when a response calls no tools', async () => {
    const {loop, requests} = setup([[text('Hi')]])
    loop.append(userMessage('Hello'))

    expect(await loop.run(new AbortController().signal)).toBe('done')
    expect(requests).toHaveLength(1)
    expect(loop.messages).toEqual([userMessage('Hello'), {role: 'assistant', content: [text('Hi')]}])
  })

  it('sends the results of all tool calls back in a single message, followed by extra content', async () => {
    const {loop, requests} = setup([
      [toolUse('1', 'a'), toolUse('2', 'b')],
      [text('Done')],
    ], {
      runTool: async block => ({
        result:  {type: 'tool_result', tool_use_id: block.id, content: `ran ${block.name}`},
        extra:   block.id === '2' ? [text('image')] : [],
        endTurn: false,
      }),
      afterToolResults: () => [text('context changed')],
    })
    loop.append(userMessage('Go'))

    expect(await loop.run(new AbortController().signal)).toBe('done')
    expect(requests).toHaveLength(2)
    expect(requests[1].messages[2]).toEqual({
      role:    'user',
      content: [
        {type: 'tool_result', tool_use_id: '1', content: 'ran a'},
        {type: 'tool_result', tool_use_id: '2', content: 'ran b'},
        text('image'),
        text('context changed'),
      ],
    })
  })

  it('ends after the round of tool calls in which one ends the turn', async () => {
    const {loop, requests} = setup([[toolUse('1', 'ask')], [text('Should not be requested')]], {
      runTool: async block => ({result: {type: 'tool_result', tool_use_id: block.id, content: 'asked'}, endTurn: true}),
    })
    loop.append(userMessage('Go'))

    expect(await loop.run(new AbortController().signal)).toBe('done')
    expect(requests).toHaveLength(1)
    expect(loop.canContinue).toBe(true)
  })

  it('closes the tool uses that did not run when it is aborted', async () => {
    const abortController = new AbortController()
    const {loop} = setup([[toolUse('1', 'a'), toolUse('2', 'b')]], {
      runTool: async block => {
        abortController.abort()
        return {result: {type: 'tool_result', tool_use_id: block.id, content: 'ran'}, endTurn: false}
      },
    })
    loop.append(userMessage('Go'))

    expect(await loop.run(abortController.signal)).toBe('aborted')
    expect(resultsFor(loop.messages, '2')).toEqual([{type: 'tool_result', tool_use_id: '2', content: 'Not run: the turn was interrupted.', is_error: true}])
    expect(loop.canContinue).toBe(true)
  })

  it('closes the tool uses of a response that was cut off', async () => {
    const {loop} = setup([[toolUse('1', 'a')]], {}, 'max_tokens')
    loop.append(userMessage('Go'))

    expect(await loop.run(new AbortController().signal)).toBe('max_tokens')
    expect(resultsFor(loop.messages, '1')).toHaveLength(1)
    expect(loop.canContinue).toBe(true)
  })

  it('stops a runaway loop', async () => {
    const {loop, requests} = setup(Array.from({length: 50}, (_, index) => [toolUse(`${index}`, 'a')]))
    loop.append(userMessage('Go'))

    expect(await loop.run(new AbortController().signal)).toBe('too_many_turns')
    expect(requests).toHaveLength(40)
  })

  it('reports a refusal, after which the conversation cannot continue', async () => {
    const {loop} = setup([[text('No')]], {}, 'refusal')
    loop.append(userMessage('Go'))

    expect(await loop.run(new AbortController().signal)).toBe('refusal')
    expect(loop.canContinue).toBe(false)
  })

  it('closes dangling tool uses of a conversation that it loads', () => {
    const {loop} = setup([])
    loop.load([userMessage('Go'), {role: 'assistant', content: [toolUse('1', 'a')]}])

    expect(resultsFor(loop.messages, '1')).toHaveLength(1)
    expect(loop.canContinue).toBe(true)
  })

  it('keeps its messages to itself', () => {
    const {loop} = setup([])
    const messages = [userMessage('Go')]
    loop.load(messages)
    loop.append(userMessage('More'))
    loop.messages.push(userMessage('Not added'))

    expect(messages).toHaveLength(1)
    expect(loop.messages).toHaveLength(2)
  })

})

function setup(responses: LLMContentBlock[][], delegate: Partial<AgentLoopDelegate> = {}, stopReason?: LLMStopReason) {
  const requests: LLMRequest[] = []
  let index = 0

  const transport = vi.fn(async (request: LLMRequest) => {
    requests.push(structuredClone(request))
    const content = responses[index++] ?? [text('(no more responses)')]
    const reason = stopReason ?? (content.some(it => it.type === 'tool_use') ? 'tool_use' : 'end_turn')
    return eventStream(responseEvents(content, reason))
  })

  const loop = new AgentLoop(transport, {
    system:  () => 'system',
    tools:   () => [],
    runTool: async (block: LLMToolUseBlock): Promise<AgentToolRun> => ({
      result:  {type: 'tool_result', tool_use_id: block.id, content: 'ok'},
      endTurn: false,
    }),
    ...delegate,
  })

  return {loop, requests, transport}
}

function userMessage(content: string) {
  return {role: 'user' as const, content: [text(content)]}
}

function resultsFor(messages: AgentLoop['messages'], toolUseId: string) {
  return messages.flatMap(it => it.content).filter(it => it.type === 'tool_result' && it.tool_use_id === toolUseId)
}
