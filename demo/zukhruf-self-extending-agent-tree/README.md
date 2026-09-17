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

The shared catalog is the handoff boundary. Each role has one named Microsandbox
microVM, scoped to this tree rather than a chat. Every microVM mounts the same
workspace and skill catalog as read-write volumes. Root inspects the current
catalog for each request. General Task receives skill names in its delegation
message and discovers the published `SKILL.md` files on its first turn. There is
no separate manifest or skill-invocation API.

## Run

Run the demo from the repository root:

```sh
node --env-file=.env demo/zukhruf-self-extending-agent-tree/run.ts \
  "Build a TypeScript API with Hono. Use a reusable hono skill; commission it if missing."
```

The demo creates and reuses `workspace/` and `skills/` beside `run.ts`. The root
`.env` must define `OPENAI_API_KEY`. Microsandbox requires Apple silicon or
Linux with KVM. The runnable demo uses `gpt-5.6-terra` for all three roles and
permits four concurrent turns so Root can wait while a child works.

`stack.ts` declares the lazy PGlite queue and in-memory stores. `run.ts` owns
`runtime = new AgentRuntime(root)`, initializes `host`, and starts its worker explicitly.
