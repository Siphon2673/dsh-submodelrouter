/**
 * Plugin configuration: two optional exact child routes, each with an optional
 * model-specific reasoning effort.
 *
 * The two objects are volatile so a saved mapping applies to the next
 * delegation without remounting the Host plugin. They are read through the
 * Cordis volatile reference (`config.normal.get()`), so the same plugin
 * instance always observes the live value.
 *
 * @module dsh-submodelrouter/config
 */
import z from '@deepseek-ai/schemastery'

/**
 * One optional tier object. `default(undefined)` keeps the whole tier optional
 * while requiring both route halves whenever the object is present; a partial
 * route fails candidate validation at the configuration boundary.
 * @returns Schemastery schema for one tier.
 */
function tierSchema() {
  return z
    .object({
      provider: z.string().min(1).required(),
      model: z.string().min(1).required(),
      reasoningEffort: z.string().min(1),
    })
    .default(undefined)
    .volatile()
}

/** Live plugin configuration. */
export const Config = z.object({
  normal: tierSchema(),
  high: tierSchema(),
})

/**
 * Read the current value behind an optional volatile configuration reference.
 * Plain objects are accepted so tests and manual composition can supply the
 * resolved value directly.
 * @param {unknown} holder - volatile reference, plain tier object, or undefined.
 * @returns {unknown} the current raw value.
 */
function unwrapTier(holder) {
  if (holder !== null && typeof holder === 'object' && typeof (/** @type {{get?: unknown}} */ (holder).get) === 'function') {
    return /** @type {{get: () => unknown}} */ (holder).get()
  }
  return holder
}

/**
 * Resolve one tier's live route.
 *
 * @param {Record<string, unknown> | undefined} config - plugin configuration.
 * @param {'normal' | 'high'} tier - tier to read.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 *   the exact route, or `undefined` when the tier is absent, incomplete, or malformed.
 */
export function readTier(config, tier) {
  const value = unwrapTier(config?.[tier])
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { provider, model, reasoningEffort } = /** @type {Record<string, unknown>} */ (value)
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) return undefined
  /** @type {{ provider: string, model: string, reasoningEffort?: string }} */
  const route = { provider, model }
  if (typeof reasoningEffort === 'string') route.reasoningEffort = reasoningEffort
  return route
}

/**
 * Describe one tier for discovery output.
 * @param {Record<string, unknown> | undefined} config - plugin configuration.
 * @param {'normal' | 'high'} tier - tier to describe.
 * @returns {'configured' | 'not configured'} configuration status.
 */
export function tierStatus(config, tier) {
  const route = readTier(config, tier)
  return route === undefined ? 'not configured' : 'configured'
}
