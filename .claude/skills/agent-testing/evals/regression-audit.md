# Regression audit prompt

Audit `.claude/skills/agent-testing` after its AI SDK v7 migration.

Treat the installed packages—not memory, old documentation, or package manifests—as the source of truth. Inspect:

- `node_modules/ai/dist/test/index.d.ts`
- `node_modules/ai/dist/test/index.js`
- `node_modules/ai/dist/index.d.ts` for deprecated and preferred public APIs
- `node_modules/@ai-sdk/provider/dist/index.d.ts` for exact V4 result and stream-part shapes
- repository test call sites using the current mocks
- the complete git diff against `HEAD`

Then:

1. Reconstruct the original acceptance criteria: AI SDK v7 only, no compatibility layer, inventory every public `ai/test` export, prefer package-provided helpers, and remove custom code only when the installed package provides equivalent behavior.
2. Inventory every public `ai/test` export and record its exact behavior, defaults, deprecation status, and whether it captures calls.
3. Compare every old skill capability with the revised skill. Classify each as preserved, correctly replaced by a package helper, intentionally removed because it is obsolete, or accidentally regressed.
4. Pay special attention to false equivalence: static typing does not replace runtime ordering validation; language-model call arrays do not imply every modality mock captures calls; an exported legacy symbol is not necessarily the v7-preferred API.
5. Compile or execute every complete example that is intended to be copy-paste runnable. Probe sequencing, repeated values, deterministic IDs, stream construction/collection, tool dispatch, structured output, and invalid stream ordering against the real package.
6. Search the revised skill for V3 fixtures, deprecated structured-output APIs, `rawCall`, manual counters, manual stream drainers, unnecessary casts, and claims not supported by installed source.
7. Patch any regression you find. Preserve custom functionality when no current public package API replaces it.
8. Report an evidence table mapping each acceptance criterion to package source, runtime proof, and the final skill location. Do not declare improvement unless every criterion passes and no original unique capability was lost.
