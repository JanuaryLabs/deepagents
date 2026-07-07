# animated-svg (zukhruf)

The `@deepagents/agent` `animated_svg` example
(`packages/agent/src/lib/examples/animated_svg.ts`) migrated to the
`@deepagents/experimental/zukhruf` runtime — a **clean, no-extension** port: one
agent, one tool, one streaming turn.

## What changed

| Original (`@deepagents/agent`)               | This unit (`zukhruf`)                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `agent({ model, prompt, tools:{save_svg} })` | `agent.ts` → `defineAgent({ model, sandbox, instructions, tools })`                                                    |
| `instructions({ purpose, routine })`         | `instructions.ts` → `defineInstructions(role(…))`                                                                      |
| `tool({ … })`                                | `tools.ts` → `defineTool({ … })`                                                                                       |
| (no sandbox)                                 | `sandbox.ts` → `defineSandbox(() => createVirtualSandbox(…))` — required by zukhruf, satisfied by an in-memory sandbox |
| `execute(generator, prompt)` → `printer`     | `run.ts` → `createRuntime().enqueue(…)` → consume the durable stream                                                   |

Nothing in `@deepagents/experimental` had to change: the example is a single
streaming agent with a tool, which sits entirely inside zukhruf's boundary.
Because it now runs on the runtime, the turn is durable and resumable for free
(persisted stream + per-chat FIFO), though this single-shot demo doesn't lean on
that.

The one deviation from the original is the model: it uses
`openrouter('deepseek/deepseek-v4-flash')` instead of the original's
`qwen/qwen3-32b`, which is a reasoning model that tends to spend the whole turn
reasoning and never emit the `save_svg` tool call. The model is just a
declaration input — swap it freely.

## Run

```sh
OPENROUTER_API_KEY=... node demo/animated-svg/run.ts
# or with your own prompt:
OPENROUTER_API_KEY=... node demo/animated-svg/run.ts "an animated loading spinner in blue"
```

The agent calls `save_svg`, which writes `animated_svg_output.svg` to the
current directory — open it in a browser.
