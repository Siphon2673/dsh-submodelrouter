/**
 * Real-runtime harness for the Host half: production AgentLoop, sessions,
 * tools, subagent runtime, and a scripted LLM adapter. Tests call the actual
 * model-facing tool through the selected executor and inspect the child route.
 */
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
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as Router from '../../index.js'

/** Provider owned by the scripted adapter. */
export const PROVIDER = 'scripted'
/** A provider with no adapter, used for the NO_ADAPTER fallback case. */
export const MISSING_PROVIDER = 'missing-provider'

/** Scripted adapter with deterministic model metadata. */
export class ScriptedAdapter extends LlmAdapter {
  /**
   * @param {object} [options] - adapter behavior.
   * @param {readonly string[]} [options.models] - advertised model ids.
   * @param {readonly string[]} [options.efforts] - advertised effort ids.
   * @param {readonly string[]} [options.unknownModels] - ids that throw UNKNOWN_MODEL.
   * @param {readonly string[]} [options.genericFailures] - ids whose resolution throws a plain Error.
   */
  constructor(options = {}) {
    super()
    this.models = options.models ?? ['parent-model', 'child-model', 'high-model', 'other-model']
    this.efforts = options.efforts ?? ['low', 'high']
    this.unknownModels = new Set(options.unknownModels ?? [])
    this.genericFailures = new Set(options.genericFailures ?? [])
    this.calls = []
  }

  /** @inheritdoc */
  providerInfo(provider) {
    return { id: provider, name: `Scripted ${provider}` }
  }

  /** @inheritdoc */
  async listModels(provider) {
    return this.models.map((id) => ({ provider, id, name: `Model ${id}` }))
  }

  /** @inheritdoc */
  async resolveModel(provider, model) {
    if (this.genericFailures.has(model)) {
      throw new Error(`controlled unknown adapter failure for "${model}"`)
    }
    if (this.unknownModels.has(model)) {
      throw new LlmError(`scripted adapter has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    if (!this.models.includes(model)) {
      throw new LlmError(`scripted adapter has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return {
      provider,
      id: model,
      name: `Model ${model}`,
      reasoning: {
        efforts: this.efforts.map((id) => ({ id, name: `Effort ${id}` })),
        defaultEffort: this.efforts[0],
      },
    }
  }

  /** @inheritdoc */
  async *stream(options) {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'scripted answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'scripted answer' } }
    yield { type: 'finish', reason: 'stop' }
  }
}

/**
 * Create the production host topology and a parent Agent.
 *
 * @param {object} [options] - harness options.
 * @param {Record<string, unknown> | false} [options.config] - plugin config; false mounts no plugin.
 * @param {readonly {provider: string, model: string}[] | undefined} [options.policy] - parent Session allowlist.
 * @param {number} [options.agents] - parent Agent count.
 * @param {readonly string[]} [options.models] - adapter models.
 * @param {readonly string[]} [options.efforts] - adapter efforts.
 * @param {readonly string[]} [options.unknownModels] - adapter unknown models.
 * @returns {Promise<any>} harness handles.
 */
export async function createHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-smr-'))
  const ctx = new Context()
  const adapter = new ScriptedAdapter(options)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  await ctx.plugin(Persistence, { root, compression: 'none' })
  await ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 8 })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  for (const provider of options.providers ?? []) ctx.subagents.registerProvider(provider)
  let toolSubagentFiber = await ctx.plugin(ToolSubagent, {
    provider: options.toolProvider ?? 'spawn',
    toolName: 'subagent',
    modelSelection: true,
    modelDiscovery: true,
  })
  const routerFiber = options.config === false ? undefined : await ctx.plugin(Router, options.config ?? {})
  const harness = await mountAgentLoopTestHarness(ctx)
  const count = options.agents ?? 1
  const agents = []
  for (let index = 0; index < count; index += 1) {
    const agent = await harness.create(
      SessionId(`parent-${index}-${Math.random().toString(36).slice(2)}`),
      { provider: PROVIDER, model: 'parent-model' },
    )
    if (options.policy !== undefined) {
      agent.session.append('subagent/model-selection-policy', { allowedModels: options.policy })
    }
    agents.push(agent)
  }
  return {
    ctx,
    adapter,
    harness,
    get toolSubagentFiber() {
      return toolSubagentFiber
    },
    agent: agents[0],
    agents,
    routerFiber,
    root,
    /**
     * Invoke one model tool through the selected executor.
     * @param {string} name - tool name.
     * @param {Record<string, unknown>} args - JSON arguments.
     * @param {object} [callOptions] - extra execution options.
     * @returns {Promise<any>} settled tool execution result.
     */
    call(name, args, callOptions = {}) {
      return executeModelToolFixture(ctx, {
        callId: `call-${Math.random().toString(36).slice(2)}`,
        name,
        arguments: args,
        agent: agents[0],
        signal: callOptions.signal ?? new AbortController().signal,
      })
    },
    /**
     * Invoke the masked `subagent` tool.
     * @param {Record<string, unknown>} args - tool arguments.
     * @param {object} [callOptions] - extra execution options.
     * @returns {Promise<any>} settled tool execution result.
     */
    delegate(args, callOptions = {}) {
      return this.call('subagent', args, callOptions)
    },
    /**
     * Read one live child's effective route.
     * @param {string} childId - native child id.
     * @returns {{ agent: any, provider: string | undefined, model: string | undefined, reasoningEffort: string | undefined }} child facts.
     */
    child(childId) {
      const agent = ctx.agents.get(childId)
      return {
        agent,
        provider: agent?.options?.provider,
        model: agent?.options?.model,
        reasoningEffort: agent?.options?.reasoningEffort,
      }
    },
    /** @returns {number} live Agent count. */
    liveAgents() {
      return ctx.agents.list().length
    },
    /**
     * Allow one route in every parent Session.
     * @param {readonly {provider: string, model: string}[]} routes - authorized routes.
     * @returns {void}
     */
    allow(routes) {
      for (const agent of agents) {
        agent.session.append('subagent/model-selection-policy', { allowedModels: routes })
      }
    },
    /**
     * Mount the router plugin.
     * @param {Record<string, unknown>} config - plugin config.
     * @returns {Promise<any>} plugin fiber.
     */
    async mountRouter(config) {
      return await ctx.plugin(Router, config)
    },
    /**
     * Dispose and remount the native delegation tool, as a provider reload does.
     * @param {Record<string, unknown>} [config] - replacement native tool config.
     * @returns {Promise<any>} new native fiber.
     */
    async remountToolSubagent(config = {}) {
      await toolSubagentFiber.dispose()
      toolSubagentFiber = await ctx.plugin(ToolSubagent, {
        provider: 'spawn',
        toolName: 'subagent',
        modelSelection: true,
        modelDiscovery: true,
        ...config,
      })
      return toolSubagentFiber
    },
    /**
     * Dispose every layer and remove the temporary persistence root.
     * @returns {Promise<void>}
     */
    async dispose() {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Let a queued reconciliation or asynchronous child start settle. */
export async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

/**
 * Render one executed result's content as text.
 * @param {any} result - settled tool result.
 * @returns {string} joined text blocks.
 */
export function contentText(result) {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
