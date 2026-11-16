import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  createDisposableRun,
  digest,
  initializeProfile,
  installBundle,
  startWeb,
  stopProcess,
  writeEvidence,
} from '../helpers/e2e.js'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const providerBundle = resolve(repoRoot, 'test/e2e/fixtures/provider-bundle')
const enabled = process.env.DSH_E2E === '1'

/** Allocate one free loopback port. */
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Click through the DOM even when font-less headless layout gives zero size. */
async function domClick(locator) {
  await locator.waitFor({ state: 'attached', timeout: 20_000 })
  await locator.evaluate((element) => element.click())
}

/** Wait for body text to contain one literal substring. */
async function waitForText(page, text, timeout = 20_000) {
  await page.waitForFunction((needle) => document.body.textContent.includes(needle), text, { timeout })
}

/** Dismiss the first-run workspace onboarding if it is present. */
async function dismissOnboarding(page) {
  const cont = page.getByRole('button', { name: 'Continue' })
  if ((await cont.count()) > 0) {
    await domClick(cont.first())
    await page.waitForTimeout(1500)
  }
}

/** Poll a predicate until it succeeds or the deadline passes. */
async function waitUntil(predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('timed out waiting for the disposable profile change')
}

/** Read the profile's user patch layer. */
function profilePatch(run) {
  return readFileSync(resolve(run.profileDir, 'cordis.patch.yml'), 'utf8')
}

/** Read the profile manifest. */
function profileManifest(run) {
  return JSON.parse(readFileSync(resolve(run.profileDir, 'package.json'), 'utf8'))
}

test(
  'disposable Web profile configures tiers, survives reload, cleans up, and retains settings',
  { skip: enabled ? false : 'set DSH_E2E=1 and install Playwright Chromium to run the browser end-to-end suite', timeout: 300_000 },
  async () => {
    const run = createDisposableRun({ repoRoot, label: 'web' })
    let server
    let browser
    const evidence = {
      runId: run.runId,
      startedAt: new Date().toISOString(),
      steps: [],
      cleanup: 'pending',
    }
    try {
      initializeProfile(run)
      installBundle(run, repoRoot)
      installBundle(run, providerBundle)

      const firstDump = run.dsh(['--profile', 'web', '--dump-config'])
      assert.equal(firstDump.status, 0, firstDump.stderr)
      assert.match(firstDump.stdout, /- id: submodelrouter\n  name: dsh-submodelrouter/)
      assert.match(firstDump.stdout, /- id: agent-default-model\n  name: '@deepseek-ai\/dsh-agent-default-model'\n  config:\n    provider: scripted\n    model: parent-model/)
      assert.match(
        firstDump.stdout,
        /- id: subagent-model-selection-settings\n  name: '@deepseek-ai\/dsh-tool-subagent\/model-selection-settings'\n  config:\n    enabled: true\n    allowedModels:\n      - provider: scripted\n        model: child-model\n      - provider: scripted\n        model: high-model/,
      )
      const standardSubagent = firstDump.stdout.match(
        /- id: tool-subagent\n\s+name: '@deepseek-ai\/dsh-tool-subagent'\n\s+config:\n\s+provider: spawn\n\s+toolName: subagent\n\s+modelSelection: true\n\s+modelDiscovery: true/,
      )
      assert.ok(standardSubagent, 'the standard preset subagent row must have no agentOptions or route defaults')
      assert.doesNotMatch(standardSubagent[0], /agentOptions/)
      evidence.steps.push({ step: 'profile-installed', dumpDigest: digest(firstDump.stdout) })

      const port = await freePort()
      server = await startWeb(run, port)
      evidence.webPort = port
      evidence.webPid = server.pid
      evidence.webUrl = server.url

      const { chromium } = await import('playwright')
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(2500)
      await dismissOnboarding(page)
      assert.deepEqual(pageErrors, [])

      await domClick(page.getByRole('button', { name: 'Plugins' }))
      await page.waitForTimeout(1200)
      await domClick(page.getByRole('button', { name: 'Submodel router' }))
      await page.waitForTimeout(1000)
      await waitForText(page, 'dsh-submodelrouter')
      await domClick(page.getByRole('button', { name: 'Configure Submodel router' }))
      await waitForText(page, 'Subagent model authorization is enabled.')
      await waitForText(page, 'Native settings: Plugins → Subagent')
      evidence.steps.push({ step: 'configure-page-opened' })

      // The native Subagent settings page remains its own page.
      await domClick(page.getByRole('button', { name: 'Back to Submodel router' }))
      await page.waitForTimeout(500)
      await domClick(page.getByRole('button', { name: 'Back to plugins' }))
      await page.waitForTimeout(1000)
      await domClick(page.getByRole('button', { name: 'Subagent' }))
      await waitForText(page, 'Maximum recursion depth')
      await waitForText(page, 'Model selection')
      await waitForText(page, 'Models agents may choose')
      evidence.steps.push({ step: 'native-subagent-page-unchanged' })
      await domClick(page.getByRole('button', { name: 'Back to plugins' }))
      await page.waitForTimeout(1000)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      await dismissOnboarding(page)

      // Configure both tiers through the real page and save.
      await domClick(page.getByRole('button', { name: 'Plugins' }))
      await page.waitForTimeout(1000)
      await domClick(page.getByRole('button', { name: 'Submodel router' }))
      await page.waitForTimeout(800)
      await domClick(page.getByRole('button', { name: 'Configure Submodel router' }))
      await waitForText(page, 'Subagent model authorization is enabled.')
      await page.getByLabel('Normal Provider').last().selectOption('scripted')
      await page.getByLabel('Normal Model').last().selectOption('child-model')
      await page.getByLabel('High Provider').last().selectOption('scripted')
      await page.getByLabel('High Model').last().selectOption('high-model')
      await page.getByLabel('High Reasoning effort').last().selectOption('high')
      await page.getByRole('button', { name: 'Save', exact: true }).last().click()
      await waitForText(page, 'Saved.')
      const savedPatch = profilePatch(run)
      assert.match(savedPatch, /id: submodelrouter/)
      assert.match(savedPatch, /normal:\n\s+provider: scripted\n\s+model: child-model/)
      assert.match(savedPatch, /high:\n\s+provider: scripted\n\s+model: high-model\n\s+reasoningEffort: high/)
      evidence.steps.push({ step: 'tier-mapping-saved', patchDigest: digest(savedPatch) })

      // A reload preserves the mapping.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      await dismissOnboarding(page)
      await domClick(page.getByRole('button', { name: 'Plugins' }))
      await page.waitForTimeout(1000)
      await domClick(page.getByRole('button', { name: 'Submodel router' }))
      await page.waitForTimeout(800)
      await domClick(page.getByRole('button', { name: 'Configure Submodel router' }))
      await waitForText(page, 'Subagent model authorization is enabled.')
      assert.equal(await page.getByLabel('Normal Provider').last().inputValue(), 'scripted')
      assert.equal(await page.getByLabel('Normal Model').last().inputValue(), 'child-model')
      assert.equal(await page.getByLabel('High Provider').last().inputValue(), 'scripted')
      assert.equal(await page.getByLabel('High Model').last().inputValue(), 'high-model')
      assert.equal(await page.getByLabel('High Reasoning effort').last().inputValue(), 'high')
      evidence.steps.push({ step: 'reload-persisted' })

      // Disable and re-enable the row; the page and saved values return.
      await domClick(page.getByRole('button', { name: 'Back to Submodel router' }))
      await page.waitForTimeout(600)
      const rowSwitch = page.getByRole('switch', { name: 'Enable component Submodel router' }).last()
      await domClick(rowSwitch)
      await page.waitForTimeout(4000)
      await domClick(page.getByRole('button', { name: 'Back to plugins' }))
      await page.waitForTimeout(800)
      await domClick(page.getByRole('button', { name: 'Submodel router' }))
      await page.waitForTimeout(1000)
      assert.equal(await page.getByRole('button', { name: 'Configure Submodel router' }).count(), 0)
      await domClick(page.getByRole('switch', { name: 'Enable component Submodel router' }).last())
      await page.waitForTimeout(4000)
      await page.waitForFunction(
        () => [...document.querySelectorAll('button')].some((button) => button.getAttribute('aria-label') === 'Configure Submodel router'),
        undefined,
        { timeout: 20_000 },
      )
      await domClick(page.getByRole('button', { name: 'Configure Submodel router' }))
      await waitForText(page, 'Subagent model authorization is enabled.')
      assert.equal(await page.getByLabel('High Model').last().inputValue(), 'high-model')
      evidence.steps.push({ step: 'row-disable-enable' })

      // Uninstall through the user-facing lifecycle.
      await domClick(page.getByRole('button', { name: 'Back to Submodel router' }))
      await page.waitForTimeout(500)
      await domClick(page.getByRole('button', { name: 'Uninstall Submodel router' }))
      await page.waitForTimeout(500)
      await domClick(page.getByRole('dialog').getByRole('button', { name: 'Uninstall' }))
      await waitUntil(() => {
        const manifest = profileManifest(run)
        return (
          !manifest.dsh.profile.bundles.includes('dsh-submodelrouter') &&
          manifest.dependencies?.['dsh-submodelrouter'] === undefined
        )
      }, 60_000)
      const retained = profilePatch(run)
      assert.match(retained, /id: submodelrouter/)
      assert.match(retained, /model: high-model/)
      evidence.steps.push({ step: 'uninstalled-settings-retained' })

      // Reinstall the same row id after stopping the server and recover the saved mapping.
      await stopProcess(server.process)
      server = undefined
      installBundle(run, repoRoot)
      const manifestAfterReinstall = profileManifest(run)
      evidence.manifestAfterReinstall = manifestAfterReinstall
      evidence.patchAfterReinstall = profilePatch(run)
      assert.ok(
        manifestAfterReinstall.dsh.profile.bundles.includes('dsh-submodelrouter'),
        'reinstalling the package must reselect its bundle',
      )
      const reinstalledDump = run.dsh(['--profile', 'web', '--dump-config'])
      evidence.reinstalledDumpTail = reinstalledDump.stdout.slice(-6000)
      evidence.retainedPatchTail = retained.slice(-2000)
      assert.equal(reinstalledDump.status, 0, reinstalledDump.stderr)
      assert.match(
        reinstalledDump.stdout,
        /- id: submodelrouter\n  name: dsh-submodelrouter\n  config:\n    normal:\n      provider: scripted\n      model: child-model/,
      )
      assert.match(reinstalledDump.stdout, /model: high-model\n      reasoningEffort: high/)
      evidence.steps.push({ step: 'reinstalled-settings-recovered' })
    } finally {
      await stopProcess(server?.process)
      await browser?.close()
      evidence.cleanup = 'complete'
      evidence.finishedAt = new Date().toISOString()
      try {
        writeEvidence(evidence, repoRoot)
        run.cleanup()
      } catch (cleanupError) {
        evidence.cleanup = `failed: ${String(cleanupError)}`
        writeEvidence(evidence, repoRoot)
        throw cleanupError
      }
    }
  },
)
