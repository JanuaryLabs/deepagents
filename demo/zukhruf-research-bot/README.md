# demo-zukhruf-research-bot

An **agentic research bot** on the `zukhruf` harness
(`@deepagents/experimental/zukhruf`). It ports the multi-agent `research_bot`
example onto zukhruf using the **subagents-as-tools** pattern: the pipeline
stages are normal `agent()`s, and the root wires them in as tools via
`agent.asTool()`.

- `agent.ts` — the root declaration (`gpt-5`) that plans, delegates, and writes.
  It wires the subagents with `planner.asTool()` / `researcher.asTool()`.
- `instructions.ts` — the orchestration prompt (plan → research each → write).
- `sandbox.ts` — a **virtual** (in-memory) sandbox; the bot never touches a
  filesystem, but zukhruf requires every agent to declare one.
- `subagents/planner.ts` — a normal `agent()` (`gpt-4.1`) that returns a plan of
  5–10 web searches.
- `subagents/researcher.ts` — a normal `agent()` (`gpt-4.1` responses + the
  OpenAI hosted `web_search` tool) that summarizes one search.
- `subagents/sandbox.ts` — one in-memory sandbox shared by both subagents.
- `run.ts` — enqueue the query, read a few chunks, **detach mid-research**,
  then `resume()` and tail to the finished report.

## How it maps to `research_bot`

The original `research_bot` orchestrates in code (`plan → Promise.all(searches)
→ write`). Here the **model** orchestrates instead: the root agent calls
`plan_searches`, then calls `research` for each planned query, then writes the
report itself as the streamed answer. The Planner and Research agents stay
normal `agent()`s, wired into the root via `agent.asTool()`; the Writer folds
into the root so the report streams natively as the durable turn.

Each `asTool()` call `fork()`s the subagent's context — a fresh ephemeral
in-memory `ContextEngine` per call — so the subagents need nothing from the
root turn and the zukhruf runtime is unchanged.

## Run

```sh
OPENAI_API_KEY=… node demo/zukhruf-research-bot/run.ts "Your research question here"
```

Runs Docker-free (virtual sandbox, PGlite-backed queue). A single turn plans,
runs several web searches, and writes a long report, so it takes a while — that
is the point: it is a real long-running background turn that survives detach
and resume.
