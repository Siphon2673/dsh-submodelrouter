import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHarness, contentText, PROVIDER, settle } from '../helpers/harness.js'
import { install } from '../../lib/host.js'

/** A reviewed-surface native definition used to simulate a provider definition change. */
function replacementNative(extra = {}) {
  return defineTool({
    name: 'subagent',
    description:
      'Delegate a task to a replacement native subagent. Supply `provider` and `model` together. Omitted values use child defaults, falling back to compatible parent values.',
    parameters: {
      cwd: { type: 'string' },
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      ...extra,
      provider: { type: 'string' },
      model: { type: 'string' },
      reasoning_effort: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `replacement started ${value.subagentId}` }],
    },
    async execute() {
      return { kind: 'activation', subagentId: 'replacement-child' }
    },
  })
}

test('a native tool/provider reload is rebuilt from the current definition', async () => {
  const h = await createHarness({ config: { high: { provider: PROVIDER, model: 'high-model' } } })
  const scope = scopeOf(h.agent.ctx)
  try {
    assert.ok(h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent').parameters.properties.effort)
    await h.remountToolSubagent({})
    await settle()
    let schema = h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent')
    assert.ok(schema.parameters.properties.effort)
    assert.equal(schema.parameters.properties.provider, undefined)
    const afterNativeReload = await h.delegate({ description: 'x', prompt: 'y' })
    assert.equal(afterNativeReload.isError, false)
    assert.equal(h.liveAgents(), 2)

    await h.toolSubagentFiber.dispose()
    await settle()
    assert.equal(h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent'), undefined)

    const disposeReplacement = h.ctx.tools.register(replacementNative({ agent_preset: { type: 'string', enum: ['a', 'b'] } }))
    await settle()
    schema = h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent')
    assert.deepEqual(Object.keys(schema.parameters.properties), [
      'cwd',
      'description',
      'prompt',
      'agent_preset',
      'effort',
    ])
    const afterDefinitionChange = await h.delegate({ description: 'x', prompt: 'y' })
    assert.equal(afterDefinitionChange.isError, false)
    assert.equal(contentText(afterDefinitionChange), 'replacement started replacement-child')

    disposeReplacement()
    await settle()
    assert.equal(h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent'), undefined)
  } finally {
    await h.dispose()
  }
})

test('a same-scope foreign mask is a visible conflict, never an adapter chain', async () => {
  const h = await createHarness({ config: false })
  const scope = scopeOf(h.agent.ctx)
  try {
    const foreign = defineTool({
      name: 'subagent',
      description: 'foreign mask',
      parameters: { description: { type: 'string', required: true }, prompt: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'activation' },
            subagentId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `foreign started ${value.subagentId}` }],
      },
      async execute() {
        return { kind: 'activation', subagentId: 'foreign-child' }
      },
    })
    h.agent.ctx.tools.register(foreign)
    const warnings = []
    const originalWarn = h.ctx.logger.warn
    h.ctx.logger.warn = (...args) => {
      warnings.push(args.map(String).join(' '))
      originalWarn.apply(h.ctx.logger, args)
    }
    const fiber = await h.mountRouter({})
    await settle()
    assert.equal(h.ctx.tools.get('subagent', scope), foreign)
    const discovery = h.ctx.tools.get('list_subagent_models', scope)
    assert.match(discovery?.description ?? '', /^Inspect subagent models/)
    assert.doesNotMatch(discovery?.description ?? '', /effort tiers/)
    assert.equal(
      h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent').description,
      'foreign mask',
    )
    assert.ok(warnings.some((line) => line.includes('refusing to stack a second adapter')))
    await fiber.dispose()
  } finally {
    await h.dispose()
  }
})

test('disable and re-enable clean up every live Agent without duplicates', async () => {
  const h = await createHarness({
    config: { high: { provider: PROVIDER, model: 'high-model' } },
    agents: 2,
  })
  const scopes = h.agents.map((agent) => scopeOf(agent.ctx))
  const masked = (scope) => h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent')?.parameters.properties.effort !== undefined
  const nativeVisible = (scope) => h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent')?.parameters.properties.provider !== undefined
  try {
    assert.deepEqual(scopes.map(masked), [true, true])

    let fiber = h.routerFiber
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await fiber.dispose()
      assert.deepEqual(scopes.map(nativeVisible), [true, true])
      assert.deepEqual(scopes.map(masked), [false, false])
      fiber = await h.mountRouter({ high: { provider: PROVIDER, model: 'high-model' } })
      await settle()
      assert.deepEqual(scopes.map(masked), [true, true])
      for (const scope of scopes) {
        assert.equal(h.ctx.tools.definitions(scope).filter((tool) => tool.name === 'subagent').length, 1)
        assert.equal(h.ctx.tools.definitions(scope).filter((tool) => tool.name === 'list_subagent_models').length, 1)
      }
    }
    await fiber.dispose()
  } finally {
    await h.dispose()
  }
})

test('live mapping edits affect subsequent delegations and never existing children', async () => {
  const h = await createHarness({
    config: false,
    policy: [
      { provider: PROVIDER, model: 'high-model' },
      { provider: PROVIDER, model: 'other-model' },
    ],
  })
  try {
    const live = { model: 'high-model' }
    install(h.ctx, { high: { get: () => ({ provider: PROVIDER, model: live.model }) } })
    const first = await h.delegate({ description: 'first', prompt: 'do it', effort: 'high' })
    assert.equal(first.isError, false)
    const firstChild = h.child(first.value.subagentId)
    assert.equal(firstChild.model, 'high-model')

    live.model = 'other-model'
    const second = await h.delegate({ description: 'second', prompt: 'do it', effort: 'high' })
    assert.equal(second.isError, false)
    assert.equal(h.child(second.value.subagentId).model, 'other-model')
    const stillLive = h.ctx.agents.get(first.value.subagentId)
    if (stillLive !== undefined) assert.equal(stillLive.options.model, 'high-model')
  } finally {
    await h.dispose()
  }
})
