/**
 * Closed classifier for failures that may be converted into one Parent
 * fallback, plus the model-facing text that reports the outcome.
 *
 * Only failures proven to occur before the captured native tool calls
 * `startActivation` are eligible:
 *
 * - the native Session-allowlist rejection for the exact selected route, in
 *   both the recorded-policy and no-recorded-policy forms;
 * - the reviewed adapters' unsupported-reasoning-effort, unregistered-provider,
 *   and unknown-model validation codes.
 *
 * Everything else is rethrown unchanged. Text is never used as a general
 * fallback signal, and cancellation always wins.
 *
 * @module dsh-submodelrouter/fallback
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Why the selected tier was not used. */
export const REASON_NOT_CONFIGURED = 'the selected tier is not configured'
export const REASON_NOT_AUTHORIZED = 'its route is not authorized for this Session'
export const REASON_EFFORT_UNSUPPORTED = 'its reasoning effort is not supported by the model'
export const REASON_ROUTE_UNAVAILABLE = 'its provider or model is not currently available'

/**
 * Native allowlist rejection text for one exact route.
 * @param {{ provider: string, model: string }} route - selected route.
 * @returns {string} stable message prefix.
 */
export function allowlistMessage(route) {
  return `child LLM route "${route.provider}/${route.model}" is not allowed for this Session`
}

/**
 * Known no-policy suffixes. Matching no longer depends on the exact suffix, but
 * the forms are retained for tests and for documenting the reviewed contract.
 */
export const KNOWN_ALLOWLIST_NO_POLICY_SUFFIXES = Object.freeze([
  '; without a recorded model-selection policy, explicit selection (including reasoning_effort) is limited to the parent route',
  '; without a recorded model-selection policy, explicit selection is limited to the parent route',
])

/** Typed provider/effort validation codes eligible for one Parent fallback. */
const FALLBACK_CODES = new Map([
  ['UNSUPPORTED_REASONING_EFFORT', REASON_EFFORT_UNSUPPORTED],
  ['NO_ADAPTER', REASON_ROUTE_UNAVAILABLE],
  ['UNKNOWN_MODEL', REASON_ROUTE_UNAVAILABLE],
])

/**
 * Whether a value is the exact plain `Error` the native allowlist check builds.
 * A `HarnessError` (or any subclass) must never match by message.
 * @param {unknown} error - caught value.
 * @returns {error is Error} whether the value has the intrinsic Error prototype.
 */
function isPlainError(error) {
  return error instanceof Error && Object.getPrototypeOf(error) === Error.prototype
}

/**
 * Classify one selected-route failure.
 *
 * @param {unknown} error - value thrown by the captured native execution.
 * @param {{ provider: string, model: string }} route - route the selected call used.
 * @returns {string | undefined} a fallback reason, or undefined to rethrow.
 */
export function classifySelectedFailure(error, route) {
  if (error instanceof LlmError) {
    const reason = FALLBACK_CODES.get(error.code)
    if (reason !== undefined) return reason
  }
  if (isPlainError(error)) {
    const prefix = allowlistMessage(route)
    // The native suffix may change between DSH releases; the reviewed route
    // prefix and the plain-Error requirement are the stable contract.
    if (error.message === prefix || error.message.startsWith(`${prefix};`)) {
      return REASON_NOT_AUTHORIZED
    }
  }
  return undefined
}

/**
 * Model-facing suffix appended to a successful explicit-tier result.
 * @param {'normal' | 'high'} tier - selected tier.
 * @returns {string} rendered suffix.
 */
export function tierSuffix(tier) {
  return ` (effort: ${tier})`
}

/**
 * Model-facing warning appended to a successful Parent-fallback result.
 * @param {'normal' | 'high'} tier - selected tier.
 * @param {string} reason - why the tier was not used.
 * @param {string | undefined} childIdentity - native child identity, when the
 *   native output exposes a recognized field and a value.
 * @returns {string} rendered warning.
 */
export function parentFallbackWarning(tier, reason, childIdentity) {
  const subject =
    typeof childIdentity === 'string' && childIdentity.length > 0
      ? `subagent ${childIdentity}`
      : 'the subagent'
  return (
    `Warning: effort tier "${tier}" could not be used because ${reason}; ` +
    `${subject} started with parent inheritance instead.`
  )
}
