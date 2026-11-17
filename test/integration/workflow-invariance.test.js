/**
 * Workflow invariance: workflow children start through the runtime's direct
 * `startActivation` path, not the masked `subagent` tool, so they must keep
 * inheriting the parent route while the plugin's tier route stays untouched.
 *
 * The production workflow tool is mounted and called through the real tool
 * runtime. Its engine is a minimal test stand-in that follows the reviewed
 * `dsh-workflow-ptc` start shape: caller delivery, no agentOptions unless the
 * script names a route, and one awaited child Activation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import { createHarness, contentText, PROVIDER, settle } from '../helpers/harness.js'

/** A fake fork definition used to observe that the mask never rewrites it. */
function forkDefinition() {
  return defineTool({
    name: 'subagent_fork',
    description: 'Fork a child that inherits the current completed conversation.',
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
          subagentId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `forked subagent ${value.subagentId}` }],
    },
    async execute() {
      return { kind: 'activation', subagentId: 'fork-child' }
    },
  })
}

/**
 * Minimal workflow engine over the production `ctx.subagents.startActivation`
 * seam. It records the child route before awaiting the Activation result.
 */
class RouteCapturingWorkflowEngine extends WorkflowEngine {
  static inject = ['subagents', 'agents']

  /**
   * @param {any} request - production workflow start request.
   * @returns {any} holder-owned run handle.
   */
  start(request) {
    const controller = new AbortController()
    const abort = () => controller.abort(request.signal?.reason)
    if (request.signal?.aborted === true) abort()
    else request.signal?.addEventListener('abort', abort, { once: true })
    let childId
    const result = (async () => {
      try {
        const activation = await this.ctx.subagents.startActivation({
          provider: 'spawn',
          label: `${request.meta.name} child 1`,
          delivery: 'caller',
          signal: controller.signal,
          request: {
            prompt: [{ type: 'text', text: 'workflow child task' }],
            parent: request.parent,
          },
        })
        childId = activation.childId
        const child = this.ctx.agents.get(childId)
        const childRoute = {
          provider: child?.options.provider,
          model: child?.options.model,
          ...(child?.options.reasoningEffort === undefined ? {} : { reasoningEffort: child.options.reasoningEffort }),
        }
        const settled = await activation.result
        await activation.dispose()
        return {
          value: {
            childId,
            childRoute,
            text: settled.output
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join(''),
          },
          stopReason: settled.stopReason,
          agentsStarted: 1,
        }
      } catch (error) {
        return { value: null, stopReason: 'error', error: String(error), agentsStarted: childId === undefined ? 0 : 1 }
      } finally {
        request.signal?.removeEventListener('abort', abort)
      }
    })()
    return {
      id: 'invariance-run',
      meta: request.meta,
      result,
      cancel(reason) {
        controller.abort(reason)
      },
      dispose() {
        return result.then(() => {})
      },
    }
  }
}

test('workflow children keep the parent route and the workflow definition is untouched', async () => {
  const h = await createHarness({ config: false })
  try {
    const engineFiber = await h.ctx.plugin(RouteCapturingWorkflowEngine)
    const workflowFiber = await h.ctx.plugin(ToolWorkflow, { enableRunInBackground: false })
    const fork = forkDefinition()
    const disposeFork = h.agent.ctx.tools.register(fork)
    const scope = scopeOf(h.agent.ctx)
    const workflowBefore = h.ctx.tools.get('workflow', scope)
    assert.ok(workflowBefore, 'the production workflow tool must be mounted')
    const workflowSchemaBefore = h.ctx.tools.schemas(scope).find((tool) => tool.name === 'workflow')
    assert.ok(workflowSchemaBefore)

    // Mount the plugin with a configured high tier; the workflow path must not use it.
    await h.mountRouter({ high: { provider: PROVIDER, model: 'high-model', reasoningEffort: 'high' } })
    h.allow([{ provider: PROVIDER, model: 'high-model' }])
    await settle()

    assert.equal(h.ctx.tools.get('workflow', scope), workflowBefore, 'the workflow definition object must not be replaced')
    assert.deepEqual(
      h.ctx.tools.schemas(scope).find((tool) => tool.name === 'workflow'),
      workflowSchemaBefore,
      'the workflow schema must not change',
    )
    assert.equal(h.ctx.tools.get('subagent_fork', scope), fork, 'the fork definition object must not be replaced')
    assert.deepEqual(
      Object.keys(h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent_fork').parameters.properties),
      ['description', 'prompt'],
    )
    const masked = h.ctx.tools.schemas(scope).find((tool) => tool.name === 'subagent')
    assert.deepEqual(masked.parameters.properties.effort.enum, ['normal', 'high'])

    const forkCall = await h.call('subagent_fork', { description: 'fork', prompt: 'fork it' })
    assert.equal(forkCall.isError, false)
    assert.deepEqual(forkCall.value, { kind: 'activation', subagentId: 'fork-child' })
    assert.equal(contentText(forkCall), 'forked subagent fork-child')

    const call = await h.call('workflow', {
      meta: { name: 'invariance', description: 'Assert workflow children keep the parent route.' },
      script: 'return await agent("workflow child task")',
    })
    assert.equal(call.isError, false, call.error?.message ?? JSON.stringify(call.value ?? call.content))
    assert.equal(call.value.kind, 'foreground')
    assert.equal(call.value.runId, 'invariance-run')
    assert.equal(call.value.agentsStarted, 1)
    assert.equal(call.value.result.text, 'scripted answer')
    assert.deepEqual(call.value.result.childRoute, { provider: PROVIDER, model: 'parent-model' })
    assert.equal('reasoningEffort' in call.value.result.childRoute, false)
    assert.ok(call.value.result.childId.length > 0)

    // The configured high tier still applies to the masked tool itself.
    const delegated = await h.delegate({ description: 'high', prompt: 'do it', effort: 'high' })
    assert.equal(delegated.isError, false)
    const maskedChild = h.child(delegated.value.subagentId)
    assert.equal(maskedChild.provider, PROVIDER)
    assert.equal(maskedChild.model, 'high-model')
    assert.equal(maskedChild.reasoningEffort, 'high')

    disposeFork()
    await workflowFiber.dispose()
    await engineFiber.dispose()
  } finally {
    await h.dispose()
  }
})
