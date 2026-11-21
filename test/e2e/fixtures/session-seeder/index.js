/**
 * Disposable Web-profile test host: creates or restores one scripted
 * parent/child delegation through the same Host services the Web client uses.
 * It writes a sanitized JSON result for the Playwright test to assert on.
 *
 * The test decides *when* the operation runs by creating a trigger file, so it
 * can configure the plugin through the real Configure page first.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'smr-e2e-session-seeder'
export const inject = ['agents', 'sessionController', 'sessionQuery', 'workspaceController', 'subagents']

/** Read one required environment setting. */
function required(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`)
  return value
}

/** Atomically publish the seeder artifact. */
async function publish(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2))
  await rename(temporary, path)
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Wait for the test-controlled trigger file. */
async function waitForTrigger(path, deadline) {
  while (Date.now() < deadline) {
    if (await exists(path)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`the seeder trigger ${path} was not created before the deadline`)
}

/** Read one session's durable history through the production query service. */
async function history(ctx, sessionId) {
  const observed = await ctx.sessionQuery.observeSession(sessionId)
  try {
    return { header: observed.header, events: observed.events }
  } finally {
    observed[Symbol.dispose]()
  }
}

/** Read the text blocks of a session event's message content. */
function messageText(data) {
  const content = data?.message?.content ?? data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Wait for one durable child history to record its request header and turn end. */
async function waitForChildHistory(ctx, childId, deadline) {
  let lastTypes = []
  while (Date.now() < deadline) {
    const observed = await history(ctx, childId)
    lastTypes = observed.events.map((event) => event.type)
    const header = observed.events.find((event) => event.type === 'request/header')
    const ended = observed.events.some((event) => event.type === 'turn/end')
    if (header !== undefined && ended) return { header, events: observed.events }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`child ${childId} did not record a completed request before the deadline; events=${JSON.stringify(lastTypes)}`)
}

/** Create one parent Session, prompt the scripted delegation, and record its ids. */
async function create(ctx, artifact) {
  const workspacePath = required('SMR_E2E_WORKDIR')
  await mkdir(workspacePath, { recursive: true })
  const { workspace } = await ctx.workspaceController.create({ path: workspacePath })
  const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.workspaceId })
  await ctx.sessionController.prompt(
    {
      requestId: 'smr-e2e-seed-prompt',
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'delegate now' }],
    },
    AbortSignal.timeout(120_000),
  )
  const parent = ctx.agents.get(sessionId)
  if (parent === undefined) throw new Error(`the seeded parent ${sessionId} is not live`)
  await parent.whenIdle()

  const deadline = Date.now() + 60_000
  let child
  while (Date.now() < deadline && child === undefined) {
    const descendants = await ctx.subagents.listDescendants(sessionId)
    child = descendants.find((entry) => entry.kind === 'child' && entry.depth === 1)
    if (child === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (child === undefined) throw new Error('the scripted delegation created no child')
  const childId = String(child.id)
  const childName = child.name ?? child.path ?? childId
  const childHistory = await waitForChildHistory(ctx, childId, deadline)
  const parentHistory = await history(ctx, sessionId)
  const result = parentHistory.events.find((event) => event.type === 'tool/result')
  const call = parentHistory.events.find((event) => event.type === 'tool/call')
  if (call === undefined || result === undefined) throw new Error('the seeded parent has no subagent tool result')
  await publish(artifact, {
    mode: 'create',
    parentId: sessionId,
    childId,
    childName,
    call: { name: call.data.name, arguments: call.data.arguments },
    result: { isError: result.data.isError, text: messageText(result.data) },
    childRequestHeader: childHistory.header.data.header,
    childEvents: childHistory.events.map((event) => event.type),
  })
}

/** Restore both histories through the production Agent registry. */
async function restore(ctx, artifact) {
  const input = JSON.parse(await readFile(required('SMR_E2E_INPUT'), 'utf8'))
  const resumedParent = await ctx.agents.resume({ resumeSessionId: input.parentId })
  const resumedChild = await ctx.agents.resume({
    resumeSessionId: input.childId,
    parentAgent: resumedParent.agent,
  })
  const parentHistory = await history(ctx, input.parentId)
  const childHistory = await history(ctx, input.childId)
  const header = childHistory.events.find((event) => event.type === 'request/header')
  if (header === undefined) throw new Error('the restored child has no request header')
  const result = parentHistory.events.find((event) => event.type === 'tool/result')
  const call = parentHistory.events.find((event) => event.type === 'tool/call')
  await publish(artifact, {
    mode: 'restore',
    parentId: String(resumedParent.agent.id),
    childId: String(resumedChild.agent.id),
    parentEvents: parentHistory.events.map((event) => event.type),
    childEvents: childHistory.events.map((event) => event.type),
    call: call === undefined ? undefined : { name: call.data.name, arguments: call.data.arguments },
    result: result === undefined ? undefined : { isError: result.data.isError, text: messageText(result.data) },
    childRequestHeader: header.data.header,
  })
  await resumedChild.dispose()
  await resumedParent.dispose()
}

export function apply(ctx) {
  const mode = process.env.SMR_E2E_MODE
  if (mode !== 'create' && mode !== 'restore') return
  const artifact = required('SMR_E2E_ARTIFACT')
  const trigger = required('SMR_E2E_TRIGGER')
  const timer = setTimeout(() => {
    waitForTrigger(trigger, Date.now() + 180_000)
      .then(() => (mode === 'create' ? create(ctx, artifact) : restore(ctx, artifact)))
      .catch(async (error) => {
        await publish(artifact, {
          mode,
          error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error),
        }).catch(() => {})
      })
  }, 500)
  ctx.effect(() => () => clearTimeout(timer), 'smr-e2e-session-seeder timer')
}
