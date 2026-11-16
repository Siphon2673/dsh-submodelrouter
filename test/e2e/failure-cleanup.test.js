import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createDisposableRun, initializeProfile, startWeb, stopProcess } from '../helpers/e2e.js'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const enabled = process.env.DSH_E2E === '1'

/** Allocate one free loopback port. */
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test(
  'a failing end-to-end scenario stops the managed Web job and removes its root',
  { skip: enabled ? false : 'set DSH_E2E=1 to run the disposable Web lifecycle suite', timeout: 180_000 },
  async () => {
    const run = createDisposableRun({ repoRoot, label: 'failure-cleanup' })
    let server
    let failure
    try {
      initializeProfile(run)
      server = await startWeb(run, await freePort())
      throw new Error('simulated end-to-end failure')
    } catch (error) {
      failure = error
    } finally {
      await stopProcess(server?.process)
      run.cleanup()
    }
    assert.equal(failure?.message, 'simulated end-to-end failure')
    assert.equal(existsSync(run.root), false)
    assert.equal(server?.process.exitCode !== null || server?.process.signalCode !== null, true)
  },
)
