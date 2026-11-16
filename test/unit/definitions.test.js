import test from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  createDiscoveryDefinition,
  createMaskDefinition,
  discoveryText,
  isNativeSubagentDefinition,
  maskDescription,
  maskParameters,
  nativeArguments,
} from '../../lib/definitions.js'
import { ALLOWLIST_NO_POLICY_SUFFIX, allowlistMessage } from '../../lib/fallback.js'

/** Build one reviewed native `subagent` definition fixture. */
function nativeDefinition(options = {}) {
  const calls = []
  const definition = {
    name: 'subagent',
    description:
      'Delegate a self-contained task to a subagent. It does not share this conversation. Supply `provider` and `model` together. Omitted values use child defaults, falling back to compatible parent values. When the effective route changes, an omitted `reasoning_effort` uses the model\'s default.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        description: { type: 'string' },
        prompt: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoning_effort: { type: 'string' },
      },
      required: ['description', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    async execute(args) {
      calls.push(args)
      return { kind: 'activation', subagentId: options.childId ?? 'child-1' }
    },
  }
  return { definition, calls }
}

/** One execution record. */
function execution(signal = new AbortController().signal) {
  return { token: Symbol('token'), signal }
}

test('mask parameters drop raw routes and add the effort enum', () => {
  const { definition } = nativeDefinition()
  const parameters = maskParameters(definition.parameters)
  assert.deepEqual(Object.keys(parameters.properties), ['cwd', 'description', 'prompt', 'effort'])
  assert.deepEqual(parameters.properties.effort.enum, ['normal', 'high'])
  assert.deepEqual(parameters.required, ['description', 'prompt'])
  assert.deepEqual(Object.keys(definition.parameters.properties), [
    'cwd',
    'description',
    'prompt',
    'provider',
    'model',
    'reasoning_effort',
  ])
})

test('mask description keeps generic wording and drops model-selection wording', () => {
  const { definition } = nativeDefinition()
  const description = maskDescription(definition.description)
  assert.match(description, /^Delegate a self-contained task to a subagent\./)
  assert.doesNotMatch(description, /Supply `provider` and `model` together/)
  assert.match(description, /`normal` for routine, checkable, or cheap-to-redo work/)
  assert.match(description, /`high` for work whose result is directly trusted/)
  assert.match(description, /Omit `effort` to inherit the parent route/)
  assert.doesNotMatch(description, /shallow/i)
  assert.doesNotMatch(description, /reopen|retry with High/i)
})

test('native arguments preserve non-model parameters', () => {
  assert.deepEqual(
    nativeArguments(
      { cwd: '/tmp', description: 'd', prompt: 'p', agent_preset: 'x', effort: 'high', provider: 'p', model: 'm' },
      { cwd: {}, description: {}, prompt: {}, agent_preset: {}, provider: {}, model: {}, reasoning_effort: {} },
    ),
    { cwd: '/tmp', description: 'd', prompt: 'p', agent_preset: 'x' },
  )
})

test('native surface recognition rejects foreign definitions', () => {
  const { definition } = nativeDefinition()
  assert.equal(isNativeSubagentDefinition(definition), true)
  assert.equal(isNativeSubagentDefinition({ ...definition, name: 'other' }), false)
  assert.equal(isNativeSubagentDefinition({ ...definition, output: undefined }), false)
  assert.equal(
    isNativeSubagentDefinition({ ...definition, parameters: { type: 'object', properties: { prompt: {} } } }),
    false,
  )
})

test('invalid effort fails before the native call', async () => {
  const { definition, calls } = nativeDefinition()
  const mask = createMaskDefinition(definition, () => ({}))
  await assert.rejects(mask.execute({ description: 'd', prompt: 'p', effort: 'medium' }, execution()), /invalid arguments/)
  assert.equal(calls.length, 0)
})

test('omitted effort calls the native tool with no route fields and no suffix', async () => {
  const { definition, calls } = nativeDefinition()
  const mask = createMaskDefinition(definition, () => ({}))
  const exec = execution()
  const value = await mask.execute({ description: 'd', prompt: 'p' }, exec)
  assert.deepEqual(calls, [{ description: 'd', prompt: 'p' }])
  assert.deepEqual(value, { kind: 'activation', subagentId: 'child-1' })
  assert.equal(mask.finalizeContent(exec, { isError: false, content: [] }), undefined)
})

test('explicit tier translates to native fields and renders the tier', async () => {
  const { definition, calls } = nativeDefinition()
  const mask = createMaskDefinition(definition, () => ({
    normal: { provider: 'p', model: 'normal-model' },
    high: { provider: 'p', model: 'high-model', reasoningEffort: 'high' },
  }))
  const exec = execution()
  const value = await mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, exec)
  assert.deepEqual(calls, [
    { description: 'd', prompt: 'p', provider: 'p', model: 'high-model', reasoning_effort: 'high' },
  ])
  assert.deepEqual(value, { kind: 'activation', subagentId: 'child-1' })
  const content = mask.finalizeContent(exec, { isError: false, content: [{ type: 'text', text: 'started subagent child-1' }] })
  assert.deepEqual(content, [
    { type: 'text', text: 'started subagent child-1' },
    { type: 'text', text: ' (effort: high)' },
  ])
})

test('unconfigured tier makes exactly one parent call', async () => {
  const { definition, calls } = nativeDefinition()
  const mask = createMaskDefinition(definition, () => ({}))
  const exec = execution()
  await mask.execute({ description: 'd', prompt: 'p', effort: 'normal' }, exec)
  assert.deepEqual(calls, [{ description: 'd', prompt: 'p' }])
  const content = mask.finalizeContent(exec, { isError: false, content: [{ type: 'text', text: 'started subagent child-1' }] })
  assert.match(content.at(-1).text, /effort tier "normal" could not be used because the selected tier is not configured/)
  assert.match(content.at(-1).text, /child-1 started with parent inheritance instead/)
})

test('incomplete tier configuration also makes exactly one parent call', async () => {
  const { definition, calls } = nativeDefinition()
  const mask = createMaskDefinition(definition, () => ({ normal: { provider: 'p' } }))
  const exec = execution()
  await mask.execute({ description: 'd', prompt: 'p', effort: 'normal' }, exec)
  assert.deepEqual(calls, [{ description: 'd', prompt: 'p' }])
})

test('a recognized selected-call failure makes exactly one parent call', async () => {
  const { definition, calls } = nativeDefinition()
  definition.execute = async (args) => {
    calls.push(args)
    if (args.provider !== undefined) throw new Error(allowlistMessage({ provider: 'p', model: 'm' }))
    return { kind: 'activation', subagentId: 'child-2' }
  }
  const mask = createMaskDefinition(definition, () => ({ normal: { provider: 'p', model: 'm' } }))
  const exec = execution()
  await mask.execute({ description: 'd', prompt: 'p', effort: 'normal' }, exec)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], { description: 'd', prompt: 'p' })
  const content = mask.finalizeContent(exec, { isError: false, content: [{ type: 'text', text: 'started subagent child-2' }] })
  assert.match(content.at(-1).text, /not authorized for this Session/)
})

test('both native allowlist forms are eligible', async () => {
  for (const suffix of ['', ALLOWLIST_NO_POLICY_SUFFIX]) {
    const { definition, calls } = nativeDefinition()
    definition.execute = async (args) => {
      calls.push(args)
      if (args.provider !== undefined) throw new Error(allowlistMessage({ provider: 'p', model: 'm' }) + suffix)
      return { kind: 'activation', subagentId: 'child-3' }
    }
    const mask = createMaskDefinition(definition, () => ({ high: { provider: 'p', model: 'm' } }))
    const exec = execution()
    await mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, exec)
    assert.equal(calls.length, 2, `suffix ${JSON.stringify(suffix)}`)
  }
})

test('unrecognized failures are rethrown without fallback', async () => {
  const failures = [
    new Error('subagent provider "spawn" changed while resolving the child LLM route; retry the delegation'),
    new Error('startup failed'),
    new LlmError('provider overloaded', 'UNKNOWN'),
    new LlmError('auth', 'AUTH'),
  ]
  for (const failure of failures) {
    const { definition, calls } = nativeDefinition()
    definition.execute = async (args) => {
      calls.push(args)
      throw failure
    }
    const mask = createMaskDefinition(definition, () => ({ high: { provider: 'p', model: 'm' } }))
    await assert.rejects(mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, execution()), (error) => error === failure)
    assert.equal(calls.length, 1, failure.message)
  }
})

test('cancellation wins over a recognized failure', async () => {
  const { definition, calls } = nativeDefinition()
  const controller = new AbortController()
  definition.execute = async (args) => {
    calls.push(args)
    controller.abort()
    throw new LlmError('missing', 'NO_ADAPTER')
  }
  const mask = createMaskDefinition(definition, () => ({ high: { provider: 'p', model: 'm' } }))
  await assert.rejects(mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, execution(controller.signal)))
  assert.equal(calls.length, 1)
})

test('fallback failure propagates without another attempt', async () => {
  const { definition, calls } = nativeDefinition()
  definition.execute = async (args) => {
    calls.push(args)
    if (args.provider !== undefined) throw new LlmError('missing', 'NO_ADAPTER')
    throw new Error('fallback failed')
  }
  const mask = createMaskDefinition(definition, () => ({ high: { provider: 'p', model: 'm' } }))
  await assert.rejects(
    mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, execution()),
    /fallback failed/,
  )
  assert.equal(calls.length, 2)
})

test('live configuration changes affect the next delegation only', async () => {
  const { definition, calls } = nativeDefinition()
  let config = { high: { provider: 'p', model: 'first' } }
  const mask = createMaskDefinition(definition, () => config)
  await mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, execution())
  config = { high: { provider: 'p', model: 'second' } }
  await mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, execution())
  assert.deepEqual(calls.map((call) => call.model), ['first', 'second'])
})

test('a failed execution appends no content', async () => {
  const { definition } = nativeDefinition()
  const mask = createMaskDefinition(definition, () => ({}))
  const exec = execution()
  await mask.execute({ description: 'd', prompt: 'p', effort: 'normal' }, exec)
  assert.equal(mask.finalizeContent(exec, { isError: true, content: [{ type: 'text', text: 'Error' }] }), undefined)
})

test('discovery reports tier status without routes', () => {
  const config = {
    normal: { provider: 'p', model: 'normal-secret-route' },
  }
  const text = discoveryText(config)
  assert.match(text, /normal: .*Status: configured/)
  assert.match(text, /high: .*Status: not configured/)
  assert.match(text, /Omit `effort` to inherit the parent route without a warning/)
  assert.match(text, /never adds Subagent authorization/)
  assert.doesNotMatch(text, /normal-secret-route/)
  assert.doesNotMatch(text, /provider\/model route/)
})

test('discovery tool exposes no route parameters', () => {
  const discovery = createDiscoveryDefinition(() => ({}))
  assert.equal(discovery.name, 'list_subagent_models')
  assert.deepEqual(Object.keys(discovery.parameters.properties), [])
  assert.equal(discovery.output.schema.type, 'string')
})

test('native surface recognition requires model-selection fields', () => {
  const { definition } = nativeDefinition()
  const withoutModel = { ...definition, parameters: structuredClone(definition.parameters) }
  delete withoutModel.parameters.properties.provider
  assert.equal(isNativeSubagentDefinition(withoutModel), false)
  const withoutEffort = { ...definition, parameters: structuredClone(definition.parameters) }
  delete withoutEffort.parameters.properties.reasoning_effort
  assert.equal(isNativeSubagentDefinition(withoutEffort), false)
})
