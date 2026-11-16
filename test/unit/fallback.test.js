import test from 'node:test'
import assert from 'node:assert/strict'
import { HarnessError, LlmError } from '@deepseek-ai/dsh-llm'
import {
  ALLOWLIST_NO_POLICY_SUFFIX,
  REASON_EFFORT_UNSUPPORTED,
  REASON_NOT_AUTHORIZED,
  REASON_ROUTE_UNAVAILABLE,
  allowlistMessage,
  classifySelectedFailure,
  parentFallbackWarning,
  tierSuffix,
} from '../../lib/fallback.js'

const route = { provider: 'scripted', model: 'high-model' }
const base = allowlistMessage(route)

test('classifies both exact native allowlist message forms', () => {
  assert.equal(classifySelectedFailure(new Error(base), route), REASON_NOT_AUTHORIZED)
  assert.equal(classifySelectedFailure(new Error(base + ALLOWLIST_NO_POLICY_SUFFIX), route), REASON_NOT_AUTHORIZED)
})

test('refuses near-miss allowlist text', () => {
  const cases = [
    new Error(`${base} `),
    new Error(base.toLowerCase()),
    new Error(`prefix ${base}`),
    new Error(`${base}${ALLOWLIST_NO_POLICY_SUFFIX}; extra`),
    new Error(allowlistMessage({ provider: 'other', model: 'model' })),
    new Error('child LLM route is not allowed for this Session'),
  ]
  for (const error of cases) assert.equal(classifySelectedFailure(error, route), undefined, error.message)
})

test('does not classify a HarnessError by message', () => {
  assert.equal(classifySelectedFailure(new HarnessError(base, 'SOMETHING'), route), undefined)
})

test('classifies only the approved typed LLM codes', () => {
  assert.equal(
    classifySelectedFailure(new LlmError('unsupported', 'UNSUPPORTED_REASONING_EFFORT'), route),
    REASON_EFFORT_UNSUPPORTED,
  )
  assert.equal(classifySelectedFailure(new LlmError('missing', 'NO_ADAPTER'), route), REASON_ROUTE_UNAVAILABLE)
  assert.equal(classifySelectedFailure(new LlmError('unknown', 'UNKNOWN_MODEL'), route), REASON_ROUTE_UNAVAILABLE)
  for (const code of ['AUTH', 'RATE_LIMIT', 'INVALID_CONFIG', 'ABORTED', 'UNKNOWN', 'INVALID_MODEL']) {
    assert.equal(classifySelectedFailure(new LlmError('x', code), route), undefined, code)
  }
})

test('does not duck-type an arbitrary error code', () => {
  const error = new Error('looks typed')
  error.code = 'UNSUPPORTED_REASONING_EFFORT'
  assert.equal(classifySelectedFailure(error, route), undefined)
})

test('renders the tier suffix and fallback warning', () => {
  assert.equal(tierSuffix('normal'), ' (effort: normal)')
  const warning = parentFallbackWarning('high', REASON_NOT_AUTHORIZED, 'child-1')
  assert.match(warning, /effort tier "high"/)
  assert.match(warning, /not authorized for this Session/)
  assert.match(warning, /child-1/)
  assert.match(warning, /started with parent inheritance instead/)
})
