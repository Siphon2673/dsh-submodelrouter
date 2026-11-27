/**
 * Host half: own the per-Agent delegation mask, its discovery replacement, and
 * the prompt guidance that disappears when the native tool is shadowed.
 *
 * Every Agent gets its own registrations in `agent.ctx`. The native definition
 * is always read from the scope above the Agent, so a native tool/provider
 * reload is observed through `tools/change` and rebuilt from the current
 * definition instead of reusing a stale closure. A same-scope foreign
 * registration is treated as a conflict, never stacked.
 *
 * @module dsh-submodelrouter/host
 */
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import {
  childIdentityDiagnostic,
  createDiscoveryDefinition,
  createMaskDefinition,
  createPromptContributions,
  isNativeDiscoveryDefinition,
  isNativeSubagentDefinition,
  maskDescription,
  nativeContractProblems,
  nativeShape,
  PLUGIN_DESCRIPTION,
} from './definitions.js'

/**
 * Format structural problems together with the detected native shape. Shared by
 * the activation throw and the per-Agent once-per-signature report.
 * @param {unknown} definition - definition visible above the Agent scope.
 * @param {string} [signature] - precomputed shape signature.
 * @returns {string} diagnostic detail.
 */
function describeStructureMismatch(definition, signature = nativeShape(definition)) {
  return `${nativeContractProblems(definition).join('; ')}. Shape: ${signature}`
}

/**
 * Install the plugin on a plugin context.
 * @param {any} ctx - plugin context.
 * @param {Record<string, unknown>} config - live plugin configuration object.
 * @returns {void}
 */
export function install(ctx, config) {
  /**
   * Read the native `subagent` definition visible at a scope. The scope is
   * omitted for the activation-time check and is the Agent's parent for the
   * per-Agent install, so both paths read the same native surface.
   * @param {any} [scope] - scope to read; undefined reads the unscoped view.
   * @returns {any} native definition, if registered.
   */
  function readNativeSubagent(scope) {
    return ctx.tools.get('subagent', scope)
  }

  // Activation-time opportunity check: when the native delegation surface is
  // already visible and does not match the reviewed structure, fail the Host
  // activation so the Plugins row shows the plugin as not running instead of
  // silently leaving the configured tiers unused. This failure stays visible
  // until the row is re-enabled; the per-Agent path below keeps retrying on
  // `tools/change` and new Agents, so a surface that appears later self-heals
  // without restarting the profile. The standard composition registers
  // `subagent` after its provider appears, so this usually defers to that path.
  const activationVisible = readNativeSubagent()
  if (activationVisible !== undefined && !isNativeSubagentDefinition(activationVisible)) {
    throw new Error(
      'submodelrouter: refusing to activate because the visible "subagent" tool does not match the reviewed native structure: ' +
        describeStructureMismatch(activationVisible),
    )
  }

  /** @type {Map<any, any>} */
  const states = new Map()
  /** @type {Set<string>} */
  const reported = new Set()
  let installing = false
  let disposed = false
  let missingLogged = false

  /**
   * Report one diagnostic once per native shape signature. A different shape is
   * a different report, so an update points at the fields that actually changed.
   * @param {string} kind - diagnostic family.
   * @param {unknown} definition - definition visible above the Agent scope.
   * @param {(signature: string) => string} describe - message builder.
   * @returns {void}
   */
  function reportOnce(kind, definition, describe) {
    const signature = nativeShape(definition)
    const key = `${kind}:${signature}`
    if (reported.has(key)) return
    reported.add(key)
    ctx.logger.error(describe(signature))
  }

  /**
   * Report one unreviewed native shape, naming the signals that do not match.
   * @param {unknown} definition - definition visible above the Agent scope.
   * @returns {void}
   */
  function reportUnreviewedStructure(definition) {
    reportOnce(
      'structure',
      definition,
      (signature) =>
        'submodelrouter: the visible "subagent" tool does not match the reviewed native structure; ' +
        `leaving delegation unchanged. ${describeStructureMismatch(definition, signature)}`,
    )
  }

  /**
   * Report an unrecognized native child identity. Routing continues; only the
   * Parent-fallback wording degrades to generic.
   * @param {unknown} definition - structurally valid native definition.
   * @returns {void}
   */
  function reportUnknownIdentity(definition) {
    const identity = childIdentityDiagnostic(definition)
    if (identity.field !== undefined) return
    reportOnce(
      'identity',
      definition,
      () =>
        'submodelrouter: the native "subagent" result has no recognized child identity field; ' +
        `known fields are ${identity.known}, actual output fields are [${identity.actual.join(', ')}]. ` +
        'Tier routing continues and Parent-fallback warnings use generic wording.',
    )
  }

  /**
   * Report once per shape when the native description cannot be safely
   * rewritten, so the plugin-owned description is installed instead. A
   * successful rewrite is silent.
   * @param {any} definition - structurally valid native definition.
   * @returns {void}
   */
  function reportDescriptionFallback(definition) {
    if (maskDescription(definition.description) !== PLUGIN_DESCRIPTION) return
    reportOnce(
      'description',
      definition,
      (signature) =>
        'submodelrouter: the native "subagent" description could not be safely rewritten; ' +
        `using the plugin-owned description. Shape: ${signature}`,
    )
  }

  /**
   * Read the definitions visible above one Agent's own scope.
   * @param {any} agent - live Agent.
   * @returns {{ scope: object | undefined, native: any, discovery: any }} captured definitions.
   */
  function readAbove(agent) {
    const scope = scopeOf(agent.ctx)
    const parent = scope === undefined ? undefined : scopeParentOf(scope)
    return {
      scope,
      native: readNativeSubagent(parent),
      discovery: ctx.tools.get('list_subagent_models', parent),
    }
  }

  /**
   * Run one state transition with the reentrancy guard that ignores our own
   * tool-registration notifications.
   * @template T
   * @param {() => T} action - transition to run.
   * @returns {T} action result.
   */
  function withInstalling(action) {
    if (installing) return action()
    installing = true
    try {
      return action()
    } finally {
      installing = false
    }
  }

  /**
   * Dispose one registration list in reverse order.
   * @param {Array<() => void>} disposers - registrations to remove.
   * @param {string} context - diagnostic prefix.
   * @returns {void}
   */
  function disposeAll(disposers, context) {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        ctx.logger.warn(`submodelrouter: ${context}: ${String(error)}`)
      }
    }
  }

  /**
   * Dispose every registration owned by one Agent state, in reverse order.
   * @param {any} agent - Agent whose state is removed.
   * @returns {void}
   */
  function disposeState(agent) {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    const disposers = Array.isArray(state.disposers) ? state.disposers : []
    disposeAll(disposers, 'failed to dispose an Agent-scoped registration')
  }

  /**
   * Install the mask, discovery replacement, and prompt contributions for one
   * Agent. A partial failure rolls back in reverse order.
   * @param {any} agent - live Agent.
   * @returns {'installed' | 'waiting' | 'conflict' | 'unsupported' | 'failed'} outcome.
   */
  function installAgent(agent) {
    const { scope, native, discovery } = readAbove(agent)
    if (native === undefined) {
      if (!missingLogged) {
        missingLogged = true
        ctx.logger.info('submodelrouter: the native "subagent" tool is not available; leaving delegation unchanged until it appears')
      }
      return 'waiting'
    }
    if (!isNativeSubagentDefinition(native)) {
      reportUnreviewedStructure(native)
      states.set(agent, { status: 'unsupported', native })
      return 'unsupported'
    }

    const current = ctx.tools.get('subagent', scope)
    if (current !== undefined && current !== native) {
      ctx.logger.warn(
        `submodelrouter: agent "${agent.id}" already has a same-scope "subagent" registration; refusing to stack a second adapter`,
      )
      states.set(agent, { status: 'conflict', native })
      return 'conflict'
    }

    reportUnknownIdentity(native)
    reportDescriptionFallback(native)

    /** @type {any} */
    const state = {
      status: 'installed',
      native,
      discoveryNative: discovery,
      disposers: [],
    }

    try {
      const maskDefinition = createMaskDefinition(native, () => config)
      const discoveryDefinition =
        discovery !== undefined && isNativeDiscoveryDefinition(discovery)
          ? createDiscoveryDefinition(() => config)
          : undefined
      const prompts = createPromptContributions(ctx, maskDefinition)
      state.maskDefinition = maskDefinition
      state.discoveryDefinition = discoveryDefinition

      // Own every per-Agent registration with one agent-scoped effect, and keep
      // that exact disposer for plugin unload and Agent disposal.
      state.disposers.push(
        agent.ctx.effect(function* () {
          yield agent.ctx.tools.register(maskDefinition)
          if (discoveryDefinition !== undefined) yield agent.ctx.tools.register(discoveryDefinition)
          yield agent.ctx.systemPrompt.section(prompts.section)
          yield agent.ctx.systemPrompt.context(prompts.context)
        }, 'submodelrouter: Agent mask'),
      )

      states.set(agent, state)
      missingLogged = false
      return 'installed'
    } catch (error) {
      disposeAll(/** @type {Array<() => void>} */ (state.disposers), 'rollback after a failed Agent registration also failed')
      states.delete(agent)
      ctx.logger.error(`submodelrouter: could not install the delegation mask for agent "${agent.id}": ${String(error)}`)
      return 'failed'
    }
  }

  /**
   * Bring every live Agent in line with the current native registrations.
   * @returns {void}
   */
  function reconcile() {
    if (disposed) return
    withInstalling(() => {
      const live = new Set(ctx.agents.list())
      for (const agent of [...states.keys()]) {
        if (!live.has(agent)) disposeState(agent)
      }

      for (const agent of live) {
        const { scope, native, discovery } = readAbove(agent)
        const state = states.get(agent)

        if (native === undefined) {
          if (state !== undefined) disposeState(agent)
          continue
        }

        if (state === undefined) {
          installAgent(agent)
          continue
        }

        if (state.status === 'conflict') {
          const current = ctx.tools.get('subagent', scope)
          if (current === undefined || current === native) installAgent(agent)
          continue
        }

        if (state.status === 'unsupported') {
          // Re-run the gate on every tool change, not only when the definition
          // object changes: a native reload may restore the reviewed surface
          // behind the same registration path. Reporting stays once per shape.
          installAgent(agent)
          continue
        }

        if (state.status !== 'installed') continue

        const current = ctx.tools.get('subagent', scope)
        if (current !== state.maskDefinition) {
          disposeState(agent)
          installAgent(agent)
          continue
        }

        const discoveryChanged =
          (state.discoveryDefinition !== undefined) !==
          (discovery !== undefined && isNativeDiscoveryDefinition(discovery))
        if (state.native !== native || state.discoveryNative !== discovery || discoveryChanged) {
          disposeState(agent)
          installAgent(agent)
        }
      }
    })
  }

  ctx.effect(
    () => () => {
      disposed = true
      for (const agent of [...states.keys()]) disposeState(agent)
      states.clear()
    },
    'submodelrouter: Agent registrations',
  )

  ctx.on('tools/change', () => {
    if (disposed || installing) return
    reconcile()
  })
  ctx.on('agent/created', (/** @type {any} */ payload) => {
    const agent = payload.agent
    if (disposed || installing) return
    withInstalling(() => {
      if (!states.has(agent)) installAgent(agent)
    })
  })
  ctx.on('agent/disposed', (/** @type {any} */ payload) => {
    disposeState(payload.agent)
  })

  withInstalling(() => {
    for (const agent of ctx.agents.list()) {
      if (!states.has(agent)) installAgent(agent)
    }
  })
}
