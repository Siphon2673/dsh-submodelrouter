/**
 * Disposable DSH_HOME/Web-profile lifecycle for browser end-to-end tests.
 * Every DSH invocation goes through {@link runDsh}, which asserts that the
 * effective home is under the run's own temporary root before starting.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Create one unique disposable run.
 * @param {object} options - run options.
 * @param {string} options.repoRoot - absolute repository root.
 * @param {string} [options.label] - evidence label.
 * @returns {any} run handle.
 */
export function createDisposableRun(options) {
  const repoRoot = resolve(options.repoRoot)
  const runsParent = resolve(repoRoot, '.scratch/e2e-runs')
  const runId = `${options.label ?? 'e2e'}-${randomUUID()}`
  const root = resolve(runsParent, runId)
  const home = resolve(root, 'home')
  if (existsSync(root)) throw new Error(`refusing to reuse an existing disposable root: ${root}`)
  if (!root.startsWith(`${runsParent}/`) || root === runsParent) {
    throw new Error(`disposable root escaped the designated parent: ${root}`)
  }
  mkdirSync(home, { recursive: true })
  mkdirSync(resolve(root, 'env', 'corepack'), { recursive: true })
  mkdirSync(resolve(root, 'env', 'xdg-state'), { recursive: true })
  mkdirSync(resolve(root, 'env', 'xdg-cache'), { recursive: true })
  mkdirSync(resolve(root, 'env', 'xdg-data'), { recursive: true })
  mkdirSync(resolve(root, 'env', 'xdg-runtime'), { recursive: true, mode: 0o700 })
  mkdirSync(resolve(root, 'env', 'tmp'), { recursive: true })
  mkdirSync(resolve(root, 'env', 'user-home'), { recursive: true })
  mkdirSync(resolve(root, 'store'), { recursive: true })
  const owner = { runId, root, createdAt: new Date().toISOString(), repoRoot }
  writeFileSync(resolve(root, 'OWNER.json'), JSON.stringify(owner, null, 2))

  const env = {
    ...process.env,
    HOME: resolve(root, 'env', 'user-home'),
    DSH_HOME: home,
    COREPACK_HOME: resolve(root, 'env', 'corepack'),
    XDG_STATE_HOME: resolve(root, 'env', 'xdg-state'),
    XDG_CACHE_HOME: resolve(root, 'env', 'xdg-cache'),
    XDG_DATA_HOME: resolve(root, 'env', 'xdg-data'),
    XDG_RUNTIME_DIR: resolve(root, 'env', 'xdg-runtime'),
    TMPDIR: resolve(root, 'env', 'tmp'),
    npm_config_cache: resolve(root, 'env', 'npm-cache'),
    NPM_CONFIG_CACHE: resolve(root, 'env', 'npm-cache'),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  }
  const profileDir = resolve(home, 'profiles', 'web')

  return {
    runId,
    root,
    home,
    env,
    profileDir,
    dsh(args, runOptions = {}) {
      return runDsh(args, { env, runOptions, root, repoRoot })
    },
    /**
     * Remove the temporary root after re-verifying ownership.
     * @returns {void}
     */
    cleanup() {
      const marker = JSON.parse(readFileSync(resolve(root, 'OWNER.json'), 'utf8'))
      if (marker.runId !== runId || resolve(marker.root) !== root) {
        throw new Error(`ownership marker mismatch; refusing to delete ${root}`)
      }
      const runsParent = resolve(repoRoot, '.scratch/e2e-runs')
      if (!root.startsWith(`${runsParent}/`)) throw new Error(`refusing to delete outside ${runsParent}: ${root}`)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * Run one DSH CLI invocation with the disposable environment.
 * @param {string[]} args - CLI arguments.
 * @param {object} options - invocation options.
 * @returns {{ status: number, stdout: string, stderr: string }} result.
 */
export function runDsh(args, options) {
  const env = options.env
  const home = resolve(env.DSH_HOME)
  const expectedHome = options.root === undefined ? undefined : resolve(options.root, 'home')
  if (expectedHome !== undefined && home !== expectedHome) {
    throw new Error(`refusing DSH invocation with DSH_HOME ${home}; expected ${expectedHome}`)
  }
  const result = spawnSync(env.DSH_BIN ?? 'dsh', args, {
    env,
    encoding: 'utf8',
    timeout: options.runOptions?.timeout ?? 180_000,
    cwd: options.runOptions?.cwd ?? process.cwd(),
  })
  if (result.error !== undefined) throw result.error
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Initialize a fresh Web profile through the standard DSH command, then point
 * pnpm's store into the disposable root.
 * @param {any} run - disposable run.
 * @returns {void}
 */
export function initializeProfile(run) {
  const dumped = run.dsh(['--profile', 'web', '--dump-config'])
  if (dumped.status !== 0) throw new Error(`web profile initialization failed:\n${dumped.stderr}\n${dumped.stdout}`)
  writeFileSync(
    resolve(run.profileDir, '.npmrc'),
    `store-dir=${resolve(run.root, 'store')}\ncache-dir=${resolve(run.root, 'env', 'pnpm-cache')}\n`,
  )
}

/**
 * Install one local bundle through the standard plugin command.
 * @param {any} run - disposable run.
 * @param {string} spec - local package directory or registry spec.
 * @returns {void}
 */
export function installBundle(run, spec) {
  const result = run.dsh(['plugin', '--profile', 'web', 'add', spec])
  if (result.status !== 0) throw new Error(`plugin add failed for ${spec}:\n${result.stderr}\n${result.stdout}`)
}

/**
 * Boot the disposable Web profile on a loopback port and wait for its URL.
 * @param {any} run - disposable run.
 * @param {number} port - loopback port.
 * @returns {Promise<{ process: import('node:child_process').ChildProcess, url: string, log: () => string }>} server handle.
 */
export async function startWeb(run, port) {
  const expectedHome = resolve(run.root, 'home')
  if (resolve(run.env.DSH_HOME) !== expectedHome) {
    throw new Error(`refusing dsh web with DSH_HOME ${run.env.DSH_HOME}; expected ${expectedHome}`)
  }
  const child = spawn(run.env.DSH_BIN ?? 'dsh', ['web', '--no-open', '--port', String(port)], {
    env: run.env,
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    log += chunk
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)
    if (match !== null) return { process: child, pid: child.pid, url: match[1], log: () => log }
    if (child.exitCode !== null) throw new Error(`dsh web exited before startup:\n${log}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  child.kill('SIGTERM')
  throw new Error(`dsh web did not print its URL before the deadline:\n${log}`)
}

/**
 * Stop a managed server and wait for process exit.
 * @param {import('node:child_process').ChildProcess | undefined} child - server process.
 * @returns {Promise<void>}
 */
export async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}

/**
 * Persist sanitized evidence outside the disposable root.
 * @param {object} evidence - evidence record.
 * @returns {string} evidence path.
 */
export function writeEvidence(evidence, repoRoot) {
  const dir = resolve(repoRoot, '.scratch/submodelrouter/e2e-evidence')
  mkdirSync(dir, { recursive: true })
  const sanitized = JSON.stringify(evidence, null, 2).replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')
  const path = resolve(dir, `${evidence.runId}.json`)
  writeFileSync(path, sanitized)
  return path
}

/**
 * Stable short digest used in evidence, never for secrets.
 * @param {string} text - input.
 * @returns {string} hex digest prefix.
 */
export function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}
