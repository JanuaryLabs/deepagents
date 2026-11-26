# Copied: collapsing a skill's text to one line

Codex collapses a skill's text to one line in two places, and zukhruf mirrors
both. Under the Rule of Three the two copies stay until a third place needs
the rule. Until then, mirror every fix in both copies and name both files in
the commit.

| Code                            | Copies                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collapse whitespace to one line | `packages/context/src/lib/skills/frontmatter.ts` (`oneLine`), `packages/experimental/src/zukhruf/runtime/plugin/agent-skills.ts` (`defaultSkillName`) |

## Collapse whitespace to one line

- Same: both split on whitespace, drop empty parts and join with one space,
  Codex's `split_whitespace().join(" ")`:

  ```ts
  raw.split(/\s+/).filter(Boolean).join(' ');
  ```

- Differs: `oneLine` collapses the frontmatter's `name` and `description`
  (codex-rs/skills/src/parser.rs); `defaultSkillName` collapses the skill's
  directory name for a skill with no name, and falls back to `skill` when
  nothing is left (codex-rs/skills/src/loader/host.rs `default_skill_name`).
  Codex keeps the same split between its parser and its loader.
