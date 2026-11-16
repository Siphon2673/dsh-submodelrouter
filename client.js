window.__ModuleLoader__.load({
  id: 'dsh-submodelrouter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'submodelrouter'
    /** Native Subagent authorization namespace (owned by the native tool). */
    const NATIVE_NS = 'subagent-model-selection-settings'
    /** Pinned native settings path shown on the page. */
    const NATIVE_PATH = 'Plugins → Subagent'
    /** Row configuration slot key. */
    const ROW_KEY = 'dsh-submodelrouter#submodelrouter'

    const en = {
      summary: 'Choose the Normal and High routes used by subagent effort tiers.',
      title: 'Effort tiers',
      intro:
        'Choose one provider and model for each delegation tier. The plugin reads Subagent authorization; it never changes it.',
      authLoading: 'Reading Subagent authorization…',
      authUnavailable: 'Subagent authorization settings are not available in this deployment.',
      authEnabled: 'Subagent model authorization is enabled.',
      authDisabled: 'Subagent model authorization is disabled.',
      authEmpty: 'Subagent model authorization has no routes.',
      authEnableHint:
        'Enable Model selection under Plugins → Subagent and add at least one route. Only currently authorized routes are offered here.',
      authSessionHint:
        'Authorization is recorded when a Session starts. An existing Session keeps its recorded authorization; a route it does not authorize falls back to the parent route with a warning.',
      authPathLabel: 'Native settings',
      authPath: NATIVE_PATH,
      normalTitle: 'Normal',
      normalHint: 'Routine, checkable, or cheap-to-redo work.',
      highTitle: 'High',
      highHint: 'Work whose result is directly trusted or whose errors are expensive.',
      provider: 'Provider',
      model: 'Model',
      effort: 'Reasoning effort',
      effortDefault: 'Default / native inheritance',
      notConfigured: 'Not configured',
      notAllowed: 'not currently allowed',
      unavailable: 'currently unavailable',
      notSupported: 'not currently supported',
      unsetProvider: 'Not configured',
      unsetModel: 'Not configured',
      savedEffort: 'Saved reasoning effort',
      catalogIssue: 'Some provider metadata could not be loaded. Saved routes stay visible.',
      useDefaultEffort: 'Use default',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard changes',
      saved: 'Saved.',
      failed: 'The Host did not accept this change.',
      conflict: 'These settings changed elsewhere. Discard this draft and review the newer values before saving.',
      readOnly: 'This deployment stores settings read-only.',
      unavailableForm: 'This plugin is not loaded, so its configuration is unavailable right now.',
      loadingForm: 'Loading configuration…',
      noRoutes: 'No authorized routes are available yet.',
      incompleteTier: 'Choose both a provider and a model, or clear the tier.',
      configured: 'Configured',
    }

    const zh = {
      summary: '为子代理的两档 effort 选择 Normal 与 High 路由。',
      title: 'Effort 档位',
      intro: '为两个委派档位各选择一个 provider 和 model。插件只读取 Subagent 授权，不会修改它。',
      authLoading: '正在读取 Subagent 授权…',
      authUnavailable: '此部署未提供 Subagent 授权设置。',
      authEnabled: 'Subagent 模型授权已启用。',
      authDisabled: 'Subagent 模型授权已停用。',
      authEmpty: 'Subagent 模型授权没有可用路由。',
      authEnableHint: '请在 Plugins → Subagent 中启用 Model selection 并添加至少一条路由。此处只提供当前已授权的路由。',
      authSessionHint:
        '授权在 Session 启动时记录。已存在的 Session 会保留它记录的授权；未授权的路由会带警告回退到父路由。',
      authPathLabel: '原生设置',
      authPath: NATIVE_PATH,
      normalTitle: 'Normal',
      normalHint: '常规、可检查或容易重做的工作。',
      highTitle: 'High',
      highHint: '结果会被直接信任，或错误代价高昂的工作。',
      provider: 'Provider',
      model: 'Model',
      effort: 'Reasoning effort',
      effortDefault: '默认 / 原生继承',
      notConfigured: '未配置',
      notAllowed: '当前未授权',
      unavailable: '当前不可用',
      notSupported: '当前不支持',
      unsetProvider: '未配置',
      unsetModel: '未配置',
      savedEffort: '已保存的 reasoning effort',
      catalogIssue: '部分 provider 元数据未能加载。已保存的路由仍会显示。',
      useDefaultEffort: '改用默认',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saved: '已保存。',
      failed: 'Host 未接受这次修改。',
      conflict: '这些设置已在别处变更。请放弃草稿并查看较新的值后再保存。',
      readOnly: '此部署以只读方式保存设置。',
      unavailableForm: '插件当前未加载，因此配置不可用。',
      loadingForm: '正在加载配置…',
      noRoutes: '当前还没有已授权的路由。',
      incompleteTier: '请同时选择 provider 和 model，或清空该档位。',
      configured: '已配置',
    }

    const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

    /** Stable identity for one exact route. */
    function routeKey(route) {
      return `${route.provider}\u0000${route.model}`
    }

    /** Normalize one stored tier for display and comparison. */
    function normalizeTier(value) {
      const tier = value !== null && typeof value === 'object' ? value : {}
      return {
        provider: typeof tier.provider === 'string' ? tier.provider : '',
        model: typeof tier.model === 'string' ? tier.model : '',
        reasoningEffort: typeof tier.reasoningEffort === 'string' ? tier.reasoningEffort : undefined,
      }
    }

    /** Normalize the stored two-tier value. */
    function normalizeConfig(value) {
      return {
        normal: normalizeTier(value?.normal),
        high: normalizeTier(value?.high),
      }
    }

    /** Whether two normalized tiers are identical. */
    function sameTier(left, right) {
      return (
        left.provider === right.provider &&
        left.model === right.model &&
        left.reasoningEffort === right.reasoningEffort
      )
    }

    /** Whether two normalized configurations are identical. */
    function sameConfig(left, right) {
      return sameTier(left.normal, right.normal) && sameTier(left.high, right.high)
    }

    /** A tier with only one half of an exact route is an invalid partial draft. */
    function tierIsPartial(tier) {
      return (tier.provider === '') !== (tier.model === '')
    }

    /** Locate one exact catalog model. */
    function catalogModelOf(catalog, route) {
      if (route.provider === '' || route.model === '') return undefined
      for (const group of catalog.groups) {
        if (group.id !== route.provider) continue
        for (const model of group.models) {
          if (model.id === route.model) return model
        }
      }
      return undefined
    }

    /** Locate one provider's display name. */
    function providerNameOf(catalog, provider) {
      return catalog.groups.find((group) => group.id === provider)?.name ?? provider
    }

    /** Current native allowlist routes, only when authorization is enabled. */
    function allowedRoutesOf(nativeValue) {
      if (nativeValue?.enabled !== true || !Array.isArray(nativeValue.allowedModels)) return []
      return nativeValue.allowedModels.filter(
        (route) =>
          route !== null &&
          typeof route === 'object' &&
          typeof route.provider === 'string' &&
          route.provider.length > 0 &&
          typeof route.model === 'string' &&
          route.model.length > 0,
      )
    }

    /** Use a config form snapshot as an external store. */
    function useFormSnapshot(form) {
      return React.useSyncExternalStore(
        React.useCallback((listener) => form.subscribe(listener), [form]),
        React.useCallback(() => form.getSnapshot(), [form]),
        React.useCallback(() => form.getSnapshot(), [form]),
      )
    }

    /** Load the native model catalog, and reload it on the Host's own signals. */
    function useCatalog(ctx) {
      const [state, setState] = React.useState({ status: 'loading', groups: [], failures: 0 })
      React.useEffect(() => {
        let alive = true
        let generation = 0
        const load = async () => {
          const current = ++generation
          try {
            const response = await ctx.remote.session.modelCatalog()
            if (!alive || current !== generation) return
            if (response?.ok) {
              setState({
                status: 'ready',
                groups: Array.isArray(response.value?.groups) ? response.value.groups : [],
                failures: Array.isArray(response.value?.failures) ? response.value.failures.length : 0,
              })
            } else {
              setState((previous) => ({ ...previous, status: 'error' }))
            }
          } catch {
            if (alive) setState((previous) => ({ ...previous, status: 'error' }))
          }
        }
        load()
        const disposers = []
        if (typeof ctx.remote?.$on === 'function') {
          disposers.push(ctx.remote.$on('llm/adapters-updated', load))
          disposers.push(ctx.remote.$on('settings/document-updated', load))
        }
        disposers.push(ctx.on('connection/reset', load))
        return () => {
          alive = false
          generation += 1
          for (const dispose of disposers) dispose()
        }
      }, [ctx])
      return state
    }

    /** A labelled native select. */
    function labelled(label, select) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 } },
        h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, label),
        select,
      )
    }

    /** One route editor with provider, model, and optional effort. */
    function TierEditor(props) {
      const { t, title, hint, value, routes, catalog, disabled, onChange, onClearEffort } = props
      const allowedKeys = new Set(routes.map(routeKey))
      const currentProvider = value.provider
      const currentModel = value.model
      const allowedProviders = []
      for (const route of routes) if (!allowedProviders.includes(route.provider)) allowedProviders.push(route.provider)

      const providerOptions = [{ value: '', label: t('unsetProvider') }]
      for (const provider of allowedProviders) {
        providerOptions.push({ value: provider, label: providerNameOf(catalog, provider) })
      }
      if (currentProvider !== '' && !allowedProviders.includes(currentProvider)) {
        providerOptions.push({
          value: currentProvider,
          label: `${providerNameOf(catalog, currentProvider)} (${t('notAllowed')})`,
        })
      }

      const modelOptions = [{ value: '', label: t('unsetModel') }]
      const modelsForProvider = routes.filter((route) => route.provider === value.provider)
      for (const route of modelsForProvider) {
        const model = catalogModelOf(catalog, route)
        const label = model === undefined ? `${route.model} (${t('unavailable')})` : model.name
        modelOptions.push({ value: route.model, label })
      }
      if (currentModel !== '' && !modelsForProvider.some((route) => route.model === currentModel)) {
        const model = catalogModelOf(catalog, value)
        const label = model === undefined ? `${currentModel} (${t('notAllowed')})` : `${model.name} (${t('notAllowed')})`
        modelOptions.push({ value: currentModel, label })
      }

      const catalogModel = catalogModelOf(catalog, value)
      const efforts = Array.isArray(catalogModel?.reasoning?.efforts) ? catalogModel.reasoning.efforts : []
      const currentEffort = value.reasoningEffort
      const effortOptions = []
      if (efforts.length > 0) {
        effortOptions.push({ value: '', label: t('effortDefault') })
        for (const effort of efforts) effortOptions.push({ value: effort.id, label: effort.name })
        if (currentEffort !== undefined && !efforts.some((effort) => effort.id === currentEffort)) {
          effortOptions.push({ value: currentEffort, label: `${currentEffort} (${t('notSupported')})` })
        }
      }

      const issues = []
      if (currentProvider !== '' && currentModel !== '' && !allowedKeys.has(routeKey(value))) issues.push(t('notAllowed'))
      if (currentProvider !== '' && currentModel !== '' && catalogModel === undefined) issues.push(t('unavailable'))
      if (
        currentEffort !== undefined &&
        catalogModel !== undefined &&
        Array.isArray(catalogModel.reasoning?.efforts) &&
        !catalogModel.reasoning.efforts.some((effort) => effort.id === currentEffort)
      ) {
        issues.push(t('notSupported'))
      }

      return h(
        'section',
        {
          style: {
            border: '0.5px solid var(--dsw-alias-border-l3)',
            borderRadius: 'var(--dsw-radius-xl)',
            background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          },
        },
        h(
          'header',
          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 500 } }, title),
          h('p', { style: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } }, hint),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          labelled(
            t('provider'),
            h(
              'select',
              {
                value: value.provider,
                disabled,
                'aria-label': `${title} ${t('provider')}`,
                onChange: (event) => onChange({ provider: event.target.value, model: '', reasoningEffort: undefined }),
                style: selectStyle,
              },
              ...providerOptions.map((option) =>
                h('option', { key: option.value, value: option.value }, option.label),
              ),
            ),
          ),
          labelled(
            t('model'),
            h(
              'select',
              {
                value: value.model,
                disabled: disabled || value.provider === '',
                'aria-label': `${title} ${t('model')}`,
                onChange: (event) => onChange({ model: event.target.value, reasoningEffort: undefined }),
                style: selectStyle,
              },
              ...modelOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
            ),
          ),
        ),
        efforts.length > 0
          ? labelled(
              t('effort'),
              h(
                'select',
                {
                  value: currentEffort ?? '',
                  disabled,
                  'aria-label': `${title} ${t('effort')}`,
                  onChange: (event) =>
                    onChange({ reasoningEffort: event.target.value === '' ? undefined : event.target.value }),
                  style: selectStyle,
                },
                ...effortOptions.map((option) =>
                  h('option', { key: option.value, value: option.value }, option.label),
                ),
              ),
            )
          : currentEffort !== undefined
            ? h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h(
                  'span',
                  { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } },
                  `${t('savedEffort')}: ${currentEffort} (${t('notSupported')})`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled,
                    onClick: onClearEffort,
                    style: smallButtonStyle,
                  },
                  t('useDefaultEffort'),
                ),
              )
            : null,
        h(
          'p',
          {
            role: 'status',
            style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', minHeight: 18 },
          },
          value.provider === '' || value.model === ''
            ? t('notConfigured')
            : [t('configured'), ...issues].join(' · '),
        ),
      )
    }

    const selectStyle = {
      boxSizing: 'border-box',
      width: '100%',
      height: 32,
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-layer-3)',
      color: 'var(--dsw-alias-label-primary)',
      padding: '0 8px',
      fontSize: 13,
    }

    const smallButtonStyle = {
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      fontSize: 12,
      height: 26,
      padding: '0 8px',
    }

    const buttonStyle = {
      border: 'none',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-state-business-primary)',
      color: 'var(--dsw-alias-label-primary-foreground)',
      cursor: 'pointer',
      fontSize: 13,
      height: 32,
      padding: '0 14px',
    }

    /** The Configure page body. */
    function RouterConfig(props) {
      const { t, ctx, view } = props
      const ownerForm = props.form
      const nativeForm = ctx.configForms.get(NATIVE_NS)
      const native = useFormSnapshot(nativeForm)
      const catalog = useCatalog(ctx)
      const [draft, setDraft] = React.useState(null)
      const [draftRevision, setDraftRevision] = React.useState(undefined)
      const [conflicted, setConflicted] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [outcome, setOutcome] = React.useState(null)

      const snapshot = ownerForm?.state
      const base = normalizeConfig(snapshot?.value)
      const value = draft ?? base
      const routes = allowedRoutesOf(native.value)
      const authorization = native.status === 'ready' ? (native.value?.enabled === true ? 'enabled' : 'disabled') : 'pending'
      const writable = snapshot?.writable !== false
      const partial = tierIsPartial(value.normal) || tierIsPartial(value.high)

      React.useEffect(() => {
        if (draft === null || draftRevision === undefined) return
        const revision = snapshot?.revision
        if (revision !== undefined && revision !== draftRevision) setConflicted(true)
      }, [snapshot?.revision, draft, draftRevision])

      if (view === 'summary') return t('summary')
      if (snapshot === undefined) return h('p', { role: 'note' }, t('unavailableForm'))
      if (snapshot.status === 'loading') return h('p', { role: 'note' }, t('loadingForm'))
      if (snapshot.status === 'unavailable') return h('p', { role: 'note' }, t('unavailableForm'))

      const disabled = !writable || saving || conflicted

      const edit = (tier, patch) => {
        const current = draft ?? { normal: { ...base.normal }, high: { ...base.high } }
        if (draft === null && snapshot.revision !== undefined) setDraftRevision(snapshot.revision)
        setDraft({ ...current, [tier]: { ...current[tier], ...patch } })
        setOutcome(null)
      }

      const clearEdits = () => {
        setDraft(null)
        setDraftRevision(undefined)
        setConflicted(false)
        setOutcome(null)
      }

      const dirty = draft !== null && !sameConfig(draft, base)

      const save = async () => {
        if (!dirty || disabled || partial) return
        const ops = []
        for (const tier of ['normal', 'high']) {
          const current = base[tier]
          const next = value[tier]
          if (sameTier(current, next)) continue
          if (next.provider === '' || next.model === '') {
            if (current.provider !== '' || current.model !== '') ops.push({ op: 'unset', path: [tier] })
            continue
          }
          ops.push({
            op: 'set',
            path: [tier],
            value: {
              provider: next.provider,
              model: next.model,
              ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }),
            },
          })
        }
        if (ops.length === 0) {
          clearEdits()
          return
        }
        setSaving(true)
        setOutcome(null)
        let accepted = false
        try {
          accepted = await ownerForm.mutate(ops, draftRevision)
        } catch {
          accepted = false
        }
        setSaving(false)
        if (accepted) {
          clearEdits()
          setOutcome('saved')
        } else if (ownerForm.state.revision !== draftRevision) {
          setConflicted(true)
          setOutcome('conflict')
        } else {
          setOutcome('failed')
        }
      }

      const tierEditors = [
        { id: 'normal', title: t('normalTitle'), hint: t('normalHint') },
        { id: 'high', title: t('highTitle'), hint: t('highHint') },
      ].map((tier) =>
        h(TierEditor, {
          key: tier.id,
          t,
          title: tier.title,
          hint: tier.hint,
          value: value[tier.id],
          routes,
          catalog,
          disabled,
          onChange: (patch) => edit(tier.id, patch),
          onClearEffort: () => edit(tier.id, { reasoningEffort: undefined }),
        }),
      )

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 500 } }, t('title')),
        h(
          'p',
          { style: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' } },
          t('intro'),
        ),
        h(
          'div',
          {
            style: {
              border: '0.5px solid var(--dsw-alias-border-l3)',
              borderRadius: 'var(--dsw-radius-lg)',
              background: 'var(--dsw-alias-bg-layer-1)',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          },
          h(
            'p',
            { role: 'status', style: { margin: 0, fontSize: 13, fontWeight: 500 } },
            native.status === 'loading'
              ? t('authLoading')
              : native.status === 'unavailable'
                ? t('authUnavailable')
                : authorization === 'enabled' && routes.length > 0
                  ? t('authEnabled')
                  : authorization === 'enabled'
                    ? t('authEmpty')
                    : t('authDisabled'),
          ),
          native.status === 'ready' && (authorization !== 'enabled' || routes.length === 0)
            ? h(
                'p',
                { style: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' } },
                t('authEnableHint'),
              )
            : null,
          authorization === 'enabled'
            ? h(
                'p',
                { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                t('authSessionHint'),
              )
            : null,
          h(
            'p',
            { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
            `${t('authPathLabel')}: ${t('authPath')}`,
          ),
        ),
        routes.length === 0
          ? h(
              'p',
              {
                style: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' },
              },
              t('noRoutes'),
            )
          : null,
        catalog.status === 'error' || catalog.failures > 0
          ? h(
              'p',
              {
                role: 'status',
                style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
              },
              t('catalogIssue'),
            )
          : null,
        ...tierEditors,
        partial
          ? h(
              'p',
              { role: 'alert', style: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary)' } },
              t('incompleteTier'),
            )
          : null,
        !writable ? h('p', { role: 'note' }, t('readOnly')) : null,
        conflicted || outcome === 'conflict'
          ? h(
              'p',
              { role: 'alert', style: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary)' } },
              t('conflict'),
            )
          : outcome === 'failed'
            ? h(
                'p',
                { role: 'alert', style: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary)' } },
                t('failed'),
              )
            : outcome === 'saved'
              ? h(
                  'p',
                  { role: 'status', style: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-success-primary)' } },
                  t('saved'),
                )
              : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            {
              type: 'button',
              disabled: !dirty || disabled || partial,
              onClick: () => {
                void save()
              },
              style: { ...buttonStyle, opacity: !dirty || disabled || partial ? 0.5 : 1 },
            },
            saving ? t('saving') : t('save'),
          ),
          dirty
            ? h(
                'button',
                { type: 'button', disabled: saving, onClick: clearEdits, style: smallButtonStyle },
                t('discard'),
              )
            : null,
        ),
      )
    }

    /**
     * Mount the Configure page while the row's row-config slot exists.
     * @param {any} ctx - browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'submodelrouter: locale')
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.row.config',
                key: ROW_KEY,
                locale: NS,
              },
              (props) => h(RouterConfig, { ...props, ctx }),
            ),
          ),
        'submodelrouter: Configure page',
      )
    }

    return { apply, inject }
  },
})
