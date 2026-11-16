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
  createDiscoveryDefinition,
  createMaskDefinition,
  createPromptContributions,
  isNativeDiscoveryDefinition,
  isNativeSubagentDefinition,
} from './definitions.js'

/**
 * Install the plugin on a plugin context.
 * @param {any} ctx - plugin context.
 * @param {Record<string, unknown>} config - live plugin configuration object.
 * @returns {void}
 */
export function install(ctx, config) {
  /** @type {Map<any, any>} */
  const states = new Map()
  let installing = false
  let disposed = false
  let missingLogged = false

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
      native: ctx.tools.get('subagent', parent),
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
      ctx.logger.warn('submodelrouter: the visible "subagent" tool is not the reviewed native delegation surface; leaving delegation unchanged')
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

    /** @type {any} */
    const state = {
      status: 'installed',
      native,
      discoveryNative: discovery,
      disposers: [],
    }

    try {
      const maskDefinition = createMaskDefinition(native, () => config)
      state.maskDefinition = maskDefinition
      state.disposers.push(agent.ctx.tools.register(maskDefinition))

      if (discovery !== undefined && isNativeDiscoveryDefinition(discovery)) {
        const discoveryDefinition = createDiscoveryDefinition(() => config)
        state.discoveryDefinition = discoveryDefinition
        state.disposers.push(agent.ctx.tools.register(discoveryDefinition))
      }

      const prompts = createPromptContributions(ctx, maskDefinition)
      state.disposers.push(agent.ctx.systemPrompt.section(prompts.section))
      state.disposers.push(agent.ctx.systemPrompt.context(prompts.context))

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
          if (state.native !== native) installAgent(agent)
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
