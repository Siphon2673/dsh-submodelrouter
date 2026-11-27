/**
 * End-to-end user seam for Session durability: create one masked delegation
 * through the real Web profile, uninstall the plugin through the standard CLI
 * lifecycle, restart the same profile without it, and reopen both histories.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const seederBundle = resolve(repoRoot, 'test/e2e/fixtures/session-seeder')
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

/** Poll the seeder artifact until it exists or the deadline passes. */
async function waitForArtifact(path, timeout = 120_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const artifact = JSON.parse(readFileSync(path, 'utf8'))
        if (artifact.error !== undefined) throw new Error(`seeder ${artifact.mode} failed: ${artifact.error}`)
        return artifact
      } catch (error) {
        if (error instanceof SyntaxError) lastError = error
        else throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`the seeder artifact ${path} did not appear before the deadline: ${String(lastError ?? '')}`)
}

/** Read the profile manifest or patch layer. */
function profileManifest(run) {
  return JSON.parse(readFileSync(resolve(run.profileDir, 'package.json'), 'utf8'))
}

/** Read the profile's user patch layer. */
function profilePatch(run) {
  return readFileSync(resolve(run.profileDir, 'cordis.patch.yml'), 'utf8')
}

/** Configure both tiers through the real Configure page and save them. */
async function configureTiers(page) {
  await domClick(page.getByRole('button', { name: 'Plugins' }))
  await page.waitForTimeout(1200)
  await domClick(page.getByRole('button', { name: 'Submodel router' }))
  await page.waitForTimeout(1000)
  await waitForText(page, 'dsh-submodelrouter')
  await domClick(page.getByRole('button', { name: 'Configure Submodel router' }))
  await waitForText(page, 'Subagent model authorization is enabled.')
  await waitForText(page, 'Native settings: Plugins → Subagent')
  await page.getByLabel('Normal Provider').last().selectOption('scripted')
  await page.getByLabel('Normal Model').last().selectOption('child-model')
  await page.getByLabel('High Provider').last().selectOption('scripted')
  await page.getByLabel('High Model').last().selectOption('high-model')
  await page.getByLabel('High Reasoning effort').last().selectOption('high')
  await page.getByRole('button', { name: 'Save', exact: true }).last().click()
  await waitForText(page, 'Saved.')
}

test(
  'web profile Session restore keeps a masked delegation after the plugin is uninstalled',
  { skip: enabled ? false : 'set DSH_E2E=1 and install Playwright Chromium to run the browser end-to-end suite', timeout: 300_000 },
  async () => {
    const run = createDisposableRun({ repoRoot, label: 'web-session-restore' })
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
      installBundle(run, seederBundle)
      const firstDump = run.dsh(['--profile', 'web', '--dump-config'])
      assert.equal(firstDump.status, 0, firstDump.stderr)
      assert.match(firstDump.stdout, /- id: submodelrouter\n  name: dsh-submodelrouter/)
      assert.match(firstDump.stdout, /- id: smr-e2e-session-seeder\n  name: dsh-smr-e2e-session-seeder/)
      evidence.dumpDigest = digest(firstDump.stdout)

      const artifacts = {
        create: resolve(run.root, 'e2e-create.json'),
        restore: resolve(run.root, 'e2e-restore.json'),
      }
      const triggers = {
        create: resolve(run.root, 'e2e-create.trigger'),
        restore: resolve(run.root, 'e2e-restore.trigger'),
      }
      const workspacePath = resolve(run.root, 'workspace')
      Object.assign(run.env, {
        SMR_E2E_MODE: 'create',
        SMR_E2E_ARTIFACT: artifacts.create,
        SMR_E2E_INPUT: artifacts.create,
        SMR_E2E_TRIGGER: triggers.create,
        SMR_E2E_WORKDIR: workspacePath,
      })

      server = await startWeb(run, await freePort())
      evidence.web = { port: Number(new URL(server.url).port), pid: server.pid, url: server.url }

      const { chromium } = await import('playwright')
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error)))
      await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(2_500)
      await dismissOnboarding(page)

      await configureTiers(page)
      const patchAfterSave = profilePatch(run)
      assert.match(patchAfterSave, /id: submodelrouter/)
      assert.match(patchAfterSave, /normal:\n\s+provider: scripted\n\s+model: child-model/)
      assert.match(patchAfterSave, /high:\n\s+provider: scripted\n\s+model: high-model\n\s+reasoningEffort: high/)
      evidence.steps.push({ step: 'configure-page-saved', patchDigest: digest(patchAfterSave) })

      // Trigger the scripted parent prompt only after the real page saved the tiers.
      writeFileSync(triggers.create, 'create')
      const created = await waitForArtifact(artifacts.create)
      assert.equal(created.mode, 'create')
      assert.equal(created.call.name, 'subagent')
      assert.match(created.call.arguments, /"effort":"high"/)
      assert.notEqual(created.result.isError, true)
      assert.equal(created.result.text, `started subagent ${created.childName} (effort: high)`)
      assert.deepEqual(created.childRequestHeader.config, {
        provider: 'scripted',
        model: 'high-model',
        reasoningEffort: 'high',
      })
      assert.ok(created.childEvents.includes('request/header'), created.childEvents.join(','))
      assert.ok(created.childEvents.includes('turn/end'), created.childEvents.join(','))
      evidence.steps.push({
        step: 'masked-delegation-created',
        parentId: created.parentId,
        childId: created.childId,
        childName: created.childName,
        childRoute: created.childRequestHeader.config,
        resultDigest: digest(created.result.text),
      })
      assert.deepEqual(pageErrors, [])

      // Stop the Web server before the standard profile mutation.
      await stopProcess(server.process)
      server = undefined

      const removed = run.dsh(['plugin', '--profile', 'web', 'remove', 'dsh-submodelrouter'])
      assert.equal(removed.status, 0, `${removed.stderr}\n${removed.stdout}`)
      const manifest = profileManifest(run)
      assert.equal(manifest.dependencies?.['dsh-submodelrouter'], undefined)
      assert.equal(manifest.dsh.profile.bundles.includes('dsh-submodelrouter'), false)
      const retainedPatch = profilePatch(run)
      assert.match(retainedPatch, /id: submodelrouter/)
      assert.match(retainedPatch, /model: high-model/)
      evidence.steps.push({
        step: 'plugin-uninstalled',
        manifestBundles: manifest.dsh.profile.bundles,
        retainedPatchDigest: digest(retainedPatch),
      })

      // Restart the same profile without the plugin and restore both histories.
      Object.assign(run.env, {
        SMR_E2E_MODE: 'restore',
        SMR_E2E_ARTIFACT: artifacts.restore,
        SMR_E2E_INPUT: artifacts.create,
        SMR_E2E_TRIGGER: triggers.restore,
      })
      const dumpWithoutPlugin = run.dsh(['--profile', 'web', '--dump-config'])
      assert.equal(dumpWithoutPlugin.status, 0, dumpWithoutPlugin.stderr)
      assert.doesNotMatch(dumpWithoutPlugin.stdout, /- id: submodelrouter\n/)
      evidence.dumpWithoutPluginDigest = digest(dumpWithoutPlugin.stdout)

      server = await startWeb(run, await freePort())
      evidence.restoredWeb = { port: Number(new URL(server.url).port), pid: server.pid, url: server.url }
      writeFileSync(triggers.restore, 'restore')
      const restored = await waitForArtifact(artifacts.restore)
      assert.equal(restored.mode, 'restore')
      assert.equal(restored.parentId, created.parentId)
      assert.equal(restored.childId, created.childId)
      assert.deepEqual(restored.call, created.call)
      assert.notEqual(restored.result?.isError, true)
      assert.equal(restored.result?.text, created.result.text)
      assert.ok(restored.parentEvents.includes('tool/call'), restored.parentEvents.join(','))
      assert.ok(restored.parentEvents.includes('tool/result'), restored.parentEvents.join(','))
      assert.ok(restored.childEvents.includes('request/header'), restored.childEvents.join(','))
      assert.ok(restored.childEvents.includes('turn/end'), restored.childEvents.join(','))
      assert.deepEqual(restored.childRequestHeader.config, {
        provider: 'scripted',
        model: 'high-model',
        reasoningEffort: 'high',
      })
      evidence.steps.push({
        step: 'histories-restored-without-plugin',
        parentId: restored.parentId,
        childId: restored.childId,
        childRoute: restored.childRequestHeader.config,
        parentEvents: restored.parentEvents,
        childEvents: restored.childEvents,
      })

      // Reopen both histories through the real Web UI after the cold restore.
      await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(2_500)
      await dismissOnboarding(page)
      await waitForText(page, 'scripted answer', 30_000)
      await page.getByText('scripted answer').first().evaluate((element) => (element.closest('button') ?? element).click())
      await waitForText(page, 'delegate now', 20_000)
      await waitForText(page, '1 subagent', 20_000)
      const parentBody = await page.locator('body').textContent()
      assert.match(parentBody, /e2e delegation/)
      assert.match(parentBody, /Coordinated subagents/)
      await domClick(page.getByRole('button', { name: '1 subagent' }))
      await page.waitForTimeout(1_000)
      await domClick(page.getByRole('button', { name: /Open e2e delegation in sidebar/ }))
      await waitForText(page, 'do a delegated task', 20_000)
      const childBody = await page.locator('body').textContent()
      assert.match(childBody, /delivered automatically if your parent is still online/)
      assert.match(childBody, /scripted answer/)
      evidence.steps.push({ step: 'histories-reopened-in-web-ui' })
      assert.deepEqual(pageErrors, [])
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
