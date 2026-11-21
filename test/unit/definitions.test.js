import test from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  childIdentityField,
  createDiscoveryDefinition,
  createMaskDefinition,
  discoveryText,
  FALLBACK_DESCRIPTION,
  isNativeSubagentDefinition,
  KNOWN_CHILD_IDENTITY_FIELDS,
  maskDescription,
  maskParameters,
  nativeArguments,
  nativeContractProblems,
  nativeShape,
  outputPropertyNames,
  PROMPT_SECTION_TEMPLATE,
  promptSectionText,
} from '../../lib/definitions.js'
import { allowlistMessage, KNOWN_ALLOWLIST_NO_POLICY_SUFFIXES } from '../../lib/fallback.js'

/** Copy captured from DSH `0.2.2-rc.1`. */
const RC1_DESCRIPTION =
  "Delegate a self-contained task to a subagent. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes. The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes. Supply `provider` and `model` together. Omitted values use child defaults, falling back to compatible parent values. When the effective route changes, an omitted `reasoning_effort` uses the model's default."

/** Copy captured from DSH `0.2.2-rc.5`. */
const RC5_DESCRIPTION =
  "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its name. If you are still online when it finishes, the runtime automatically delivers its completion notice. The notice includes the final answer unless the child sent you a message just before finishing. Use `send_message` to steer it while running or continue its conversation after it finishes. Omit `provider`, `model`, and `reasoning_effort` to use child defaults, falling back to compatible parent values. Changing the route can prevent provider-side reuse of the inherited conversation prefix."

/**
 * Build one reviewed native `subagent` definition fixture.
 *
 * `identity` names the output field the native renderer reads. `childId`
 * selects the value; a `name` child is not a Session id, matching rc.2+.
 *
 * @param {object} [options] - fixture overrides.
 * @param {'name' | 'subagentId' | 'childId'} [options.identity] - output identity field.
 * @param {string} [options.childId] - child identity value.
 * @param {string} [options.description] - native description.
 * @param {boolean} [options.rc5Parameters] - include the rc.2+ `name` parameter.
 * @param {any} [options.parameters] - complete parameter schema override.
 * @param {any} [options.output] - complete output override.
 * @returns {{ definition: any, calls: any[] }} fixture and execution log.
 */
function nativeDefinition(options = {}) {
  const calls = []
  const identity = options.identity ?? 'subagentId'
  const childId = options.childId ?? (identity === 'name' ? 'reviewer' : 'child-1')
  const definition = {
    name: 'subagent',
    description: options.description ?? RC1_DESCRIPTION,
    parameters:
      options.parameters ?? {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          description: { type: 'string' },
          ...(options.rc5Parameters === true ? { name: { type: 'string' } } : {}),
          prompt: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          reasoning_effort: { type: 'string' },
        },
        required: ['description', 'prompt'],
      },
    output:
      options.output ?? {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', const: 'activation' },
            [identity]: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `started subagent ${value[identity]}` }],
      },
    async execute(args) {
      calls.push(args)
      return { kind: 'activation', [identity]: childId }
    },
  }
  return { definition, calls }
}

/** One execution record. */
function execution(signal = new AbortController().signal) {
  return { token: Symbol('token'), signal }
}

test('mask parameters drop raw routes, keep native delegation fields, and add the effort enum', () => {
  const { definition } = nativeDefinition({ rc5Parameters: true })
  const parameters = maskParameters(definition.parameters)
  assert.deepEqual(Object.keys(parameters.properties), ['cwd', 'description', 'name', 'prompt', 'effort'])
  assert.deepEqual(parameters.properties.effort.enum, ['normal', 'high'])
  assert.deepEqual(parameters.required, ['description', 'prompt'])
  assert.deepEqual(Object.keys(definition.parameters.properties), [
    'cwd',
    'description',
    'name',
    'prompt',
    'provider',
    'model',
    'reasoning_effort',
  ])
})

test('rc.5 description keeps generic wording and drops all removed route fields', () => {
  const description = maskDescription(RC5_DESCRIPTION)
  assert.match(description, /^Delegate a self-contained task to a subagent/)
  assert.match(description, /This tool starts an independently managed subagent/)
  assert.match(description, /`send_message`/)
  for (const field of ['provider', 'model', 'reasoning_effort']) {
    assert.equal(description.includes(field), false, `${field} leaked: ${description}`)
  }
  assert.match(description, /`normal` for routine, checkable, or cheap-to-redo work/)
  assert.match(description, /`high` for work whose result is directly trusted/)
  assert.match(description, /Omit `effort` to inherit the parent route/)
  assert.doesNotMatch(description, /shallow/i)
  assert.doesNotMatch(description, /reopen|retry with High/i)
})

test('rc.1 description is rewritten by the same marker path', () => {
  const description = maskDescription(RC1_DESCRIPTION)
  assert.match(description, /^Delegate a self-contained task to a subagent\./)
  assert.match(description, /The child reports results with `send_message`/)
  for (const field of ['provider', 'model', 'reasoning_effort']) {
    assert.equal(description.includes(field), false, `${field} leaked: ${description}`)
  }
  assert.match(description, /Omit `effort` to inherit the parent route/)
})

test('an unrecognised description drops route sentences and keeps the rest', () => {
  const description = maskDescription(
    'Delegate a scoped implementation to a subagent. Set provider, model, and reasoning_effort when you delegate. The child keeps its own context.',
  )
  assert.match(description, /^Delegate a scoped implementation to a subagent\./)
  assert.match(description, /The child keeps its own context\./)
  assert.equal(description.includes('provider'), false)
  assert.equal(description.includes('model'), false)
  assert.match(description, /Omit `effort` to inherit the parent route/)
})

test('a description that is only route copy falls back to the plugin-owned copy', () => {
  for (const description of [
    'Supply `provider` and `model` together.',
    'Omit `provider`, `model`, and `reasoning_effort` to use child defaults.',
    '',
    undefined,
  ]) {
    assert.equal(maskDescription(description), FALLBACK_DESCRIPTION)
  }
  assert.match(FALLBACK_DESCRIPTION, /^Delegate a self-contained task to a subagent/)
  assert.match(FALLBACK_DESCRIPTION, /`normal` for routine, checkable, or cheap-to-redo work/)
  assert.match(FALLBACK_DESCRIPTION, /Omit `effort` to inherit the parent route/)
  assert.match(FALLBACK_DESCRIPTION, /warns and starts the child with parent inheritance/)
  for (const field of ['provider', 'model', 'reasoning_effort']) {
    assert.equal(FALLBACK_DESCRIPTION.includes(field), false, `${field} leaked`)
  }
})

test('native arguments preserve non-model parameters', () => {
  assert.deepEqual(
    nativeArguments(
      { cwd: '/tmp', description: 'd', prompt: 'p', name: 'reviewer', agent_preset: 'x', effort: 'high', provider: 'p', model: 'm' },
      { cwd: {}, description: {}, name: {}, prompt: {}, agent_preset: {}, provider: {}, model: {}, reasoning_effort: {} },
    ),
    { cwd: '/tmp', description: 'd', name: 'reviewer', prompt: 'p', agent_preset: 'x' },
  )
})

test('native surface recognition accepts both DSH result shapes and an unknown identity', () => {
  assert.equal(isNativeSubagentDefinition(nativeDefinition().definition), true)
  assert.equal(
    isNativeSubagentDefinition(nativeDefinition({ identity: 'name', rc5Parameters: true, description: RC5_DESCRIPTION }).definition),
    true,
  )
  assert.equal(
    isNativeSubagentDefinition(nativeDefinition({ identity: 'childId' }).definition),
    true,
    'the identity field must never gate installation',
  )
})

test('native surface recognition rejects foreign or incomplete structures', () => {
  const { definition } = nativeDefinition()
  const cases = [
    ['foreign tool name', { ...definition, name: 'other' }],
    ['empty description', { ...definition, description: '   ' }],
    ['missing output', { ...definition, output: undefined }],
    [
      'missing model-selection parameters',
      { ...definition, parameters: { type: 'object', properties: { prompt: {} } } },
    ],
    [
      'render is not a function',
      { ...definition, output: { ...definition.output, render: 'nope' } },
    ],
    [
      'kind is missing',
      {
        ...definition,
        output: {
          ...definition.output,
          schema: { type: 'object', properties: { subagentId: { type: 'string' } } },
        },
      },
    ],
    [
      'kind has another constant',
      {
        ...definition,
        output: {
          ...definition.output,
          schema: {
            type: 'object',
            properties: {
              kind: { type: 'string', const: 'started' },
              subagentId: { type: 'string' },
            },
          },
        },
      },
    ],
  ]
  for (const [label, candidate] of cases) {
    assert.equal(isNativeSubagentDefinition(candidate), false, label)
    assert.ok(nativeContractProblems(candidate).length > 0, label)
  }
})

test('the structural gate reports every missing signal with field names', () => {
  const problems = nativeContractProblems({ name: 'subagent', description: '', parameters: { properties: {} } })
  assert.ok(problems.some((problem) => /description/.test(problem)), problems.join('\n'))
  assert.ok(problems.some((problem) => /provider/.test(problem)), problems.join('\n'))
  assert.ok(problems.some((problem) => /output\.render/.test(problem)), problems.join('\n'))
  assert.ok(problems.some((problem) => /kind/.test(problem)), problems.join('\n'))
  const shape = nativeShape({ name: 'subagent', parameters: { properties: { prompt: {} } }, output: { schema: { properties: { kind: { const: 'activation' } } } } })
  assert.match(shape, /parameters=\[prompt\]/)
  assert.match(shape, /output=\[kind\]/)
})

test('child identity prefers name over subagentId and ignores unknown fields', () => {
  assert.deepEqual(KNOWN_CHILD_IDENTITY_FIELDS, ['name', 'subagentId'])
  assert.equal(childIdentityField(nativeDefinition({ identity: 'name' }).definition), 'name')
  assert.equal(childIdentityField(nativeDefinition({ identity: 'subagentId' }).definition), 'subagentId')
  const both = nativeDefinition({ identity: 'name' })
  both.definition.output.schema.properties.subagentId = { type: 'string' }
  assert.equal(childIdentityField(both.definition), 'name')
  assert.equal(childIdentityField(nativeDefinition({ identity: 'childId' }).definition), undefined)
  assert.equal(childIdentityField(undefined), undefined)
  assert.deepEqual(outputPropertyNames(nativeDefinition({ identity: 'childId' }).definition), ['childId', 'kind'])
})

test('invalid effort fails before the native call', async () => {
  const { definition, calls } = nativeDefinition()
  const mask = createMaskDefinition(definition, () => ({}))
  await assert.rejects(mask.execute({ description: 'd', prompt: 'p', effort: 'medium' }, execution()), /invalid arguments/)
  assert.equal(calls.length, 0)
})

test('omitted effort calls the native tool with no route fields and no suffix', async () => {
  const { definition, calls } = nativeDefinition({ identity: 'name', childId: 'reviewer' })
  const mask = createMaskDefinition(definition, () => ({}))
  const exec = execution()
  const value = await mask.execute({ description: 'd', prompt: 'p' }, exec)
  assert.deepEqual(calls, [{ description: 'd', prompt: 'p' }])
  assert.deepEqual(value, { kind: 'activation', name: 'reviewer' })
  assert.equal(mask.finalizeContent(exec, { isError: false, content: [] }), undefined)
})

test('explicit tier translates to native fields and renders the tier', async () => {
  const { definition, calls } = nativeDefinition({ identity: 'name', childId: 'reviewer' })
  const mask = createMaskDefinition(definition, () => ({
    normal: { provider: 'p', model: 'normal-model' },
    high: { provider: 'p', model: 'high-model', reasoningEffort: 'high' },
  }))
  const exec = execution()
  const value = await mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, exec)
  assert.deepEqual(calls, [
    { description: 'd', prompt: 'p', provider: 'p', model: 'high-model', reasoning_effort: 'high' },
  ])
  assert.deepEqual(value, { kind: 'activation', name: 'reviewer' })
  const content = mask.finalizeContent(exec, { isError: false, content: [{ type: 'text', text: 'started subagent reviewer' }] })
  assert.deepEqual(content, [
    { type: 'text', text: 'started subagent reviewer' },
    { type: 'text', text: ' (effort: high)' },
  ])
})

test('unconfigured tier makes exactly one parent call and names the rc.5 child', async () => {
  const { definition, calls } = nativeDefinition({ identity: 'name', childId: 'reviewer' })
  const mask = createMaskDefinition(definition, () => ({}))
  const exec = execution()
  await mask.execute({ description: 'd', prompt: 'p', effort: 'normal' }, exec)
  assert.deepEqual(calls, [{ description: 'd', prompt: 'p' }])
  const content = mask.finalizeContent(exec, { isError: false, content: [{ type: 'text', text: 'started subagent reviewer' }] })
  assert.match(content.at(-1).text, /effort tier "normal" could not be used because the selected tier is not configured/)
  assert.match(content.at(-1).text, /subagent reviewer started with parent inheritance instead/)
})

test('unknown child identity still routes and uses generic fallback wording', async () => {
  const { definition, calls } = nativeDefinition({ identity: 'childId', childId: 'opaque' })
  const mask = createMaskDefinition(definition, () => ({}))
  const exec = execution()
  await mask.execute({ description: 'd', prompt: 'p', effort: 'normal' }, exec)
  assert.deepEqual(calls, [{ description: 'd', prompt: 'p' }])
  const content = mask.finalizeContent(exec, { isError: false, content: [{ type: 'text', text: 'started subagent opaque' }] })
  assert.match(content.at(-1).text, /; the subagent started with parent inheritance instead\.$/)
  assert.doesNotMatch(content.at(-1).text, /opaque started/)
})

test('incomplete tier configuration also makes exactly one parent call', async () => {
  const { definition, calls } = nativeDefinition()
  const mask = createMaskDefinition(definition, () => ({ normal: { provider: 'p' } }))
  const exec = execution()
  await mask.execute({ description: 'd', prompt: 'p', effort: 'normal' }, exec)
  assert.deepEqual(calls, [{ description: 'd', prompt: 'p' }])
})

test('a recognized selected-call failure makes exactly one parent call', async () => {
  const { definition, calls } = nativeDefinition({ identity: 'name', childId: 'fallback-child' })
  definition.execute = async (args) => {
    calls.push(args)
    if (args.provider !== undefined) throw new Error(allowlistMessage({ provider: 'p', model: 'm' }))
    return { kind: 'activation', name: 'fallback-child' }
  }
  const mask = createMaskDefinition(definition, () => ({ normal: { provider: 'p', model: 'm' } }))
  const exec = execution()
  await mask.execute({ description: 'd', prompt: 'p', effort: 'normal' }, exec)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], { description: 'd', prompt: 'p' })
  const content = mask.finalizeContent(exec, { isError: false, content: [{ type: 'text', text: 'started subagent fallback-child' }] })
  assert.match(content.at(-1).text, /not authorized for this Session/)
  assert.match(content.at(-1).text, /subagent fallback-child started/)
})

test('every known and future native allowlist suffix is eligible', async () => {
  for (const suffix of ['', ...KNOWN_ALLOWLIST_NO_POLICY_SUFFIXES, '; a future suffix']) {
    const { definition, calls } = nativeDefinition({ identity: 'name', childId: 'fallback-child' })
    definition.execute = async (args) => {
      calls.push(args)
      if (args.provider !== undefined) throw new Error(allowlistMessage({ provider: 'p', model: 'm' }) + suffix)
      return { kind: 'activation', name: 'fallback-child' }
    }
    const mask = createMaskDefinition(definition, () => ({ high: { provider: 'p', model: 'm' } }))
    await mask.execute({ description: 'd', prompt: 'p', effort: 'high' }, execution())
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

test('the prompt template carries the complete rc.5 guidance', () => {
  assert.match(PROMPT_SECTION_TEMPLATE, /continue useful work while they run/)
  assert.match(PROMPT_SECTION_TEMPLATE, /Collect the subagent results required to complete the task before giving the user a final answer\./)
  assert.match(PROMPT_SECTION_TEMPLATE, /Bash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly\. The agent integrating the work must review the final diff and run relevant tests\./)
  assert.match(promptSectionText(['subagent']), /Start independent delegations with `subagent` together/)
  assert.match(promptSectionText(['subagent', 'subagent_fork']), /with `subagent` or `subagent_fork` together/)
})
