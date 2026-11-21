import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
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
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `replacement started ${value.name}` }],
    },
    async execute() {
      return { kind: 'activation', name: 'replacement-child' }
    },
  })
}

/** A structurally valid native definition whose child identity field is unknown. */
function unknownIdentityNative(calls, selectedFailures) {
  let remainingFailures = selectedFailures
  return defineTool({
    name: 'subagent',
    description:
      'Delegate a self-contained task to a subagent. Omit `provider`, `model`, and `reasoning_effort` to use child defaults, falling back to compatible parent values.',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
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
          childId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.childId}` }],
    },
    async execute(args) {
      calls.push(args)
      if (args.provider !== undefined && remainingFailures > 0) {
        remainingFailures -= 1
        throw new Error(
          `child LLM route "${args.provider}/${args.model}" is not allowed for this Session; a future native suffix`,
        )
      }
      return { kind: 'activation', childId: 'opaque-child' }
    },
  })
}

/** A structurally incomplete definition used to produce a second shape signature. */
function incompleteNative() {
  return defineTool({
    name: 'subagent',
    description: 'A foreign delegation-like tool.',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `incomplete started ${value.name}` }],
    },
    async execute() {
      return { kind: 'activation', name: 'incomplete-child' }
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
            name: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `foreign started ${value.name}` }],
      },
      async execute() {
        return { kind: 'activation', name: 'foreign-child' }
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
    assert.equal(discovery, h.native('list_subagent_models'), 'the native discovery definition must not be replaced')
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
    const firstChild = await h.child(first.value.name)
    assert.equal(firstChild.model, 'high-model')

    live.model = 'other-model'
    const second = await h.delegate({ description: 'second', prompt: 'do it', effort: 'high' })
    assert.equal(second.isError, false)
    assert.equal((await h.child(second.value.name)).model, 'other-model')
    const stillLive = (await h.child(first.value.name)).agent
    if (stillLive !== undefined) assert.equal(stillLive.options.model, 'high-model')
  } finally {
    await h.dispose()
  }
})

test('an unknown child identity still routes and reports the contract once', async () => {
  const h = await createHarness({ config: false })
  const errors = []
  const originalError = h.ctx.logger.error
  h.ctx.logger.error = (...args) => {
    errors.push(args.map(String).join(' '))
    originalError.apply(h.ctx.logger, args)
  }
  try {
    await h.toolSubagentFiber.dispose()
    await settle()
    const calls = []
    const disposeNative = h.ctx.tools.register(unknownIdentityNative(calls, 1))
    const fiber = await h.mountRouter({ high: { provider: PROVIDER, model: 'high-model' } })
    try {
      const identityErrors = errors.filter((line) => line.includes('child identity'))
      assert.equal(identityErrors.length, 1, errors.join('\n'))
      assert.match(identityErrors[0], /known fields are "name" and "subagentId"/)
      assert.match(identityErrors[0], /actual output fields are \[childId, kind\]/)

      const scope = scopeOf(h.agent.ctx)
      const schema = h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent')
      assert.deepEqual(schema.parameters.properties.effort.enum, ['normal', 'high'])

      const fallback = await h.delegate({ description: 'unknown', prompt: 'do it', effort: 'high' })
      assert.equal(fallback.isError, false)
      assert.match(contentText(fallback), /; the subagent started with parent inheritance instead\.$/)
      assert.doesNotMatch(contentText(fallback), /opaque-child started with parent inheritance/)
      assert.equal(calls.length, 2)
      assert.equal(calls[0].provider, PROVIDER)
      assert.equal(calls[0].model, 'high-model')
      assert.equal(calls[1].provider, undefined)

      const explicit = await h.delegate({ description: 'unknown', prompt: 'do it', effort: 'high' })
      assert.equal(explicit.isError, false)
      assert.equal(contentText(explicit), 'started subagent opaque-child (effort: high)')
      assert.equal(errors.filter((line) => line.includes('child identity')).length, 1)
    } finally {
      await fiber.dispose()
      disposeNative()
    }
  } finally {
    h.ctx.logger.error = originalError
    await h.dispose()
  }
})

test('an unreviewed native shape is reported once per signature and self-heals', async () => {
  const h = await createHarness({ config: false })
  const errors = []
  const originalError = h.ctx.logger.error
  h.ctx.logger.error = (...args) => {
    errors.push(args.map(String).join(' '))
    originalError.apply(h.ctx.logger, args)
  }
  try {
    await h.toolSubagentFiber.dispose()
    await settle()
    const fiber = await h.mountRouter({})
    try {
      assert.equal(errors.length, 0, 'no native surface is visible yet, so nothing is reported')
      await h.remountToolSubagent({ modelSelection: false })
      await settle()
      const scope = scopeOf(h.agent.ctx)
      assert.equal(errors.length, 1, errors.join('\n'))
      assert.match(errors[0], /does not match the reviewed native structure/)
      assert.match(errors[0], /parameters=\[cwd, description, name, prompt\]/)
      assert.equal(
        h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent').parameters.properties.effort,
        undefined,
        'an unreviewed surface must keep native delegation',
      )

      // A new Agent retries installation but the unchanged shape is not re-reported.
      await h.harness.create(SessionId('retry-agent'), { provider: PROVIDER, model: 'parent-model' })
      await settle()
      assert.equal(errors.length, 1, errors.join('\n'))

      // A different unreviewed shape is a different signature and a new report.
      await h.toolSubagentFiber.dispose()
      await settle()
      const disposeIncomplete = h.ctx.tools.register(incompleteNative())
      await settle()
      assert.equal(errors.length, 2, errors.join('\n'))
      assert.notEqual(errors[0], errors[1])
      disposeIncomplete()
      await settle()

      // Reloading the reviewed definition recovers without restarting the profile.
      await h.remountToolSubagent({})
      await settle()
      assert.deepEqual(
        h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent').parameters.properties.effort.enum,
        ['normal', 'high'],
      )
      const result = await h.delegate({ description: 'healed', prompt: 'do it' })
      assert.equal(result.isError, false)
      assert.ok(h.liveAgents() >= 2)
    } finally {
      await fiber.dispose()
    }
  } finally {
    h.ctx.logger.error = originalError
    await h.dispose()
  }
})
