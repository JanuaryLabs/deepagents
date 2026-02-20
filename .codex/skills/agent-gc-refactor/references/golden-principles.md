# Golden Principles

## 1) Boundaries First

- Avoid imports that bypass package boundaries (`@deepagents/*/src/*`).
- Prefer stable package public entrypoints.
- Avoid cross-domain leakage via deep relative paths into other package internals.

## 2) Reuse Over Copy-Paste

- Prefer shared utility abstractions to repeated local helper implementations.
- Flag duplicated helper patterns for extraction.

## 3) Typed Boundaries

- Remove unsafe `as any` and `Record<string, any>` patterns.
- Reduce `: any` in favor of explicit types or `unknown` with narrowing.
- Treat shape guessing at boundaries as debt to resolve continuously.

## 4) Mechanical Enforcement

- Apply deterministic fixes only.
- Run verification gates after refactors.
- Keep unresolved items explicit with file-level evidence.
