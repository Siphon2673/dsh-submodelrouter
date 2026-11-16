/**
 * Disposable E2E LLM provider. It advertises deterministic routes and a simple
 * text response; no network or credentials are involved.
 */

/** Provider route owned by this adapter. */
const PROVIDER = 'scripted'

/** Minimal adapter over the public duck-typed registration seam. */
const adapter = {
  providerInfo(provider) {
    return { id: provider, name: 'Scripted provider' }
  },
  providerRetryPolicy() {
    return undefined
  },
  async listModels(provider) {
    return [
      { provider, id: 'parent-model', name: 'Parent model' },
      { provider, id: 'child-model', name: 'Child model', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } },
      { provider, id: 'high-model', name: 'High model', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
    ]
  },
  async resolveModel(provider, model) {
    const models = await this.listModels(provider)
    const found = models.find((entry) => entry.id === model)
    if (found === undefined) {
      const error = new Error(`scripted adapter has no configured model "${model}"`)
      error.code = 'UNKNOWN_MODEL'
      throw error
    }
    return found
  },
  delegated: false,
  async *stream(options) {
    const promptText = options.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (!this.delegated && promptText.includes('delegate now')) {
      this.delegated = true
      const id = 'scripted-call-1'
      const args = JSON.stringify({
        description: 'e2e delegation',
        prompt: 'do a delegated task',
        effort: 'high',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'subagent', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'subagent', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'scripted answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'scripted answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

export const name = 'smr-e2e-provider'
export const inject = ['llm']

/**
 * Register the scripted provider for this disposable profile.
 * @param {any} ctx - Host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
