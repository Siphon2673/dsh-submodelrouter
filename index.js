/**
 * Host entry for dsh-submodelrouter.
 *
 * @module dsh-submodelrouter
 */
import { Config } from './lib/config.js'
import { install } from './lib/host.js'

export { Config }
export const name = 'submodelrouter'
export const inject = ['tools', 'agents', 'systemPrompt']

/**
 * Mount the effort-tier adapter for every existing and future Agent.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} config - live plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  install(ctx, config)
}
