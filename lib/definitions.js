/**
 * Model-facing tool definitions and prompt contributions installed into one
 * Agent's scope.
 *
 * The mask reuses the captured native tool's output contract and execution for
 * everything except the model-facing form: it removes the raw route fields,
 * adds the `effort` enum, translates a selected tier into native route fields,
 * and appends the tier or Parent-fallback marker to the rendered result.
 *
 * @module dsh-submodelrouter/definitions
 */
import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { readTier, tierStatus } from './config.js'
import {
  classifySelectedFailure,
  parentFallbackWarning,
  REASON_NOT_CONFIGURED,
  tierSuffix,
} from './fallback.js'

/** Raw native route fields the mask removes from the model-facing schema. */
const MODEL_FIELDS = new Set(['provider', 'model', 'reasoning_effort'])

/** Effort-tier parameter description. */
const EFFORT_DESCRIPTION =
  'Effort tier for this delegation: `normal` for routine, checkable, or cheap-to-redo work; `high` for work whose result is directly trusted or whose errors are expensive. Omit to inherit the parent route.'

/** Description appended to the native generic delegation wording. */
const TIER_DESCRIPTION =
  '`effort` selects how much capability to spend on this delegation using the user-configured tiers: `normal` for routine, checkable, or cheap-to-redo work; `high` for work whose result is directly trusted or whose errors are expensive. Omit `effort` to inherit the parent route. If the selected tier is not configured, or its route is not authorized for this Session or unsupported by its model, this tool warns and starts the child with parent inheritance instead.'

/** Discovery description. */
const DISCOVERY_DESCRIPTION =
  'Inspect the subagent effort tiers without changing the current Agent. Returns each tier’s meaning and whether it is configured, plus how omission and Parent fallback behave. It never returns raw provider/model routes or claims that the current Session authorizes a route.'

/**
 * Whether a captured definition is the reviewed native `subagent` surface.
 * @param {unknown} definition - definition visible above the Agent scope.
 * @returns {boolean} whether the definition is safe to adapt.
 */
export function isNativeSubagentDefinition(definition) {
  if (definition === null || typeof definition !== 'object') return false
  const tool = /** @type {any} */ (definition)
  if (tool.name !== 'subagent' || typeof tool.description !== 'string') return false
  const properties = tool.parameters?.properties
  if (properties === null || typeof properties !== 'object') return false
  if (properties.description === undefined || properties.prompt === undefined) return false
  // The supported surface is a model-selection row (`modelSelection: true`).
  // Without these fields, explicit tier arguments would not reach the child.
  if (properties.provider === undefined || properties.model === undefined || properties.reasoning_effort === undefined) {
    return false
  }
  if (tool.output === null || typeof tool.output !== 'object' || typeof tool.output.render !== 'function') return false
  const outputProperties = tool.output.schema?.properties
  return outputProperties?.kind !== undefined && outputProperties?.subagentId !== undefined
}

/**
 * Whether a captured definition is the native discovery tool.
 * @param {unknown} definition - definition visible above the Agent scope.
 * @returns {boolean} whether the definition can be replaced.
 */
export function isNativeDiscoveryDefinition(definition) {
  if (definition === null || typeof definition !== 'object') return false
  const tool = /** @type {any} */ (definition)
  return (
    tool.name === 'list_subagent_models' &&
    tool.parameters !== null &&
    typeof tool.parameters === 'object' &&
    tool.output !== null &&
    typeof tool.output === 'object' &&
    tool.output.schema?.type === 'string' &&
    typeof tool.output.render === 'function'
  )
}

/**
 * Clone native parameters without the raw route fields and add `effort`.
 * @param {any} nativeParameters - captured native parameter schema.
 * @returns {any} mask parameter schema.
 */
export function maskParameters(nativeParameters) {
  const parameters = structuredClone(nativeParameters)
  const properties = parameters.properties ?? {}
  for (const name of MODEL_FIELDS) delete properties[name]
  properties.effort = {
    type: 'string',
    enum: ['normal', 'high'],
    description: EFFORT_DESCRIPTION,
  }
  parameters.properties = properties
  if (Array.isArray(parameters.required)) {
    parameters.required = parameters.required.filter((name) => Object.hasOwn(properties, name))
  }
  return parameters
}

/**
 * Build the mask description from the captured native wording.
 * @param {string} nativeDescription - captured native description.
 * @returns {string} tier-oriented description.
 */
export function maskDescription(nativeDescription) {
  const cut = nativeDescription.indexOf(' Supply `provider` and `model` together.')
  const base = cut === -1 ? nativeDescription : nativeDescription.slice(0, cut)
  return `${base} ${TIER_DESCRIPTION}`
}

/**
 * Copy only the native non-model arguments the model supplied.
 * @param {Record<string, unknown>} args - mask arguments.
 * @param {any} nativeProperties - captured native parameter properties.
 * @returns {Record<string, unknown>} arguments for the captured native execution.
 */
export function nativeArguments(args, nativeProperties) {
  /** @type {Record<string, unknown>} */
  const result = {}
  for (const name of Object.keys(nativeProperties ?? {})) {
    if (MODEL_FIELDS.has(name) || name === 'effort') continue
    if (args[name] !== undefined) result[name] = args[name]
  }
  return result
}

/**
 * Append text to a successful rendered result.
 * @param {readonly any[]} content - native rendered content.
 * @param {string} text - suffix to append.
 * @returns {any[]} cloned content with one appended text block.
 */
function appendText(content, text) {
  const clone = content.map((block) => ({ ...block }))
  clone.push({ type: 'text', text })
  return clone
}

/**
 * Build the Agent-scoped `subagent` mask.
 *
 * @param {any} native - captured native definition.
 * @param {() => Record<string, unknown> | undefined} getConfig - live plugin configuration reader.
 * @returns {any} registry-ready mask definition.
 */
export function createMaskDefinition(native, getConfig) {
  /** @type {WeakMap<object, { tier?: 'normal' | 'high', warning?: string }>} */
  const executions = new WeakMap()
  const parameters = maskParameters(native.parameters)

  const definition = {
    name: native.name,
    description: maskDescription(native.description),
    parameters,
    output: native.output,
    ...(native.deferLoading === true ? { deferLoading: true } : {}),
    ...(typeof native.timeoutMs === 'number' ? { timeoutMs: native.timeoutMs } : {}),
    ...(typeof native.isConcurrencySafe === 'function'
      ? { isConcurrencySafe: (/** @type {unknown} */ args) => native.isConcurrencySafe(args) }
      : {}),
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      const violations = validateJsonSchemaValue(parameters, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)

      const base = nativeArguments(args, native.parameters.properties)
      const tier = args.effort
      if (tier === undefined) {
        return await native.execute(base, exec)
      }

      /**
       * Run exactly one Parent fallback for this execution, outside the
       * selected call's catch path.
       * @param {string} reason - why the tier was not used.
       * @returns {Promise<any>} native activation value.
       */
      const fallback = async (reason) => {
        const value = await native.execute(base, exec)
        executions.set(exec, {
          warning: parentFallbackWarning(tier, reason, String(value?.subagentId ?? '')),
        })
        return value
      }

      const route = readTier(getConfig(), tier)
      if (route === undefined || route === null) {
        return await fallback(REASON_NOT_CONFIGURED)
      }

      const selectedArgs = {
        ...base,
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoning_effort: route.reasoningEffort }),
      }

      try {
        const value = await native.execute(selectedArgs, exec)
        executions.set(exec, { tier })
        return value
      } catch (error) {
        if (exec.signal?.aborted === true) throw error
        const reason = classifySelectedFailure(error, route)
        if (reason === undefined) throw error
        if (exec.signal?.aborted === true) throw error
        return await fallback(reason)
      }
    },
    finalizeContent(/** @type {any} */ exec, /** @type {any} */ result) {
      const state = executions.get(exec)
      if (state === undefined) return undefined
      executions.delete(exec)
      if (result.isError === true) return undefined
      if (state.warning !== undefined) return appendText(result.content, `\n\n${state.warning}`)
      if (state.tier !== undefined) return appendText(result.content, tierSuffix(state.tier))
      return undefined
    },
  }

  return definition
}

/**
 * Build the tier-oriented replacement for `list_subagent_models`.
 * @param {() => Record<string, unknown> | undefined} getConfig - live plugin configuration reader.
 * @returns {any} registry-ready discovery definition.
 */
export function createDiscoveryDefinition(getConfig) {
  const definition = {
    name: 'list_subagent_models',
    description: DISCOVERY_DESCRIPTION,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (/** @type {unknown} */ _args, /** @type {unknown} */ value) => [
        { type: 'text', text: String(value) },
      ],
    },
    execute() {
      return discoveryText(getConfig())
    },
  }
  return definition
}

/**
 * Tier-only discovery output. It deliberately contains no route ids and makes
 * no claim about an existing Session's recorded authorization.
 * @param {Record<string, unknown> | undefined} config - live plugin configuration.
 * @returns {string} discovery text.
 */
export function discoveryText(config) {
  return [
    'Effort tiers for `subagent`:',
    `- normal: routine, checkable, or cheap-to-redo work. Status: ${tierStatus(config, 'normal')}.`,
    `- high: directly trusted or expensive-to-be-wrong work. Status: ${tierStatus(config, 'high')}.`,
    'Omit `effort` to inherit the parent route without a warning. Selecting a configured tier uses its user-configured route; selecting an unconfigured tier, or a route that is not authorized for this Session, warns and starts the child with parent inheritance instead.',
    'Tier selection never adds Subagent authorization. Configure both tiers on this plugin’s Configure page under Plugins, and start a new Session after changing Subagent authorization.',
  ].join('\n')
}

/**
 * Build the prompt contributions that disappear when the native tool is
 * shadowed: the generic parallel-delegation paragraph and the depth notice.
 *
 * @param {any} ctx - plugin context.
 * @param {any} maskDefinition - this Agent's mask definition.
 * @returns {{ section: any, context: any }} prompt registrations.
 */
export function createPromptContributions(ctx, maskDefinition) {
  const sectionOrder = (() => {
    try {
      return ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT')
    } catch {
      return 2800
    }
  })()
  const contextOrder = (() => {
    try {
      return ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION')
    } catch {
      return 120
    }
  })()

  const section = {
    name: 'tool:subagent',
    order: sectionOrder,
    text: (/** @type {any} */ context) => {
      if (context.scope === undefined) return ''
      if (ctx.tools.get('subagent', context.scope) !== maskDefinition) return ''
      const names = ['subagent']
      if (ctx.tools.get('subagent_fork', context.scope) !== undefined) names.push('subagent_fork')
      return `Start independent delegations with ${names.map((name) => `\`${name}\``).join(' or ')} together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.`
    },
  }

  const context = {
    name: 'tool:subagent:depth',
    order: contextOrder,
    text: (/** @type {any} */ assembly) => {
      if (assembly.agent === undefined || assembly.scope === undefined) return ''
      if (ctx.tools.get('subagent', assembly.scope) !== maskDefinition) return ''
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return ''
      try {
        const maxDepth = subagents.resolveMaxDepth()
        if (maxDepth === undefined) return ''
        const depth = delegationDepthOf(assembly.agent)
        if (!(depth >= maxDepth)) return ''
        return `Delegation depth for \`subagent\`: current ${depth}, maximum ${maxDepth}, remaining levels 0. Do not call \`subagent\` at this depth; carry out the work directly.`
      } catch {
        return ''
      }
    },
  }

  return { section, context }
}
