import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, readTier, tierStatus } from '../../lib/config.js'

test('both tiers are optional and default to no value', () => {
  const value = Config({})
  assert.equal(value.normal.get(), undefined)
  assert.equal(value.high.get(), undefined)
})

test('a complete tier resolves through its live reference', () => {
  const value = Config({ normal: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
  assert.deepEqual(value.normal.get(), { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(value.high.get(), undefined)
})

test('a tier without an effort keeps effort absent', () => {
  const value = Config({ high: { provider: 'p', model: 'm' } })
  assert.deepEqual(value.high.get(), { provider: 'p', model: 'm' })
})

test('partial or empty routes are invalid', () => {
  assert.throws(() => Config({ normal: { provider: 'p' } }), /model/)
  assert.throws(() => Config({ normal: { provider: '', model: 'm' } }), /provider/)
})

test('readTier accepts plain and live values', () => {
  assert.deepEqual(readTier({ normal: { provider: 'p', model: 'm' } }, 'normal'), { provider: 'p', model: 'm' })
  assert.deepEqual(readTier({ normal: { get: () => ({ provider: 'p', model: 'm' }) } }, 'normal'), {
    provider: 'p',
    model: 'm',
  })
  assert.equal(readTier({}, 'normal'), undefined)
  assert.equal(readTier({ normal: { provider: 'p' } }, 'normal'), null)
  assert.equal(readTier({ normal: { provider: 'p', model: 'm', reasoningEffort: '' } }, 'normal'), null)
})

test('tierStatus distinguishes configured and not configured', () => {
  assert.equal(tierStatus({ normal: { provider: 'p', model: 'm' } }, 'normal'), 'configured')
  assert.equal(tierStatus({}, 'normal'), 'not configured')
  assert.equal(tierStatus({ normal: { provider: 'p' } }, 'normal'), 'not configured')
})
