# Map: Definition-owned runtime plugins for Zukhruf

## Destination

Produce an implementation-ready specification for a breaking DeepAgents contract in which the root agent definition owns plugin composition, the runtime host supplies typed bindings, and each `AgentRuntime` owns fresh plugin instances and their lifecycle.

The specification must cover every affected first-party plugin and finish with a dependency-ordered implementation and durable clean packed-consumer verification plan.

## Notes

- This map plans the refactor; it does not implement, publish, or migrate an external application.
- Every session should consult the `wayfinder`, `grilling`, and `domain-modeling` skills and the current implementation before deciding anything.
- The root agent definition is the single source of truth for plugin composition across the complete runtime tree. Subagent-local runtime plugins are not part of this contract.
- The runtime host owns concrete stores, queues, schedulers, transports, callbacks, and other bindings. Plugin definitions must not capture per-runtime infrastructure at module evaluation time.
- `AgentRuntime` resolves bindings and owns one fresh runtime plugin instance per definition. Existing validation, configuration, initialization, work, conversation-availability reconciliation, cancellation, and reverse disposal semantics remain runtime responsibilities.
- This is a hard experimental API break: remove `AgentRuntimeOptions.plugins`; do not add a dual source, merge rule, compatibility shim, global registry, or service locator.
- Capabilities and binding values must be strongly typed. Runtime construction remains the authoritative check for missing, duplicate, conflicting, and unused bindings; whole-agent compile-time completeness proofs are not required.
- `AgentRuntime` remains synchronously constructible. Asynchronous acquisition stays in `initialize()` or `work()`.
- Definition immutability means readonly reusable contracts and defensive copies of composition collections where needed, not recursive freezing or cloning of application objects.
- The first-party migration surface includes `fileAgents`, `conversationScheduling`, `schedules`, and `@deepagents/devtool`, plus affected demos, integration tests, public exports, and documentation.
- Clean packed-consumer verification must become a durable repository target used by CI or release, not a one-off manual command.
- Preserve the existing dirty worktree and Git index. Wayfinder artifacts live only under this effort's `.scratch` directory plus the domain glossary.

## Decisions so far

## Not yet specified

- Additional plugin-specific lifecycle or public-surface questions exposed after the common contract and handle prototype are resolved.
- Any newly discovered first-party runtime extension that participates in plugin composition but was absent from the initial source trace.

## Out of scope

- Implementing, publishing, or releasing the refactor during wayfinding.
- Migrating the separate `self-delegate` application; it receives its own effort after the DeepAgents contract is ready.
- Dynamic plugin installation or replacement while a runtime is active.
- Subagent-local runtime plugin lifecycles.
- A global plugin registry, dependency-injection container, or process-wide service locator.
- JSON serialization of executable plugin definitions or recursive runtime freezing.
- New before-turn, after-turn, or other lifecycle hooks without a demonstrated requirement.
