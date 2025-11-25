---
description: Update documentation based on code changes since last push
allowed-tools: Read, Glob, Grep, Bash(git diff:*), Bash(git log:*), Task
---

# Update Documentation

Analyze code changes since last push and update documentation for affected packages.

## Steps

### 1. Get Changed Files Since Last Push

Run this command to find all files changed since last push:
```bash
git diff --name-only @{push}...HEAD
```

If `@{push}` doesn't exist (never pushed), compare with main:
```bash
git diff --name-only origin/main...HEAD
```

### 2. Identify Affected Packages

From the changed files list:
- Filter to files matching `packages/*/src/**`
- Extract unique package names (e.g., `text2sql`, `agent`, `toolbox`)
- Skip packages without existing docs in `apps/docs/app/docs/`

### 3. For EACH Affected Package, Spawn a doc-updater Sub-Agent IN PARALLEL

Use the Task tool with `subagent_type: "doc-updater"` for each package:

```
Task({
  subagent_type: "doc-updater",
  prompt: "Update documentation for package: [package-name]

           Changed files in this package:
           - path/to/file1.ts
           - path/to/file2.ts

           Documentation location: apps/docs/app/docs/[package-name]/

           Analyze the changes and update corresponding documentation."
})
```

### 4. Summarize Updates

After all sub-agents complete, provide a summary:
- Which packages were updated
- What documentation changes were made
- Any new pages created or pages that need attention

## Change Detection Rules

| Change Type | Documentation Impact |
|-------------|---------------------|
| `src/index.ts` exports changed | Check if public API docs need update |
| New file in `src/lib/**/*.ts` | May need new documentation page |
| Modified file in `src/lib/**/*.ts` | Update related docs |
| Deleted file | Remove or deprecate related docs |
| New adapter/agent/feature | Create new documentation page |

## Example Output

```
📚 Documentation Update Summary

Packages analyzed: text2sql, agent

text2sql:
  ✅ Updated generate-sql.mdx - Added new toSql() options
  ✅ Updated adapters/postgresql.mdx - New error handling section

agent:
  ✅ Created tools.mdx - New tool registration documentation
  ✅ Updated index.mdx - Added tools section reference

No action needed:
  - toolbox (no documentation exists yet)
```
