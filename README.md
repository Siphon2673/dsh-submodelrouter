# dsh-submodelrouter

Two effort tiers for DSH subagent delegation. The main agent chooses
`effort: normal | high` instead of filling in raw provider, model, and reasoning
effort fields; you configure which route each tier spends.

The plugin is a standard dual-face DSH bundle: a Host adapter that masks the
native `subagent` tool and a Web Configure page. It does not modify native DSH
packages, the native Subagent settings page, presets, or the main-composer model
selector. It reads the native Subagent allowlist and never changes it.

## What the model sees

- `subagent` keeps its native delegation parameters (`cwd`, `description`,
  `name` when the native tool exposes it, `prompt`, plus `agent_preset` when
  exposed) and drops `provider`, `model`, and `reasoning_effort`.
- One optional `effort` parameter accepts only `normal` or `high`. Any other
  value fails argument validation before the native execution runs.
- `normal` is for routine, checkable, or cheap-to-redo work; `high` is for work
  whose result is directly trusted or whose errors are expensive. The semantics
  describe how much capability to spend, not a task category.
- Omitting `effort` calls native delegation with no route fields, inheriting the
  parent route exactly as before.
- `list_subagent_models` is replaced with tier-only discovery: tier meanings,
  configured/not-configured status, omission semantics, and repair guidance. It
  returns no raw routes and makes no claim that a route is authorized in an
  existing Session.
- The native generic delegation/depth guidance is restored while the mask is
  active. No additional tier-routing reminder is added, and `subagent_fork`,
  workflow children, and external subagent providers are untouched.

## Parent fallback

A configured tier is used only when native delegation accepts it. The plugin
falls back to one parent-route call, with a visible warning, for:

- a tier that is not configured;
- the native Session-allowlist rejection for the selected route. The plugin
  matches its stable route prefix, so the recorded-policy and
  no-recorded-policy (older Session) forms both work, and a later DSH suffix
  or delimiter change does not stop Parent fallback;
- an unsupported reasoning effort, unregistered provider, or unknown model on
  the reviewed adapters (the typed `NO_ADAPTER` case included).

The parent call runs once, outside the selected call's retry path. Cancellation,
depth/capacity, provider-generation changes, startup/admission/catalog failures,
output failures, malformed arguments, and unknown errors are rethrown without a
fallback. A failing fallback propagates unchanged; the plugin never attempts a
second child. Explicit results contain `(effort: normal|high)`; fallback results
contain the warning and a parent-inheritance statement. The canonical result
value is the native `{ kind: 'activation', name }`. The warning names the child when the
native identity field is recognized, and says `the subagent` when it is not;
the native `started subagent <name>` line always identifies it.

Fallback cannot prove that no child exists for arbitrary startup errors, so it
is deliberately limited to the reviewed pre-creation failures above. In the
rare transient LLM-adapter-absence case the accepted outcome is one warned
parent-route child, never a duplicate child.

## Setup

Install the bundle through the standard plugin flow, then enable its row in
**Plugins**:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-submodelrouter
```

Use a registry spec instead of a path when installing a published build. The
running Plugin Manager offers the same installation and row switches.

Configure two pages:

1. **Plugins → Subagent → Model selection**: enable native authorization and
   add the routes subagents may use.
2. **Plugins → Submodel router → Configure**: choose a provider, model, and
   optional reasoning effort for Normal and High. Only currently authorized
   routes are offered.

Native Subagent authorization is sampled when a Session starts. After changing
it, start a new Session for the new routes to be authorized. Editing the tier
mapping applies to the next delegation, including in an existing Session; a
route that the existing Session does not authorize follows Parent fallback.
Already-created children keep the route they started with.

Saving uses one plugin-owned Save for both tiers. A tier with only one half of
a route blocks Save until it is completed or cleared. Leaving the page discards
an unsaved draft, a stale revision is reported instead of overwriting newer
values, and the plugin never writes the native authorization namespace. Saved routes
that later become unauthorized or unavailable, and saved efforts that become
unsupported, remain visible and repairable.

## Disable and uninstall

Disabling the row or bundle removes the mask, discovery replacement, plugin
prompts, listeners, and the Configure page; the native `subagent` tool and its
prompt return through their normal mechanisms. Re-enabling does not create
duplicate registrations. Uninstalling leaves saved configuration in the profile
so reinstalling the same row id can recover it; the plugin does not delete
configuration or Sessions.

Parent and child Sessions created while the plugin was installed use only
native execution and core Session records, so their history remains restorable
after uninstall. Where the environment lacks live profile recomposition, restart
the profile after install, uninstall, or enablement changes.

## Scope and support boundary

- v1 supports the shipped standard Web profile's local in-process `spawn`
  `subagent` row with native model selection enabled. An external-provider row
  is out of scope. Identification is structural: the plugin adapts the row only
  when the captured definition is named `subagent`, has a non-empty description,
  exposes `description`, `prompt`, `provider`, `model`, and `reasoning_effort`,
  has an `output.render` function, and declares `kind: 'activation'`. A row
  without the model-selection fields is not adapted: when it is already visible
  at plugin activation, activation fails and the Plugins row shows it as not
  running; otherwise the Host logs one error per detected shape and leaves
  native delegation unchanged. Activation refusal is not retried in the
  background: after fixing the native surface, re-enable the plugin row or
  restart the profile to attempt activation again. A mismatch detected after a
  successful activation is retried on `tools/change` and for new Agents, so it
  self-heals without a restart once the native surface is restored. When the
  native description cannot be safely rewritten, the plugin installs its own
  description and logs one error per detected shape. Model-facing copy is never
  a recognition gate; an unknown child-identity field still routes and only
  degrades the fallback wording. The plugin cannot prove row identity, so an
  external-provider row that exposes the same structure is not covered by the v1
  guarantee.
- The `subagent` row must not configure fixed child `agentOptions` or provider
  route defaults if you rely on the "omit `effort` = parent route" guarantee.
  The standard preset has no such defaults; a profile override that adds them is
  outside the v1 guarantee, and the fallback wording only describes the
  standard preset.
- Reasoning effort is a native model capability, not a tier. The editor lists
  the selected model's advertised efforts and stores omission for "Default /
  native inheritance". Changing the route resets the effort.

## DSH compatibility

| DSH version | Verification status |
| --- | --- |
| `0.2.2-rc.5` | Tested |
| `0.2.2-rc.1` | Structurally compatible, not in the test matrix |

The manifest declares no `engines.dsh` and no pinned DSH peer version, so an
unverified DSH version is not rejected solely for being unverified. The package
does declare the Host runtime modules it actually imports as `*` peers and pins
the same packages in `devDependencies` for build/test reproducibility. `*` means
intentionally ungated admission, not universal test coverage: on another DSH
version, available services and API shapes may differ and should be diagnosed
from the actual failure. No version exemption is part of the normal install
path. Do not add a row to the table above unless the full matrix has passed on
that version.

## Development

The Host adapter is plain ESM JavaScript. The browser half is a hand-authored
lazy-CJS module factory, so no build step is required for a local install.

```sh
npm install
npm run typecheck
npm test
```

The automated matrix runs against DSH `0.2.2-rc.5`; `0.2.2-rc.1` is retained only
as a unit fixture for the previous result shape. The browser end-to-end suite is
opt-in because it needs Playwright's Chromium:

```sh
npx playwright install --with-deps chromium
DSH_E2E=1 npm run test:e2e
```

It creates its disposable `DSH_HOME` and Web profile under `.scratch/e2e-runs`,
stores only sanitized evidence under `.scratch/submodelrouter/e2e-evidence`, and
removes the temporary root after success or failure.

Tests use the real DSH tool runtime with a scripted LLM adapter, a production
AgentLoop, and real Sessions. The end-to-end suite creates a disposable
`DSH_HOME` and Web profile, installs the bundle, exercises the Configure page
and lifecycle, and removes the temporary root on both success and failure. It
never uses or modifies the user's current DSH home or profile.
