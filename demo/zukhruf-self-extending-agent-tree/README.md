# Self-Extending Agent Tree

This demo keeps orchestration, skill authorship, and task execution in three
fixed areas of responsibility:

```text
User message
    |
    v
+---------------------------+
| Root Agent                |
| decompose + resolve skills|
+-------------+-------------+
              |
       required skills?
          /          \
     all exist       one is missing
        |                  |
        |                  v
        |       +-------------------------+
        |       | Skill Authority Agent   |
        |       | create + validate skill |
        |       | publish skills/<name>/  |
        |       +------------+------------+
        |                    |
        +<-------------------+
        |
        | spawn fresh child: "Use <skill-name>"
        v
+---------------------------+
| General Task Agent        |
| read named SKILL.md files |
| execute the user task     |
+-------------+-------------+
              |
              v
        Root -> User
```

The shared catalog is the handoff boundary. Root and General Task mount it
read-only; Skill Authority mounts it read-write. Root inspects the current
catalog for each request. General Task receives skill names in its delegation
message and discovers the published `SKILL.md` files on its first turn. There
is no separate manifest or skill-invocation API.

## Run

Create an empty catalog and point the demo at a disposable workspace:

```sh
mkdir -p /tmp/zukhruf-skills /tmp/hono-project
OPENAI_API_KEY=... nx run @deepagents/demo-zukhruf-self-extending-agent-tree:start -- \
  --workspace /tmp/hono-project \
  --skills /tmp/zukhruf-skills \
  "Build a TypeScript API with Hono. Use a reusable hono skill; commission it if missing."
```

Docker is required. The runnable demo uses `gpt-5.6-terra` for all three
roles and permits four concurrent turns so Root can wait while a child works.
