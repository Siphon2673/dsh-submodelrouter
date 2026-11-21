import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createHarness, contentText, MISSING_PROVIDER, PROVIDER } from '../helpers/harness.js'
import { install } from '../../lib/host.js'

/** A minimal foreign or fork delegation definition. */
function fakeDelegation(name, extra = {}) {
  return defineTool({
    name,
    description: `${name} foreign definition`,
    parameters: { description: { type: 'string', required: true }, prompt: { type: 'string', required: true }, ...extra },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${name} started ${value.subagentId}` }],
    },
    async execute() {
      return { kind: 'activation', subagentId: `${name}-child` }
    },
  })
}

test('mask exposes only effort and tier semantics', async () => {
  const h = await createHarness({ config: { high: { provider: PROVIDER, model: 'high-model' } } })
  try {
    const scope = scopeOf(h.agent.ctx)
    const schema = h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent')
    assert.deepEqual(Object.keys(schema.parameters.properties), ['cwd', 'description', 'prompt', 'effort'])
    assert.deepEqual(schema.parameters.properties.effort.enum, ['normal', 'high'])
    assert.match(schema.description, /`normal` for routine, checkable, or cheap-to-redo work/)
    assert.match(schema.description, /`high` for work whose result is directly trusted/)
    assert.match(schema.description, /Omit `effort` to inherit the parent route/)
    assert.match(schema.description, /warns and starts the child with parent inheritance/)
    assert.doesNotMatch(schema.description, /Supply `provider` and `model` together/)
    assert.doesNotMatch(schema.description, /reasoning_effort/)
    assert.doesNotMatch(schema.description, /shallow/i)
    const discovery = h.ctx.tools.schemas(scope).find((tool) => tool.name === 'list_subagent_models')
    assert.deepEqual(Object.keys(discovery.parameters.properties), [])
  } finally {
    await h.dispose()
  }
})

test('omitted effort inherits the parent route when both tiers are unconfigured', async () => {
  const h = await createHarness({ config: {} })
  try {
    const result = await h.delegate({ description: 'routine', prompt: 'do it' })
    assert.equal(result.isError, false)
    assert.deepEqual(result.value, { kind: 'activation', subagentId: result.value.subagentId })
    assert.equal(contentText(result), `started subagent ${result.value.subagentId}`)
    const child = h.child(result.value.subagentId)
    assert.equal(child.provider, PROVIDER)
    assert.equal(child.model, 'parent-model')
    assert.equal(child.reasoningEffort, undefined)
    assert.equal(h.liveAgents(), 2)
  } finally {
    await h.dispose()
  }
})

test('omitted effort inherits the parent route when one tier is configured', async () => {
  const h = await createHarness({ config: { normal: { provider: PROVIDER, model: 'child-model' } } })
  try {
    const result = await h.delegate({ description: 'routine', prompt: 'do it' })
    assert.equal(result.isError, false)
    assert.equal(contentText(result), `started subagent ${result.value.subagentId}`)
    const child = h.child(result.value.subagentId)
    assert.equal(child.provider, PROVIDER)
    assert.equal(child.model, 'parent-model')
  } finally {
    await h.dispose()
  }
})

test('normal and high select their configured routes and efforts', async () => {
  const h = await createHarness({
    config: {
      normal: { provider: PROVIDER, model: 'child-model' },
      high: { provider: PROVIDER, model: 'high-model', reasoningEffort: 'high' },
    },
    policy: [
      { provider: PROVIDER, model: 'child-model' },
      { provider: PROVIDER, model: 'high-model' },
    ],
  })
  try {
    const normal = await h.delegate({ description: 'normal', prompt: 'do it', effort: 'normal' })
    assert.equal(normal.isError, false)
    assert.equal(contentText(normal), `started subagent ${normal.value.subagentId} (effort: normal)`)
    assert.equal(h.child(normal.value.subagentId).model, 'child-model')

    const high = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(high.isError, false)
    assert.equal(contentText(high), `started subagent ${high.value.subagentId} (effort: high)`)
    const child = h.child(high.value.subagentId)
    assert.equal(child.provider, PROVIDER)
    assert.equal(child.model, 'high-model')
    assert.equal(child.reasoningEffort, 'high')
    assert.equal(h.liveAgents(), 3)
  } finally {
    await h.dispose()
  }
})

test('both tiers may share one route with different efforts', async () => {
  const h = await createHarness({
    config: {
      normal: { provider: PROVIDER, model: 'child-model', reasoningEffort: 'low' },
      high: { provider: PROVIDER, model: 'child-model', reasoningEffort: 'high' },
    },
    policy: [{ provider: PROVIDER, model: 'child-model' }],
  })
  try {
    const normal = await h.delegate({ description: 'normal', prompt: 'do it', effort: 'normal' })
    const high = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(normal.isError, false)
    assert.equal(high.isError, false)
    assert.equal(h.child(normal.value.subagentId).model, 'child-model')
    assert.equal(h.child(normal.value.subagentId).reasoningEffort, 'low')
    assert.equal(h.child(high.value.subagentId).model, 'child-model')
    assert.equal(h.child(high.value.subagentId).reasoningEffort, 'high')
  } finally {
    await h.dispose()
  }
})

test('invalid enum values fail before execution and create no child', async () => {
  const h = await createHarness({ config: { high: { provider: PROVIDER, model: 'high-model' } } })
  try {
    const result = await h.delegate({ description: 'bad', prompt: 'do it', effort: 'medium' })
    assert.equal(result.isError, true)
    assert.equal(result.error.info?.code, 'INVALID_ARGS')
    assert.equal(h.liveAgents(), 1)
  } finally {
    await h.dispose()
  }
})

test('an unauthorized configured route warns and creates one parent-route child', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'high-model' } },
    policy: [{ provider: PROVIDER, model: 'child-model' }],
  })
  try {
    const result = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, false)
    const text = contentText(result)
    assert.match(text, /Warning: effort tier "high" could not be used because its route is not authorized for this Session/)
    assert.match(text, new RegExp(`${result.value.subagentId} started with parent inheritance instead`))
    const child = h.child(result.value.subagentId)
    assert.equal(child.provider, PROVIDER)
    assert.equal(child.model, 'parent-model')
    assert.equal(h.liveAgents(), 2)
  } finally {
    await h.dispose()
  }
})

test('an old Session with no recorded policy uses the suffixed allowlist rejection', async () => {
  const h = await createHarness({ config: { high: { provider: PROVIDER, model: 'high-model' } } })
  try {
    const result = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, false)
    assert.match(contentText(result), /not authorized for this Session/)
    assert.equal(h.child(result.value.subagentId).model, 'parent-model')
  } finally {
    await h.dispose()
  }
})

test('an unsupported reasoning effort warns and creates one parent-route child', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'child-model', reasoningEffort: 'ultra' } },
    policy: [{ provider: PROVIDER, model: 'child-model' }],
  })
  try {
    const result = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, false)
    assert.match(contentText(result), /its reasoning effort is not supported by the model/)
    assert.equal(h.child(result.value.subagentId).model, 'parent-model')
    assert.equal(h.liveAgents(), 2)
  } finally {
    await h.dispose()
  }
})

test('a missing adapter follows the one-fallback policy', async () => {
  const h = await createHarness({
    config: { high: { provider: MISSING_PROVIDER, model: 'model' } },
    policy: [{ provider: MISSING_PROVIDER, model: 'model' }],
  })
  try {
    const result = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, false)
    assert.match(contentText(result), /its provider or model is not currently available/)
    assert.equal(h.child(result.value.subagentId).model, 'parent-model')
    assert.equal(h.liveAgents(), 2)
  } finally {
    await h.dispose()
  }
})

test('an unknown model on the reviewed adapter follows the one-fallback policy', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'missing-model' } },
    policy: [{ provider: PROVIDER, model: 'missing-model' }],
  })
  try {
    const result = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, false)
    assert.match(contentText(result), /its provider or model is not currently available/)
    assert.equal(h.child(result.value.subagentId).model, 'parent-model')
  } finally {
    await h.dispose()
  }
})

test('a cancelled call creates no child and does not fall back', async () => {
  const h = await createHarness({ config: { high: { provider: PROVIDER, model: 'high-model' } } })
  try {
    const controller = new AbortController()
    controller.abort()
    const result = await h.delegate(
      { description: 'high', prompt: 'do it', effort: 'high' },
      { signal: controller.signal },
    )
    assert.equal(result.isError, true)
    assert.match(result.error.info?.code ?? '', /^ABORTED/)
    assert.equal(h.liveAgents(), 1)
  } finally {
    await h.dispose()
  }
})

test('an explicit result matches the pinned fixture', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'high-model' } },
    policy: [{ provider: PROVIDER, model: 'high-model' }],
  })
  try {
    const explicit = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(explicit.isError, false)
    assert.deepEqual(Object.keys(explicit.value).sort(), ['kind', 'subagentId'])
    assert.equal(contentText(explicit), `started subagent ${explicit.value.subagentId} (effort: high)`)
  } finally {
    await h.dispose()
  }
})

test('a fallback result matches the pinned fixture', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'high-model' } },
    policy: [{ provider: PROVIDER, model: 'child-model' }],
  })
  try {
    const fallback = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(fallback.isError, false)
    assert.deepEqual(Object.keys(fallback.value).sort(), ['kind', 'subagentId'])
    assert.equal(
      contentText(fallback),
      `started subagent ${fallback.value.subagentId}\n\nWarning: effort tier "high" could not be used because its route is not authorized for this Session; subagent ${fallback.value.subagentId} started with parent inheritance instead.`,
    )
  } finally {
    await h.dispose()
  }
})

test('discovery reports tier-only status and never returns raw routes', async () => {
  const h = await createHarness({
    config: {
      normal: { provider: PROVIDER, model: 'normal-model' },
      high: { provider: PROVIDER, model: 'high-model', reasoningEffort: 'high' },
    },
  })
  try {
    const result = await h.call('list_subagent_models', {})
    assert.equal(result.isError, false)
    const text = contentText(result)
    assert.match(text, /normal: .*Status: configured/)
    assert.match(text, /high: .*Status: configured/)
    assert.doesNotMatch(text, /normal-model|high-model/)
    assert.doesNotMatch(text, /is authorized/i)
    assert.doesNotMatch(text, /authorized:\s*(yes|true)/i)
    assert.match(text, /never adds Subagent authorization/)
  } finally {
    await h.dispose()
  }
})

test('prompt guidance and depth are restored without an extra routing nudge', async () => {
  const h = await createHarness({ config: {} })
  try {
    const scope = scopeOf(h.agent.ctx)
    const globalFork = h.ctx.tools.register(fakeDelegation('subagent_fork'))
    try {
      const assembly = await h.ctx.systemPrompt.assemble(assembleContextFor(h.agent))
      const section = assembly.sections.find((entry) => entry.name === 'tool:subagent')
      assert.ok(section)
      assert.equal(
        section.text,
        'Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn. Collect the subagent results required to complete the task before giving the user a final answer.\n\nBash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly. The agent integrating the work must review the final diff and run relevant tests.',
      )
      const tierSentences = section.text
        .split(/(?<=\.)\s+/)
        .filter((sentence) => /normal|high|tier/i.test(sentence))
      assert.deepEqual(tierSentences, [])
    } finally {
      globalFork()
    }

    const result = await h.delegate({ description: 'depth', prompt: 'do it' })
    assert.equal(result.isError, false)
    const child = h.ctx.agents.get(result.value.subagentId)
    const childAssembly = await h.ctx.systemPrompt.assemble(assembleContextFor(child))
    const depth = childAssembly.contexts.find((entry) => entry.name === 'tool:subagent:depth')
    assert.equal(
      depth?.text,
      'Delegation depth for `subagent`: current 1, maximum 1, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.',
    )
    assert.ok(h.ctx.tools.get('subagent', scope))
  } finally {
    await h.dispose()
  }
})

test('fork definitions are untouched by the mask', async () => {
  const h = await createHarness({ config: {} })
  try {
    const scope = scopeOf(h.agent.ctx)
    const fork = fakeDelegation('subagent_fork', { provider: { type: 'string' }, model: { type: 'string' } })
    h.agent.ctx.tools.register(fork)
    assert.equal(h.ctx.tools.get('subagent_fork', scope), fork)
    assert.deepEqual(Object.keys(h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent_fork').parameters.properties), [
      'description',
      'prompt',
      'provider',
      'model',
    ])
  } finally {
    await h.dispose()
  }
})

test('a controlled provider startup error is rethrown without Parent fallback', async () => {
  const failing = {
    name: 'failing',
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true },
    inheritsParentContext: false,
    async start() {
      throw new Error('controlled provider startup failure')
    },
  }
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'high-model' } },
    policy: [{ provider: PROVIDER, model: 'high-model' }],
    providers: [failing],
    toolProvider: 'failing',
  })
  try {
    const result = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /controlled provider startup failure/)
    assert.doesNotMatch(contentText(result), /parent inheritance/)
    assert.equal(h.liveAgents(), 1)
  } finally {
    await h.dispose()
  }
})

test('a depth rejection from a child is rethrown without Parent fallback', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'high-model' } },
    policy: [{ provider: PROVIDER, model: 'high-model' }],
  })
  try {
    const first = await h.delegate({ description: 'first', prompt: 'do it', effort: 'high' })
    assert.equal(first.isError, false)
    const child = h.ctx.agents.get(first.value.subagentId)
    assert.ok(child)
    const result = await h.ctx.tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: 'depth-call',
          name: 'subagent',
          arguments: JSON.stringify({ description: 'nested', prompt: 'nest', effort: 'high' }),
        },
      ],
      signal: new AbortController().signal,
      agent: child,
    })
    const settled = result.results[0].result
    assert.equal(settled.isError, true)
    assert.match(settled.error.message, /depth/i)
    assert.equal(h.liveAgents(), 2)
  } finally {
    await h.dispose()
  }
})

test('incomplete tier configuration warns and creates one parent-route child', async () => {
  const h = await createHarness({ config: false })
  try {
    install(h.ctx, { normal: { get: () => ({ provider: PROVIDER }) } })
    const result = await h.delegate({ description: 'incomplete', prompt: 'do it', effort: 'normal' })
    assert.equal(result.isError, false)
    assert.match(contentText(result), /the selected tier is not configured/)
    assert.equal(h.child(result.value.subagentId).model, 'parent-model')
    assert.equal(h.liveAgents(), 2)
  } finally {
    await h.dispose()
  }
})

test('an unknown adapter failure is rethrown without Parent fallback', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'generic-model' } },
    policy: [{ provider: PROVIDER, model: 'generic-model' }],
    genericFailures: ['generic-model'],
  })
  try {
    const result = await h.delegate({ description: 'unknown', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /controlled unknown adapter failure/)
    assert.equal(h.liveAgents(), 1)
  } finally {
    await h.dispose()
  }
})

test('a native provider generation change is rethrown without Parent fallback', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'high-model' } },
    policy: [{ provider: PROVIDER, model: 'high-model' }],
  })
  try {
    const service = h.ctx.subagents
    const original = service.getProvider.bind(service)
    let reads = 0
    service.getProvider = (name) => {
      const provider = original(name)
      reads += 1
      return reads >= 1 ? { ...provider } : provider
    }
    const result = await h.delegate({ description: 'generation', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /changed while resolving the child LLM route/)
    assert.equal(h.liveAgents(), 1)
  } finally {
    await h.dispose()
  }
})

test('failure of the one Parent fallback propagates without another attempt', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'child-model', reasoningEffort: 'ultra' } },
    policy: [{ provider: PROVIDER, model: 'child-model' }],
  })
  try {
    let fallbackCalls = 0
    h.ctx.subagents.startActivation = async () => {
      fallbackCalls += 1
      throw new Error('controlled fallback startup failure')
    }
    const result = await h.delegate({ description: 'fallback', prompt: 'do it', effort: 'high' })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /controlled fallback startup failure/)
    assert.equal(fallbackCalls, 1)
    assert.equal(h.liveAgents(), 1)
  } finally {
    await h.dispose()
  }
})

test('a native row without model selection fails activation instead of silently ignoring tiers', async () => {
  const h = await createHarness({ config: false })
  try {
    await h.toolSubagentFiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const disposeMalformed = h.ctx.tools.register(fakeDelegation('subagent'))
    try {
      const scope = scopeOf(h.agent.ctx)
      const before = h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent')
      assert.equal(before.parameters.properties.provider, undefined)
      await assert.rejects(
        h.mountRouter({}),
        /refusing to activate because the visible "subagent" tool does not match the reviewed native structure/,
      )
      assert.deepEqual(
        h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent'),
        before,
        'a rejected activation must leave the native delegation surface untouched',
      )
    } finally {
      disposeMalformed()
    }
  } finally {
    await h.dispose()
  }
})

test('a capacity rejection is rethrown without Parent fallback', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'high-model' } },
    policy: [{ provider: PROVIDER, model: 'high-model' }],
    maxActiveSubagents: 1,
    holdText: 'hold child',
  })
  try {
    const first = await h.delegate({ description: 'held', prompt: 'hold child', effort: 'high' })
    assert.equal(first.isError, false)
    const child = h.ctx.agents.get(first.value.subagentId)
    const deadline = Date.now() + 5000
    while (child?.status !== 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(child?.status, 'running')

    let startCalls = 0
    const startActivation = h.ctx.subagents.startActivation.bind(h.ctx.subagents)
    h.ctx.subagents.startActivation = async (...args) => {
      startCalls += 1
      return await startActivation(...args)
    }
    const second = await h.delegate({ description: 'second', prompt: 'second', effort: 'high' })
    assert.equal(second.isError, true)
    assert.match(second.error.message, /active|capacity|limit/i)
    assert.equal(startCalls, 1, 'a fallback would attempt startActivation a second time')
    assert.equal(h.liveAgents(), 2)
    h.adapter.release()
    await child.whenIdle()
  } finally {
    h.adapter.release()
    await h.dispose()
  }
})
