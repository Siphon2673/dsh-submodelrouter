import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ScriptedAdapter, PROVIDER } from '../helpers/harness.js'
import * as Router from '../../index.js'

/** Scripted adapter that delegates once for the durability prompt, then answers. */
class DelegatingAdapter extends ScriptedAdapter {
  constructor() {
    super()
    this.delegated = false
  }

  /** @inheritdoc */
  async *stream(options) {
    const promptText = options.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (!this.delegated && promptText.includes('delegate now')) {
      this.delegated = true
      const id = ToolCallId('durable-call')
      const args = JSON.stringify({ description: 'durable', prompt: 'persist me', effort: 'high' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'subagent', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'subagent', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* super.stream(options)
  }
}

/**
 * Mount the production host topology with persistence at a caller-owned root.
 * @param {string} root - persistence root.
 * @param {boolean} withRouter - whether the router plugin is mounted.
 * @returns {Promise<any>} context and harness.
 */
async function mountContext(root, withRouter) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.llm.registerAdapter([PROVIDER], new DelegatingAdapter())
  await ctx.plugin(Persistence, { root, compression: 'none' })
  await ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 8 })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(ToolSubagent, {
    provider: 'spawn',
    toolName: 'subagent',
    modelSelection: true,
    modelDiscovery: true,
  })
  let routerFiber
  if (withRouter) {
    routerFiber = await ctx.plugin(Router, {
      high: { provider: PROVIDER, model: 'high-model', reasoningEffort: 'high' },
    })
  }
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, routerFiber }
}

test('parent and child Sessions restore after uninstall without a plugin projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-smr-durable-'))
  try {
    const first = await mountContext(root, true)
    const parent = await first.harness.create(SessionId('durable-parent'), {
      provider: PROVIDER,
      model: 'parent-model',
    })
    parent.session.append('subagent/model-selection-policy', {
      allowedModels: [{ provider: PROVIDER, model: 'high-model' }],
    })
    parent.send(
      {
        id: MessageId('parent-message'),
        content: [{ type: 'text', text: 'delegate now' }],
        source: { kind: 'user' },
        role: 'user',
      },
      'next-turn',
      true,
    )
    await parent.whenIdle()

    const parentEvents = parent.session.snapshotEvents()
    const call = parentEvents.find((event) => event.type === 'tool/call')
    assert.equal(call.data.name, 'subagent')
    const result = parentEvents.find((event) => event.type === 'tool/result')
    const resultText = result.data.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const match = resultText.match(/started subagent ([0-9a-f-]+) \(effort: high\)/)
    assert.ok(match, resultText)
    const childId = match[1]
    assert.equal(first.ctx.agents.get(childId)?.options.model, 'high-model')
    await first.routerFiber.dispose()
    await first.ctx.fiber.dispose()

    const second = await mountContext(root, false)
    try {
      const resumedParent = await second.ctx.agents.resume({ resumeSessionId: SessionId('durable-parent') })
      const restoredParentEvents = resumedParent.agent.session.snapshotEvents()
      assert.ok(restoredParentEvents.some((event) => event.type === 'tool/result'))
      const restoredCall = restoredParentEvents.find((event) => event.type === 'tool/call')
      assert.equal(restoredCall.data.name, 'subagent')

      const resumedChild = await second.ctx.agents.resume({
        resumeSessionId: SessionId(childId),
        parentAgent: resumedParent.agent,
      })
      const restoredChildEvents = resumedChild.agent.session.snapshotEvents()
      assert.equal(resumedChild.agent.id, childId)
      assert.ok(restoredChildEvents.some((event) => event.type === 'user/message'))
      const header = restoredChildEvents.find((event) => event.type === 'request/header')
      assert.ok(header, 'the child history records its request header')
      assert.equal(header.data.header.config.provider, PROVIDER)
      assert.equal(header.data.header.config.model, 'high-model')
      assert.equal(header.data.header.config.reasoningEffort, 'high')
      await resumedChild.dispose()
      await resumedParent.dispose()
    } finally {
      await second.ctx.fiber.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
