---
name: feature-development
description: Build a repository feature by discovering the current flow, resolving ambiguity, implementing the smallest fitting design, and reviewing the diff.
---

# Feature development

Use this workflow for a meaningful repository change. Compress or skip phases
when the request is genuinely trivial.

1. **Discover** — Restate the requested outcome and identify hard constraints.
2. **Explore** — Inspect the real entry points and call sites. Spawn a
   `code-explorer` only for a focused, independent question, then wait for it.
3. **Clarify** — If an unresolved choice would materially change the result,
   stop and ask a concrete question. Otherwise state the safe assumption.
4. **Design** — Reuse the closest existing module. Spawn `code-architect` only
   when the change has a genuine architectural choice, then wait for it.
5. **Implement** — The root agent alone edits files. Keep the diff focused and
   preserve unrelated user changes.
6. **Verify** — Run the narrowest integration-level check that would fail if
   the behavior regressed.
7. **Review** — Spawn `code-reviewer` against the completed diff, wait for it,
   and repair confirmed high-impact findings before summarizing.

Never stage, commit, publish, or deploy unless the user explicitly requests it.
