/**
 * Browser-half test harness: loads the real `client.js` lazy factory, mounts
 * its plugin against a fake client context, and renders the registered
 * `plugins.row.config` page with Testing Library in jsdom.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'

const requireFromHere = createRequire(import.meta.url)
const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })

let installed = false
/** Install the browser globals once per test process. */
function installDom() {
  if (installed) return
  installed = true
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  define('window', dom.window)
  define('document', dom.window.document)
  define('navigator', dom.window.navigator)
  define('HTMLElement', dom.window.HTMLElement)
  define('Node', dom.window.Node)
  define('Event', dom.window.Event)
  define('MouseEvent', dom.window.MouseEvent)
  define('getComputedStyle', dom.window.getComputedStyle)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
}

/**
 * Evaluate the lazy factory and mount its apply function on a fake context.
 * @param {object} [options] - fixture options.
 * @param {unknown} [options.nativeValue] - native Subagent authorization value.
 * @param {object} [options.catalog] - model catalog groups.
 * @param {'en' | 'zh'} [options.language] - active language.
 * @returns {Promise<any>} page harness.
 */
export async function createPageHarness(options = {}) {
  installDom()
  let bundle
  const window = dom.window
  window.__ModuleLoader__ = {
    load({ id, factory }) {
      assertId(id)
      bundle = factory((name) => {
        if (name === 'react') return React
        if (name === 'react/jsx-runtime') return requireFromHere('react/jsx-runtime')
        throw new Error(`unexpected client requirement: ${name}`)
      })
    },
  }
  new Function('window', source)(window)

  const nativeForm = createNativeForm(options.nativeValue ?? { enabled: false, allowedModels: [] })
  const catalog = options.catalog ?? {
    groups: [
      {
        id: 'scripted',
        name: 'Scripted provider',
        models: [
          { id: 'child-model', name: 'Child model', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } },
          { id: 'high-model', name: 'High model', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
          { id: 'plain-model', name: 'Plain model' },
        ],
      },
      {
        id: 'other',
        name: 'Other provider',
        models: [{ id: 'other-model', name: 'Other model' }],
      },
    ],
    failures: [],
  }
  const entries = []
  const listeners = []
  let language = options.language ?? 'en'
  const dictionaries = new Map()
  const disposers = []
  const ctx = {
    locale: {
      register(ns, dictionary) {
        dictionaries.set(ns, dictionary)
        return () => dictionaries.delete(ns)
      },
      bind(ns) {
        return (key) => {
          const dictionary = dictionaries.get(ns)
          return dictionary?.[language]?.[key] ?? dictionary?.en?.[key] ?? key
        }
      },
    },
    configForms: {
      get(ns) {
        if (ns === 'subagent-model-selection-settings') return nativeForm
        throw new Error(`unexpected configForms namespace: ${ns}`)
      },
    },
    remote: {
      session: {
        async modelCatalog() {
          return { ok: true, value: catalog }
        },
      },
      $on() {
        return () => {}
      },
    },
    slots: {
      inject(key, register) {
        if (key !== 'plugins.row.config') return () => {}
        return register()
      },
      register(options, component) {
        const entry = { options, component }
        entries.push(entry)
        return () => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        }
      },
    },
    on() {
      return () => {}
    },
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose ?? (() => {})
    },
    logger: { info() {}, warn() {}, error() {} },
  }

  await bundle.apply(ctx)

  const entry = entries.find((candidate) => candidate.options.key === 'dsh-submodelrouter#submodelrouter')
  if (entry === undefined) throw new Error('the plugin did not register its row configuration page')

  /**
   * Render the page with a caller-owned owner form.
   * @param {any} owner - owner form double.
   * @returns {Promise<any>} Testing Library view and helpers.
   */
  async function render(owner) {
    const testing = await import('@testing-library/react')
    const t = ctx.locale.bind('submodelrouter')
    const Component = entry.component
    const element = (nextOwner) =>
      React.createElement(Component, {
        t,
        view: 'page',
        form: { state: nextOwner.state, mutate: nextOwner.mutate },
      })
    const page = testing.render(element(owner))
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    page.rerenderOwner = (nextOwner) => page.rerender(element(nextOwner))
    return page
  }

  const testing = await import('@testing-library/react')
  return {
    ctx,
    nativeForm,
    entry,
    dictionaries,
    render,
    testing,
    setLanguage(next) {
      language = next
    },
    cleanup() {
      testing.cleanup()
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

function assertId(id) {
  if (id !== 'dsh-submodelrouter') throw new Error(`unexpected client bundle id: ${id}`)
}

/**
 * Create a native authorization form double. Writes are recorded and refused:
 * the plugin must only read this namespace.
 * @param {any} value - initial value.
 * @returns {any} form double.
 */
export function createNativeForm(value) {
  let snapshot = { status: 'ready', value, revision: 1, writable: true }
  const listeners = new Set()
  const writes = []
  const publish = () => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    writes,
    update(next) {
      snapshot = { ...snapshot, value: next, revision: snapshot.revision + 1 }
      publish()
    },
    set(field, value) {
      writes.push({ op: 'set', field, value })
      throw new Error('the plugin must not write the native authorization namespace')
    },
    unset(field) {
      writes.push({ op: 'unset', field })
      throw new Error('the plugin must not write the native authorization namespace')
    },
    mutate(ops, revision) {
      writes.push({ op: 'mutate', ops, revision })
      throw new Error('the plugin must not write the native authorization namespace')
    },
  }
}

/**
 * Create the row's owner form double.
 * @param {any} value - initial stored value.
 * @param {object} [options] - behavior options.
 * @returns {any} owner form double.
 */
export function createOwnerForm(value, options = {}) {
  let snapshot = {
    status: options.status ?? 'ready',
    value,
    revision: options.revision ?? 1,
    writable: options.writable ?? true,
  }
  const calls = []
  const applyOps = (current, ops) => {
    let next = structuredClone(current ?? {})
    for (const op of ops) {
      const [tier] = op.path
      if (op.op === 'unset') delete next[tier]
      else next[tier] = structuredClone(op.value)
    }
    return next
  }
  let accepted = options.accept ?? true
  return {
    get state() {
      return snapshot
    },
    get calls() {
      return calls
    },
    get accepted() {
      return accepted
    },
    snapshot() {
      return snapshot
    },
    setRevision(revision) {
      snapshot = { ...snapshot, revision }
    },
    accept(value = true) {
      accepted = value
    },
    async mutate(ops, revision) {
      calls.push({ ops, revision })
      if (!accepted) return false
      if (revision !== undefined && revision !== snapshot.revision) return false
      snapshot = { ...snapshot, value: applyOps(snapshot.value, ops), revision: snapshot.revision + 1 }
      return true
    },
  }
}
