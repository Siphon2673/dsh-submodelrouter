/**
 * Contract facts shared by the adapter's unit and canary tests.
 *
 * These are deliberately test knowledge: the production modules derive their
 * route fields and describe behavior instead of importing a test allowlist.
 */

/** Raw native route fields the mask removes from the model-facing schema. */
export const ROUTE_FIELDS = ['provider', 'model', 'reasoning_effort']

/** Known no-policy suffixes DSH appends to the stable allowlist rejection prefix. */
export const KNOWN_ALLOWLIST_SUFFIXES = [
  '; without a recorded model-selection policy, explicit selection (including reasoning_effort) is limited to the parent route',
  '; without a recorded model-selection policy, explicit selection is limited to the parent route',
]
