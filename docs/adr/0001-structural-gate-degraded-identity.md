# Gate on native structure, degrade the child identity, never gate on copy

Status: accepted

`dsh-submodelrouter` masks the native `subagent` tool, so every DSH release can invalidate its assumptions. The adapter installs only when the captured definition matches the reviewed structure (tool name, description, the model-selection parameters, a render function, and `kind: 'activation'`); an unrecognised structure is left untouched and reported instead of being adapted. The child identity is separate: it only appears in the Parent-fallback warning, so an unknown identity field still routes and uses generic wording rather than disabling the plugin. Model-facing copy is never a recognition gate — a reworded description or prompt must not take routing offline; after masking, the description is rejected if it still mentions the removed route fields.

Considered options: treating any single extra string field as the identity (rejected: a field such as `status` would be reported as the child's name); refusing to install when the identity name is unknown (rejected: a harmless rename would take routing offline); matching the native description and prompt text exactly (rejected: the `0.2.2-rc.2`–`rc.5` incident showed copy is not a stable contract).

Consequences: an unknown structure fails loudly, so the next DSH change costs a visible error and a manual update instead of silent misrouting; the README compatibility matrix, not `engines.dsh`, states which DSH releases passed the matrix. If DSH ships a native effort tier or a supported tool-decoration hook, delete the mask and this policy.
