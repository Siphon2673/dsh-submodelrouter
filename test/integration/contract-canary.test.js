/**
 * Contract canaries for the DSH surfaces the adapter depends on.
 *
 * Each test fails first when DSH changes the corresponding contract, and the
 * failure message names the exact difference: the detected output fields, the
 * leaked description copy, or the sentences missing from the plugin prompt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import {
  childIdentityField,
  isNativeSubagentDefinition,
  maskDescription,
  mentionsRemovedRouteField,
  nativeContractProblems,
  outputPropertyNames,
  promptSectionText,
} from '../../lib/definitions.js'
import { classifySelectedFailure, REASON_NOT_AUTHORIZED } from '../../lib/fallback.js'
import { ROUTE_FIELDS } from '../helpers/contract.js'
import { createHarness, PROVIDER } from '../helpers/harness.js'

test('canary: the native subagent identity contract', async () => {
  const h = await createHarness({ config: false })
  try {
    const native = h.native('subagent')
    assert.ok(native, 'the native "subagent" tool is not mounted')
    const problems = nativeContractProblems(native)
    assert.deepEqual(problems, [], `the native surface no longer matches the reviewed structure: ${problems.join('; ')}`)
    assert.equal(isNativeSubagentDefinition(native), true)
    const identity = childIdentityField(native)
    assert.equal(
      identity,
      'name',
      `expected the rc.2+ child identity field "name"; actual output fields are [${outputPropertyNames(native).join(', ')}]`,
    )
  } finally {
    await h.dispose()
  }
})

test('canary: the native description can be rewritten without route copy', async () => {
  const h = await createHarness({ config: false })
  try {
    const native = h.native('subagent')
    assert.ok(native, 'the native "subagent" tool is not mounted')
    const description = maskDescription(native.description)
    const leaked = ROUTE_FIELDS.filter((field) => description.includes(field))
    assert.deepEqual(
      leaked,
      [],
      `the masked description still names removed route fields ${leaked.join(', ')} (bare or backticked); actual description:\n${description}`,
    )
    const nativeSentences = native.description.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 0)
    const routeFree = nativeSentences.filter((sentence) => !mentionsRemovedRouteField(sentence))
    const missing = routeFree.filter((sentence) => !description.includes(sentence))
    assert.deepEqual(
      missing,
      [],
      `the masked description lost native delegation wording:\n${missing.map((sentence) => `- ${sentence}`).join('\n')}\nactual description:\n${description}`,
    )
    assert.match(description, /`normal` for routine, checkable, or cheap-to-redo work/)
    assert.match(description, /`high` for work whose result is directly trusted/)
  } finally {
    await h.dispose()
  }
})

test('canary: the plugin prompt covers every native tool:subagent sentence', async () => {
  const h = await createHarness({ config: false })
  try {
    const scope = scopeOf(h.agent.ctx)
    const assembly = await h.ctx.systemPrompt.assemble(assembleContextFor(h.agent))
    const section = assembly.sections.find((entry) => entry.name === 'tool:subagent')
    assert.ok(section, 'the native "tool:subagent" prompt section is missing')
    assert.ok(section.text.length > 0, 'the native "tool:subagent" prompt section is empty')
    const visible = h.ctx.tools
      .schemas(scope)
      .filter((tool) => tool.name === 'subagent' || tool.name === 'subagent_fork')
      .map((tool) => tool.name)
      .sort()
    const pluginText = promptSectionText(visible)
    const nativeSentences = section.text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 0)
    const missing = nativeSentences.filter((sentence) => !pluginText.includes(sentence))
    assert.deepEqual(
      missing,
      [],
      `DSH added prompt sentences the plugin does not contribute:\n${missing.map((sentence) => `- ${sentence}`).join('\n')}\n\nnative text:\n${section.text}\n\nplugin text:\n${pluginText}`,
    )
  } finally {
    await h.dispose()
  }
})

test('canary: a no-policy native allowlist rejection is recognized', async () => {
  const h = await createHarness({ config: false })
  try {
    const native = h.native('subagent')
    assert.ok(native, 'the native "subagent" tool is not mounted')
    const route = { provider: PROVIDER, model: 'high-model' }
    let actual
    try {
      await native.execute(
        { description: 'canary', prompt: 'allowlist canary', provider: route.provider, model: route.model },
        { agent: h.agent, signal: new AbortController().signal },
      )
    } catch (error) {
      actual = error
    }
    assert.ok(actual instanceof Error, 'the native no-policy allowlist rejection did not throw')
    assert.equal(
      classifySelectedFailure(actual, route),
      REASON_NOT_AUTHORIZED,
      `the native allowlist rejection is not classified; actual error: ${actual.name}: ${actual.message}`,
    )
  } finally {
    await h.dispose()
  }
})
