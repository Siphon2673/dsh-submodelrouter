# DSH Submodel Router

Language for the two-tier subagent model-routing plugin and its user-facing behavior.

## Language

**Effort tier**:
A user-configured capability choice for a spawned subagent (`normal` or `high`), expressing how much capability to spend rather than a task category or difficulty score. It is distinct from a model's reasoning effort setting.
_Avoid_: Agent type, task type, difficulty level

**Parent route**:
The provider and model in effect for the delegating agent, used as the child's baseline when no explicit child route is selected.
_Avoid_: Main model, default model

**Parent fallback**:
Reporting that a selected effort tier cannot be used and continuing the delegation with the parent route instead of aborting the call.
_Avoid_: Silent fallback, error fallback

**Child identity**:
The identifier a native delegation reports for a started child: `name` on DSH `0.2.2-rc.2` and later, `subagentId` on `0.2.2-rc.1`. The native receipt renders it, and Parent-fallback warnings use it when the adapter recognizes the field.
_Avoid_: Child ID, subagent ID

**Native allowlist**:
The user-controlled list of provider/model routes that may be explicitly selected for subagents. It does not govern pure parent inheritance or enumerate reasoning efforts.
_Avoid_: Model catalog, installed model list

**Reasoning effort**:
A model-specific thinking level optionally stored within an effort-tier configuration. It is not the effort tier itself.
_Avoid_: Effort tier, capability tier
