import test from 'node:test'
import assert from 'node:assert/strict'
import { HarnessError, LlmError } from '@deepseek-ai/dsh-llm'
import {
  KNOWN_ALLOWLIST_NO_POLICY_SUFFIXES,
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

test('classifies the stable native allowlist prefix in every known suffix form', () => {
  assert.equal(classifySelectedFailure(new Error(base), route), REASON_NOT_AUTHORIZED)
  for (const suffix of KNOWN_ALLOWLIST_NO_POLICY_SUFFIXES) {
    assert.equal(classifySelectedFailure(new Error(base + suffix), route), REASON_NOT_AUTHORIZED, suffix)
  }
  assert.equal(classifySelectedFailure(new Error(`${base}; a later DSH suffix`), route), REASON_NOT_AUTHORIZED)
})

test('still requires the exact selected provider/model in the prefix', () => {
  const cases = [
    new Error(allowlistMessage({ provider: 'other', model: 'high-model' })),
    new Error(allowlistMessage({ provider: 'scripted', model: 'other-model' })),
    new Error('child LLM route is not allowed for this Session'),
    new Error(`prefix ${base}`),
    new Error(base.toLowerCase()),
    new Error(`${base} trailing without separator`),
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

test('renders the tier suffix and a named fallback warning', () => {
  assert.equal(tierSuffix('normal'), ' (effort: normal)')
  const warning = parentFallbackWarning('high', REASON_NOT_AUTHORIZED, 'reviewer')
  assert.equal(
    warning,
    'Warning: effort tier "high" could not be used because its route is not authorized for this Session; subagent reviewer started with parent inheritance instead.',
  )
})

test('renders generic fallback wording when the child identity is unknown', () => {
  for (const identity of [undefined, '']) {
    const warning = parentFallbackWarning('normal', REASON_ROUTE_UNAVAILABLE, identity)
    assert.equal(
      warning,
      'Warning: effort tier "normal" could not be used because its provider or model is not currently available; the subagent started with parent inheritance instead.',
    )
  }
})
