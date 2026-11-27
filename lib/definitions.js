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
const ROUTE_FIELDS = ['provider', 'model', 'reasoning_effort']
const MODEL_FIELDS = new Set(ROUTE_FIELDS)

/** Native delegation parameters the adapter relies on. */
const REQUIRED_PARAMETERS = ['description', 'prompt', ...ROUTE_FIELDS]

/** Child identity fields the plugin understands, in priority order. */
export const KNOWN_CHILD_IDENTITY_FIELDS = ['name', 'subagentId']

/** One-line meaning shared by the model-facing tier copy. */
const TIER_MEANING = {
  normal: 'routine, checkable, or cheap-to-redo work',
  high: 'work whose result is directly trusted or whose errors are expensive',
}

/** Effort-tier parameter description. */
const EFFORT_DESCRIPTION = `Effort tier for this delegation: \`normal\` for ${TIER_MEANING.normal}; \`high\` for ${TIER_MEANING.high}. Omit to inherit the parent route.`

/** Description appended to the native generic delegation wording. */
const TIER_DESCRIPTION = `\`effort\` selects how much capability to spend on this delegation using the user-configured tiers: \`normal\` for ${TIER_MEANING.normal}; \`high\` for ${TIER_MEANING.high}. Omit \`effort\` to inherit the parent route. If the selected tier is not configured, or its route is not authorized for this Session or its reasoning effort is unsupported, this tool warns and starts the child with parent inheritance instead.`

/**
 * Plugin-owned description used when the native wording cannot be rewritten.
 * This is the mask's own copy, never the Parent-fallback warning text.
 */
export const PLUGIN_DESCRIPTION = `Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. ${TIER_DESCRIPTION}`

/**
 * Native route-copy markers. Everything from the first marker onward describes
 * the route fields the mask removes. New DSH releases may reword this copy, so
 * the markers are only a fast path; sentence filtering and post-validation
 * below are the actual contract.
 */
const ROUTE_COPY_MARKERS = [
  ` Supply \`${ROUTE_FIELDS[0]}\` and \`${ROUTE_FIELDS[1]}\` together.`,
  ` Omit \`${ROUTE_FIELDS[0]}\`, \`${ROUTE_FIELDS[1]}\`, and \`${ROUTE_FIELDS[2]}\``,
]

/** One removed route field named as a parameter (not a substring of a word). */
const REMOVED_ROUTE_FIELD = new RegExp(`(?:^|[^\\w])(?:${ROUTE_FIELDS.join('|')})(?=$|[^\\w])`)

/** The rc.5 prompt section with a placeholder for the visible tool list. */
const PROMPT_SECTION_TEMPLATE =
  'Start independent delegations with {tools} together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn. Collect the subagent results required to complete the task before giving the user a final answer.\n\nBash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly. The agent integrating the work must review the final diff and run relevant tests.'

/**
 * Render the delegation prompt section for the visible delegation tools.
 * @param {readonly string[]} toolNames - visible delegation tool names.
 * @returns {string} prompt section text.
 */
export function promptSectionText(toolNames) {
  const names = toolNames.map((name) => `\`${name}\``).join(' or ')
  return PROMPT_SECTION_TEMPLATE.replace('{tools}', () => names)
}

/**
 * Coerce a candidate to a plain object without throwing on `null`.
 * @param {unknown} value - candidate.
 * @returns {Record<string, any> | undefined} plain object or undefined.
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : undefined
}

/**
 * Read the native output schema properties.
 * @param {unknown} definition - definition visible above the Agent scope.
 * @returns {Record<string, any>} output property schemas; empty when absent.
 */
function outputProperties(definition) {
  const tool = asRecord(definition)
  return asRecord(tool?.output?.schema?.properties) ?? {}
}

/**
 * Stable description of the fields actually detected on a captured definition.
 * Used as the once-per-signature key for installation-failure logs.
 * @param {unknown} definition - definition visible above the Agent scope.
 * @returns {string} shape signature.
 */
export function nativeShape(definition) {
  const tool = asRecord(definition)
  if (tool === undefined) return 'definition=(not an object)'
  const parameters = Object.keys(asRecord(tool.parameters?.properties) ?? {}).sort()
  const output = outputProperties(tool)
  const kind = asRecord(output.kind)
  const description =
    typeof tool.description === 'string' && tool.description.trim().length > 0 ? 'non-empty' : 'empty-or-missing'
  const render = typeof tool.output?.render === 'function' ? 'function' : 'not-a-function'
  return `name=${JSON.stringify(tool.name)} parameters=[${parameters.join(', ')}] output=[${Object.keys(output).sort().join(', ')}] kind.const=${JSON.stringify(kind?.const)} description=${description} render=${render}`
}

/**
 * List every structural signal that does not match the reviewed native surface.
 * Copy is never inspected: only names, shapes, and the activation constant.
 * @param {unknown} definition - definition visible above the Agent scope.
 * @returns {string[]} problems; empty means the definition can be adapted.
 */
export function nativeContractProblems(definition) {
  const tool = asRecord(definition)
  if (tool === undefined) return ['the definition is not an object']
  /** @type {string[]} */
  const problems = []
  if (tool.name !== 'subagent') problems.push(`tool name is ${JSON.stringify(tool.name)}, expected "subagent"`)
  if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
    problems.push('description is not a non-empty string')
  }
  const properties = asRecord(tool.parameters?.properties)
  if (properties === undefined) {
    problems.push('parameters.properties is missing')
  } else {
    const missing = REQUIRED_PARAMETERS.filter((name) => properties[name] === undefined)
    if (missing.length > 0) problems.push(`parameters are missing ${missing.map((name) => `\`${name}\``).join(', ')}`)
  }
  if (typeof tool.output?.render !== 'function') problems.push('output.render is not a function')
  const output = outputProperties(tool)
  const kind = asRecord(output.kind)
  if (kind === undefined) problems.push('output.schema.properties.kind is missing')
  else if (kind.const !== 'activation') {
    problems.push(`output kind const is ${JSON.stringify(kind.const)}, expected "activation"`)
  }
  return problems
}

/**
 * Whether a captured definition is the reviewed native `subagent` surface.
 * The child identity is deliberately not part of this gate.
 * @param {unknown} definition - definition visible above the Agent scope.
 * @returns {boolean} whether the definition is safe to adapt.
 */
export function isNativeSubagentDefinition(definition) {
  return nativeContractProblems(definition).length === 0
}

/**
 * Read the native child identity field, preferring `name` over `subagentId`.
 * @param {unknown} definition - captured native definition.
 * @returns {'name' | 'subagentId' | undefined} the recognized field, if any.
 */
export function childIdentityField(definition) {
  const properties = outputProperties(definition)
  return /** @type {'name' | 'subagentId' | undefined} */ (
    KNOWN_CHILD_IDENTITY_FIELDS.find((field) => properties[field] !== undefined)
  )
}

/**
 * Sorted native output property names, used in the unknown-identity diagnostic.
 * @param {unknown} definition - captured native definition.
 * @returns {string[]} output field names.
 */
export function outputPropertyNames(definition) {
  return Object.keys(outputProperties(definition)).sort()
}

/**
 * Describe the native child identity contract for a diagnostic.
 * @param {unknown} definition - captured native definition.
 * @returns {{ field: 'name' | 'subagentId' | undefined, known: string, actual: string[] }} identity facts.
 */
export function childIdentityDiagnostic(definition) {
  return {
    field: childIdentityField(definition),
    known: KNOWN_CHILD_IDENTITY_FIELDS.map((field) => `"${field}"`).join(' and '),
    actual: outputPropertyNames(definition),
  }
}

/** Discovery description. */
const DISCOVERY_DESCRIPTION =
  'Inspect the subagent effort tiers without changing the current Agent. Returns each tier’s meaning and whether it is configured, plus how omission and Parent fallback behave. It never returns raw provider/model routes or claims that the current Session authorizes a route.'

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
 * Whether text names one of the route fields the mask removes.
 * @param {unknown} text - candidate text.
 * @returns {boolean} whether a removed field name appears.
 */
export function mentionsRemovedRouteField(text) {
  return typeof text === 'string' && REMOVED_ROUTE_FIELD.test(text)
}

/**
 * Drop sentences that name a removed route field.
 * @param {string} text - candidate description text.
 * @returns {string} text without route-field sentences.
 */
function withoutRouteSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !REMOVED_ROUTE_FIELD.test(sentence))
    .join(' ')
    .trim()
}

/**
 * Build the mask description from the captured native wording.
 *
 * Known route-copy markers truncate the native copy first; as a fallback, any
 * sentence naming a removed route field is dropped. The result is rejected and
 * replaced with the plugin-owned description when it still contains a route
 * field name or nothing usable remains.
 *
 * @param {string} nativeDescription - captured native description.
 * @returns {string} tier-oriented description.
 */
export function maskDescription(nativeDescription) {
  if (typeof nativeDescription !== 'string' || nativeDescription.trim().length === 0) {
    return PLUGIN_DESCRIPTION
  }
  let cut = -1
  for (const marker of ROUTE_COPY_MARKERS) {
    const index = nativeDescription.indexOf(marker)
    if (index !== -1 && (cut === -1 || index < cut)) cut = index
  }
  const base = withoutRouteSentences(cut === -1 ? nativeDescription : nativeDescription.slice(0, cut))
  if (base.length === 0) return PLUGIN_DESCRIPTION
  const sentenceBase = /[.!?]$/.test(base) ? base : `${base}.`
  const candidate = `${sentenceBase} ${TIER_DESCRIPTION}`
  return REMOVED_ROUTE_FIELD.test(candidate) ? PLUGIN_DESCRIPTION : candidate
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
  const identityField = childIdentityField(native)

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
        const childIdentity =
          identityField === undefined ? undefined : String(value?.[identityField] ?? '')
        executions.set(exec, {
          warning: parentFallbackWarning(tier, reason, childIdentity),
        })
        return value
      }

      const route = readTier(getConfig(), tier)
      if (route === undefined) {
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
    `- normal: ${TIER_MEANING.normal}. Status: ${tierStatus(config, 'normal')}.`,
    `- high: ${TIER_MEANING.high}. Status: ${tierStatus(config, 'high')}.`,
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
      return promptSectionText(names)
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
