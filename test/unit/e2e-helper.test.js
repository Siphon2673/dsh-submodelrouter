import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createDisposableRun } from '../helpers/e2e.js'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

test('a disposable run is removed only after its ownership marker verifies', () => {
  const run = createDisposableRun({ repoRoot, label: 'unit-cleanup' })
  try {
    assert.ok(existsSync(run.root))
    const markerPath = resolve(run.root, 'OWNER.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    writeFileSync(markerPath, JSON.stringify({ ...marker, runId: 'tampered' }))
    assert.throws(() => run.cleanup(), /ownership marker mismatch/)
    assert.ok(existsSync(run.root), 'a mismatched marker must not delete the root')
    const original = JSON.parse(readFileSync(markerPath, 'utf8'))
    writeFileSync(markerPath, JSON.stringify({ ...original, runId: marker.runId }))
    run.cleanup()
    assert.equal(existsSync(run.root), false)
  } finally {
    if (existsSync(run.root)) run.cleanup()
  }
})

test('a failing scenario still removes its disposable root through finally', () => {
  const run = createDisposableRun({ repoRoot, label: 'unit-failure' })
  try {
    try {
      throw new Error('simulated scenario failure')
    } finally {
      run.cleanup()
    }
  } catch {
    // The scenario failure is expected; cleanup must still have run.
  }
  assert.equal(existsSync(run.root), false)
})

test('dsh web refuses a DSH_HOME outside the disposable root', async () => {
  const { startWeb } = await import('../helpers/e2e.js')
  await assert.rejects(
    startWeb({ root: '/tmp/disposable-root-does-not-exist', env: { DSH_HOME: '/tmp/outside-dsh-home' } }, 1),
    /refusing dsh web/,
  )
})
