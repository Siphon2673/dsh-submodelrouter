import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerForm, createNativeForm, createPageHarness } from '../helpers/client.js'

/** Open a page with one harness-owned owner form. */
async function openPage(harness, value = {}) {
  const owner = createOwnerForm(value)
  const view = await harness.render(owner)
  return { owner, view, ...harness.testing }
}

test('disabled authorization shows setup guidance and the native path', async () => {
  const harness = await createPageHarness({ nativeValue: { enabled: false, allowedModels: [] } })
  try {
    const { view } = await openPage(harness)
    assert.ok(await view.findByText('Subagent model authorization is disabled.'))
    assert.ok(view.getByText(/Enable Model selection under Plugins → Subagent/))
    assert.ok(view.getByText(/Native settings: Plugins → Subagent/))
    const normalProvider = view.getByLabelText('Normal Provider')
    assert.deepEqual(
      Array.from(normalProvider.options).map((option) => option.value),
      [''],
    )
    assert.ok(view.getByText(/Only currently authorized routes are offered here/))
    assert.equal(harness.nativeForm.writes.length, 0)
  } finally {
    harness.cleanup()
  }
})

test('enabled authorization offers only currently allowed routes', async () => {
  const harness = await createPageHarness({
    nativeValue: {
      enabled: true,
      allowedModels: [
        { provider: 'scripted', model: 'child-model' },
        { provider: 'scripted', model: 'high-model' },
      ],
    },
  })
  try {
    const { view } = await openPage(harness)
    assert.ok(await view.findByText('Subagent model authorization is enabled.'))
    assert.ok(view.getByText(/Plugins → Subagent/))
    const provider = view.getByLabelText('Normal Provider')
    assert.deepEqual(
      Array.from(provider.options).map((option) => option.value),
      ['', 'scripted'],
    )
    const { fireEvent } = harness.testing
    fireEvent.change(provider, { target: { value: 'scripted' } })
    const model = view.getByLabelText('Normal Model')
    assert.deepEqual(
      Array.from(model.options).map((option) => option.value),
      ['', 'child-model', 'high-model'],
    )
    assert.equal(harness.nativeForm.writes.length, 0)
  } finally {
    harness.cleanup()
  }
})

test('effort choices follow the model, reset on route change, and disappear when unsupported', async () => {
  const harness = await createPageHarness({
    nativeValue: {
      enabled: true,
      allowedModels: [
        { provider: 'scripted', model: 'child-model' },
        { provider: 'scripted', model: 'high-model' },
        { provider: 'scripted', model: 'plain-model' },
        { provider: 'other', model: 'other-model' },
      ],
    },
  })
  try {
    const { owner, view } = await openPage(harness, {
      normal: { provider: 'scripted', model: 'child-model', reasoningEffort: 'low' },
    })
    const { fireEvent, waitFor } = harness.testing
    assert.equal(view.getByLabelText('Normal Reasoning effort').value, 'low')
    assert.deepEqual(
      Array.from(view.getByLabelText('Normal Reasoning effort').options).map((option) => option.value),
      ['', 'low'],
    )

    fireEvent.change(view.getByLabelText('Normal Model'), { target: { value: 'plain-model' } })
    assert.equal(view.queryByLabelText('Normal Reasoning effort'), null)
    assert.equal(view.getByLabelText('Normal Model').value, 'plain-model')

    fireEvent.change(view.getByLabelText('Normal Model'), { target: { value: 'high-model' } })
    assert.deepEqual(
      Array.from(view.getByLabelText('Normal Reasoning effort').options).map((option) => option.value),
      ['', 'low', 'high'],
    )
    assert.equal(view.getByLabelText('Normal Reasoning effort').value, '')

    fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'other' } })
    await waitFor(() => assert.equal(view.getByLabelText('Normal Model').value, ''))
    assert.deepEqual(
      Array.from(view.getByLabelText('Normal Model').options).map((option) => option.value),
      ['', 'other-model'],
    )
    assert.equal(view.queryByLabelText('Normal Reasoning effort'), null)
    assert.equal(owner.calls.length, 0)
  } finally {
    harness.cleanup()
  }
})

test('both tiers can use one route with different efforts', async () => {
  const harness = await createPageHarness({
    nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'high-model' }] },
  })
  try {
    const { view } = await openPage(harness, {
      normal: { provider: 'scripted', model: 'high-model', reasoningEffort: 'low' },
      high: { provider: 'scripted', model: 'high-model', reasoningEffort: 'high' },
    })
    assert.equal(view.getByLabelText('Normal Reasoning effort').value, 'low')
    assert.equal(view.getByLabelText('High Reasoning effort').value, 'high')
    assert.equal(view.getByLabelText('Normal Model').value, 'high-model')
    assert.equal(view.getByLabelText('High Model').value, 'high-model')
  } finally {
    harness.cleanup()
  }
})

test('saved but unauthorized or unsupported values stay visible and marked', async () => {
  const harness = await createPageHarness({
    nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
  })
  try {
    const { view } = await openPage(harness, {
      high: { provider: 'scripted', model: 'high-model', reasoningEffort: 'ultra' },
    })
    const model = view.getByLabelText('High Model')
    assert.equal(model.value, 'high-model')
    assert.match(
      Array.from(model.options).find((option) => option.value === 'high-model').textContent,
      /not currently allowed/,
    )
    assert.match(view.container.textContent, /Configured · not currently allowed/)
    assert.match(
      Array.from(view.getByLabelText('High Reasoning effort').options).find((option) => option.value === 'ultra')
        .textContent,
      /not currently supported/,
    )
  } finally {
    harness.cleanup()
  }
})

test('a saved route that disappeared from the catalog stays visible and marked unavailable', async () => {
  const harness = await createPageHarness({
    nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'high-model' }] },
    catalog: {
      groups: [
        {
          id: 'scripted',
          name: 'Scripted provider',
          models: [{ id: 'child-model', name: 'Child model' }],
        },
      ],
      failures: [],
    },
  })
  try {
    const { view } = await openPage(harness, {
      high: { provider: 'scripted', model: 'high-model', reasoningEffort: 'high' },
    })
    const model = view.getByLabelText('High Model')
    assert.match(
      Array.from(model.options).find((option) => option.value === 'high-model').textContent,
      /currently unavailable/,
    )
    assert.match(view.container.textContent, /Configured · currently unavailable/)
    assert.match(view.container.textContent, /Saved reasoning effort: high \(not currently supported\)/)
  } finally {
    harness.cleanup()
  }
})

test('one Save persists both tiers with the draft revision and writes no native authorization', async () => {
  const harness = await createPageHarness({
    nativeValue: {
      enabled: true,
      allowedModels: [
        { provider: 'scripted', model: 'child-model' },
        { provider: 'scripted', model: 'high-model' },
      ],
    },
  })
  try {
    const { owner, view } = await openPage(harness, {})
    const { fireEvent, waitFor } = harness.testing
    fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'scripted' } })
    fireEvent.change(view.getByLabelText('Normal Model'), { target: { value: 'child-model' } })
    fireEvent.change(view.getByLabelText('High Provider'), { target: { value: 'scripted' } })
    fireEvent.change(view.getByLabelText('High Model'), { target: { value: 'high-model' } })
    fireEvent.change(view.getByLabelText('High Reasoning effort'), { target: { value: 'high' } })

    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    await waitFor(() => assert.ok(view.getByText('Saved.')))
    assert.equal(owner.calls.length, 1)
    assert.equal(owner.calls[0].revision, 1)
    assert.deepEqual(owner.calls[0].ops, [
      { op: 'set', path: ['normal'], value: { provider: 'scripted', model: 'child-model' } },
      {
        op: 'set',
        path: ['high'],
        value: { provider: 'scripted', model: 'high-model', reasoningEffort: 'high' },
      },
    ])
    assert.equal(harness.nativeForm.writes.length, 0)
  } finally {
    harness.cleanup()
  }
})

test('unsaved edits are discarded when the page is left', async () => {
  const harness = await createPageHarness({
    nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
  })
  try {
    const owner = createOwnerForm({})
    let view = await harness.render(owner)
    const { fireEvent } = harness.testing
    fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'scripted' } })
    assert.equal(view.getByLabelText('Normal Provider').value, 'scripted')
    view.unmount()

    view = await harness.render(owner)
    assert.equal(view.getByLabelText('Normal Provider').value, '')
    assert.equal(owner.calls.length, 0)
  } finally {
    harness.cleanup()
  }
})

test('a stale revision is reported instead of overwriting newer settings', async () => {
  const harness = await createPageHarness({
    nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
  })
  try {
    const owner = createOwnerForm({})
    const { view } = await openPage(harness, {})
    const { fireEvent, waitFor } = harness.testing
    fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'scripted' } })
    fireEvent.change(view.getByLabelText('Normal Model'), { target: { value: 'child-model' } })
    owner.setRevision(2)
    view.rerenderOwner(owner)
    await waitFor(() => assert.ok(view.getByRole('alert')))
    assert.match(view.getByRole('alert').textContent, /changed elsewhere/)
    const save = view.getByRole('button', { name: 'Save' })
    assert.equal(save.disabled, true)
    fireEvent.click(save)
    assert.equal(owner.calls.length, 0)
  } finally {
    harness.cleanup()
  }
})

test('a read-only deployment disables Save', async () => {
  const harness = await createPageHarness({
    nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
  })
  try {
    const owner = createOwnerForm({}, { writable: false })
    const view = await harness.render(owner)
    assert.ok(await view.findByText('This deployment stores settings read-only.'))
    assert.equal(view.getByRole('button', { name: 'Save' }).disabled, true)
  } finally {
    harness.cleanup()
  }
})

test('an unavailable form explains the state', async () => {
  const harness = await createPageHarness()
  try {
    const owner = createOwnerForm({}, { status: 'unavailable' })
    const view = await harness.render(owner)
    assert.ok(await view.findByText('This plugin is not loaded, so its configuration is unavailable right now.'))
  } finally {
    harness.cleanup()
  }
})

test('the page renders the same states and actions in Simplified Chinese', async () => {
  const harness = await createPageHarness({
    language: 'zh',
    nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
  })
  try {
    const { view } = await openPage(harness, {})
    assert.ok(await view.findByText('Effort 档位'))
    assert.ok(view.getByText('Subagent 模型授权已启用。'))
    assert.ok(view.getByText(/原生设置: Plugins → Subagent/))
    assert.ok(view.getByText(/授权在 Session 启动时记录/))
    assert.ok(view.getByRole('button', { name: '保存' }))
    assert.ok(view.getByLabelText('Normal Provider'))
  } finally {
    harness.cleanup()
  }
})

test('a partial catalog load is reported without hiding saved routes', async () => {
  const harness = await createPageHarness({
    nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
    catalog: {
      groups: [
        {
          id: 'scripted',
          name: 'Scripted provider',
          models: [{ id: 'child-model', name: 'Child model' }],
        },
      ],
      failures: [{ provider: 'broken', message: 'failed to load' }],
    },
  })
  try {
    const { view } = await openPage(harness, {
      normal: { provider: 'scripted', model: 'child-model' },
    })
    assert.ok(await view.findByText(/Some provider metadata could not be loaded/))
    assert.equal(view.container.querySelector('select[aria-label="Normal Model"]').value, 'child-model')
  } finally {
    harness.cleanup()
  }
})

test('an incomplete tier blocks Save and is never silently dropped', async () => {
  const harness = await createPageHarness({
    nativeValue: {
      enabled: true,
      allowedModels: [
        { provider: 'scripted', model: 'child-model' },
        { provider: 'scripted', model: 'high-model' },
      ],
    },
  })
  try {
    const { owner, view } = await openPage(harness, {
      high: { provider: 'scripted', model: 'child-model' },
    })
    const { fireEvent } = harness.testing
    fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'scripted' } })
    assert.ok(await view.findByText('Choose both a provider and a model, or clear the tier.'))
    const save = view.getByRole('button', { name: 'Save' })
    assert.equal(save.disabled, true)
    fireEvent.click(save)
    assert.equal(owner.calls.length, 0)
    assert.equal(view.getByLabelText('Normal Provider').value, 'scripted')
    assert.equal(view.getByLabelText('Normal Model').value, '')
  } finally {
    harness.cleanup()
  }
})

test('Simplified Chinese covers disabled, empty, conflict, and failure states', async () => {
  {
    const harness = await createPageHarness({
      language: 'zh',
      nativeValue: { enabled: false, allowedModels: [] },
    })
    try {
      const { view } = await openPage(harness)
      assert.ok(await view.findByText('Subagent 模型授权已停用。'))
      assert.ok(view.getByText(/请在 Plugins → Subagent 中启用 Model selection/))
    } finally {
      harness.cleanup()
    }
  }
  {
    const harness = await createPageHarness({
      language: 'zh',
      nativeValue: { enabled: true, allowedModels: [] },
    })
    try {
      const { view } = await openPage(harness)
      assert.ok(await view.findByText('Subagent 模型授权没有可用路由。'))
      assert.ok(view.getByText(/当前还没有已授权的路由/))
    } finally {
      harness.cleanup()
    }
  }
  {
    const harness = await createPageHarness({
      language: 'zh',
      nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
    })
    try {
      const owner = createOwnerForm({})
      const view = await harness.render(owner)
      const { fireEvent, waitFor } = harness.testing
      fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'scripted' } })
      fireEvent.change(view.getByLabelText('Normal Model'), { target: { value: 'child-model' } })
      owner.setRevision(2)
      view.rerenderOwner(owner)
      await waitFor(() => assert.ok(view.getByRole('alert')))
      assert.match(view.getByRole('alert').textContent, /已在别处变更/)
      assert.equal(view.getByRole('button', { name: '保存' }).disabled, true)
    } finally {
      harness.cleanup()
    }
  }
  {
    const harness = await createPageHarness({
      language: 'zh',
      nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
    })
    try {
      const owner = createOwnerForm({})
      owner.accept(false)
      const view = await harness.render(owner)
      const { fireEvent, waitFor } = harness.testing
      fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'scripted' } })
      fireEvent.change(view.getByLabelText('Normal Model'), { target: { value: 'child-model' } })
      fireEvent.click(view.getByRole('button', { name: '保存' }))
      await waitFor(() => assert.ok(view.getByText('Host 未接受这次修改。')))
      assert.equal(owner.calls.length, 1)
    } finally {
      harness.cleanup()
    }
  }
})

test('Simplified Chinese covers saved, read-only, incomplete, and catalog states', async () => {
  {
    const harness = await createPageHarness({
      language: 'zh',
      nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
    })
    try {
      const { owner, view } = await openPage(harness, {})
      const { fireEvent, waitFor } = harness.testing
      fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'scripted' } })
      fireEvent.change(view.getByLabelText('Normal Model'), { target: { value: 'child-model' } })
      fireEvent.click(view.getByRole('button', { name: '保存' }))
      await waitFor(() => assert.ok(view.getByText('已保存。')))
      assert.equal(owner.calls.length, 1)
    } finally {
      harness.cleanup()
    }
  }
  {
    const harness = await createPageHarness({
      language: 'zh',
      nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
    })
    try {
      const owner = createOwnerForm({}, { writable: false })
      const view = await harness.render(owner)
      assert.ok(await view.findByText('此部署以只读方式保存设置。'))
      assert.equal(view.getByRole('button', { name: '保存' }).disabled, true)
    } finally {
      harness.cleanup()
    }
  }
  {
    const harness = await createPageHarness({
      language: 'zh',
      nativeValue: {
        enabled: true,
        allowedModels: [
          { provider: 'scripted', model: 'child-model' },
          { provider: 'scripted', model: 'high-model' },
        ],
      },
    })
    try {
      const { view } = await openPage(harness, {
        high: { provider: 'scripted', model: 'child-model' },
      })
      const { fireEvent } = harness.testing
      fireEvent.change(view.getByLabelText('Normal Provider'), { target: { value: 'scripted' } })
      assert.ok(await view.findByText('请同时选择 provider 和 model，或清空该档位。'))
      assert.equal(view.getByRole('button', { name: '保存' }).disabled, true)
    } finally {
      harness.cleanup()
    }
  }
  {
    const harness = await createPageHarness({
      language: 'zh',
      nativeValue: { enabled: true, allowedModels: [{ provider: 'scripted', model: 'child-model' }] },
      catalog: {
        groups: [{ id: 'scripted', name: 'Scripted provider', models: [{ id: 'child-model', name: 'Child model' }] }],
        failures: [{ provider: 'broken', message: 'failed to load' }],
      },
    })
    try {
      const { view } = await openPage(harness, {})
      assert.ok(await view.findByText(/部分 provider 元数据未能加载/))
    } finally {
      harness.cleanup()
    }
  }
})
