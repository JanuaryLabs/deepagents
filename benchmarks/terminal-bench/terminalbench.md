# Terminal-Bench: Source of Truth

## What Is Terminal-Bench?

Terminal-Bench is the industry-standard benchmark for evaluating AI coding agents in realistic terminal environments. Created at Stanford University and the Laude Institute. Unlike benchmarks that test isolated functions, Terminal-Bench evaluates agents on complete end-to-end tasks — compiling code, fixing broken environments, training models, configuring servers — inside Docker containers with automated verification.

- Original paper: [arXiv: 2601.11868](https://arxiv.org/abs/2601.11868)
- Website: [tbench.ai](https://www.tbench.ai/)
- Discord: [discord.gg/6xWPKhGDbA](https://discord.gg/6xWPKhGDbA)

## Versions

| Version    | Framework                 | Dataset                           | Status                                        |
| ---------- | ------------------------- | --------------------------------- | --------------------------------------------- |
| **TB 2.0** | **Harbor** (`harbor run`) | `terminal-bench/terminal-bench-2` | **Live leaderboard — this is what we target** |
| TB 1.0     | `tb` CLI (`tb run`)       | `terminal-bench-core==0.1.1`      | Legacy, frozen                                |
| TB 3.0     | Harbor                    | TBD                               | In development                                |

**We target TB 2.0 exclusively.** TB 1.0 is legacy. The `tb` CLI is for TB 1.0 only.

---

## Harbor Framework

Harbor is the execution framework for TB 2.0. It runs agents inside isolated container environments with automated verification.

- GitHub: [harbor-framework/harbor](https://github.com/harbor-framework/harbor)
- Docs: [harborframework.com/docs](https://www.harborframework.com/docs)
- Cookbook: [harbor-framework/harbor-cookbook](https://github.com/harbor-framework/harbor-cookbook)

### Installation

```bash
uv tool install harbor   # or: pip install harbor
```

Requires: Python 3.12+, Docker running locally.

### Verify Setup

```bash
harbor run -d terminal-bench/terminal-bench-2 -a oracle
```

The `oracle` agent runs the human-written solution — confirms your Docker and Harbor setup works.

### CLI Reference

```bash
harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a <agent-name> \
  -m <provider/model> \
  -n <concurrent> \
  -k <trials> \
  --env <environment> \
  --ae VAR=value
```

| Flag    | Description                                        |
| ------- | -------------------------------------------------- |
| `-d`    | Dataset (e.g. `terminal-bench/terminal-bench-2`)   |
| `-a`    | Agent (oracle, terminus-2, claude-code, or custom) |
| `-m`    | Model (e.g. `anthropic/claude-opus-4-6`)           |
| `-n`    | Parallel task count                                |
| `-k`    | Trials per task (leaderboard requires >=5)         |
| `--env` | Environment: local (Docker) or daytona (cloud)     |
| `--ae`  | Pass env vars to agent (e.g. `--ae API_KEY=xxx`)   |

```bash
harbor run --help          # list all agents and options
harbor datasets list       # list available benchmarks
```

### Supported Environments

| Backend         | Description                              |
| --------------- | ---------------------------------------- |
| Docker          | Local run (default)                      |
| Daytona         | Cloud provider (needs `DAYTONA_API_KEY`) |
| E2B             | Cloud sandbox                            |
| Modal           | Cloud functions                          |
| GKE             | Kubernetes                               |
| Apple Container | macOS native                             |

---

## Agent Interface (How to Build a Custom Harness)

All agents implement `BaseAgent` from Harbor. Two approaches:

### Option 1: BaseAgent (Full Control)

For agents that manage their own LLM calls and tool orchestration externally.

```python
from harbor.agents.base import BaseAgent

class MyAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "my-agent"

    def version(self) -> str | None:
        return "0.1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        await environment.exec("pip install some-package")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Your agent loop:
        # 1. Feed instruction to LLM
        # 2. Run commands via environment.exec("bash command")
        # 3. Read output, feed back to LLM
        # 4. Populate context with results as you go
        pass
```

Run with:

```bash
harbor run -d terminal-bench/terminal-bench-2 \
           --agent-import-path my_harness.agent:MyAgent
```

### Option 2: BaseInstalledAgent (CLI Agents)

For wrapping existing CLI tools that get installed inside the container.

```python
from harbor.agents.base import BaseInstalledAgent

class MyCliAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "my-cli-agent"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(environment, "apt-get install -y curl")
        await self.exec_as_agent(environment, "pip install my-agent-package")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self.exec_as_agent(
            environment,
            f'my-agent --task "{instruction}"'
        )

    async def populate_context_post_run(self, context: AgentContext) -> None:
        pass
```

### Key Implementation Notes

- All operations are **async** (`async def`, `await`)
- `environment.exec("command")` runs bash in the container
- `exec_as_root()` / `exec_as_agent()` handle logging, env merging, error handling
- Populate `context` as the agent runs (not just at the end) — survives timeouts
- Set `SUPPORTS_ATIF = True` on the class for Agent Trajectory Interchange Format support
- Verification scripts write reward to `/logs/verifier/reward.txt`

---

## Task Structure

Each task is a directory containing:

```
task-name/
  task.toml          # config (timeouts, resources, metadata)
  instruction.md     # what the agent sees
  environment/       # Dockerfile for the sandbox
  tests/             # verification scripts
```

Scoring is **binary pass/fail** per task. The leaderboard score is the percentage of tasks passed.

---

## Leaderboard

Live leaderboard: [tbench.ai/leaderboard/terminal-bench/2.0](https://www.tbench.ai/leaderboard/terminal-bench/2.0)

### Top 10 (as of March 2026)

| Rank | Agent         | Model           | Accuracy |
| ---- | ------------- | --------------- | -------- |
| 1    | ForgeCode     | GPT-5.4         | 81.8%    |
| 2    | ForgeCode     | Claude Opus 4.6 | 81.8%    |
| 3    | TongAgents    | Gemini 3.1 Pro  | 80.2%    |
| 4    | SageAgent     | GPT-5.3-Codex   | 78.4%    |
| 5    | ForgeCode     | Gemini 3.1 Pro  | 78.4%    |
| 6    | Droid         | GPT-5.3-Codex   | 77.3%    |
| 7    | Capy          | Claude Opus 4.6 | 75.3%    |
| 8    | Simple Codex  | GPT-5.3-Codex   | 75.1%    |
| 9    | Terminus-KIRA | Gemini 3.1 Pro  | 74.8%    |
| 10   | Terminus-KIRA | Claude Opus 4.6 | 74.7%    |

### Reference Points

| Agent       | Model           | Accuracy | Notes                      |
| ----------- | --------------- | -------- | -------------------------- |
| Terminus 2  | Claude Opus 4.6 | 62.9%    | Stock harness baseline     |
| Claude Code | Claude Opus 4.6 | 58.0%    | Anthropic's CLI agent      |
| Deep Agents | GPT-5.2-Codex   | 66.5%    | LangChain's harness        |
| Terminus 2  | GPT-OSS-20B     | 3.1%     | Open-source model baseline |

Custom harnesses beat the stock terminus-2 by up to **+19 points** with the same model.

---

## Submission Requirements

Submission repo: [huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard)

### Constraints (Strictly Enforced)

- Dataset: `terminal-bench/terminal-bench-2`
- `timeout_multiplier` must equal `1.0` (no timeout overrides)
- No resource overrides (CPU, memory, storage)
- Minimum **5 trials per task** (use `-k 5`)
- Agent must NOT access tbench.ai or its GitHub repo

### Submission Structure

```
submissions/
  terminal-bench/
    2.0/
      <agent>__<model>/
        metadata.yaml
        <job-folder>/
          config.json
          <trial-1>/result.json
          <trial-2>/result.json
          ...
```

### metadata.yaml

```yaml
agent_url: https://github.com/your-org/your-agent
agent_display_name: 'Your Agent'
agent_org_display_name: 'Your Org'

models:
  - model_name: claude-opus-4-6
    model_provider: anthropic
    model_display_name: 'Claude Opus 4.6'
    model_org_display_name: 'Anthropic'
```

### Submission Process

1. Fork the HuggingFace repo
2. Create branch, add results under `submissions/terminal-bench/2.0/<agent>__<model>/`
3. Open a Pull Request
4. Bot auto-validates (checks constraints above)
5. Maintainer reviews and merges
6. Results auto-import to leaderboard

Contact: alexgshaw64@gmail.com

---

## Harness Engineering (How to Win)

The harness (your wrapper code) matters more than the model. LangChain proved this by jumping 25 leaderboard spots without changing their model.

### High-Impact Techniques

| Technique                   | Description                                                  | Evidence                                   |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| **Context Injection**       | Run discovery commands at startup, inject into system prompt | LangChain, Stanford Meta-Harness, NxCode   |
| **Self-Verification**       | Force agent to verify its work before signaling completion   | LangChain's biggest single gain (+13.7pt)  |
| **Reasoning Sandwich**      | High reasoning at start/end, medium in middle                | Prevents timeouts vs always-high reasoning |
| **Loop Detection**          | Detect repeated actions, break cycle with meta-prompt        | Prevents wasted tokens                     |
| **Environment Bootstrap**   | Snapshot full sandbox state into initial prompt              | +1.7pt for Stanford Meta-Harness           |
| **Persistent Scratchpad**   | Give agent a writable memory/todo block                      | Letta's key pattern for long tasks         |
| **Proactive Summarization** | Summarize and hand off when context fills up                 | Terminus-2's approach                      |

### Reference Implementations

- **[Letta Terminal-Bench](https://github.com/letta-ai/letta-terminalbench)** — #1 open-source agent in <200 lines
- **[Stanford Meta-Harness](https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact)** — Automated harness discovery, 76.4%
- **[LangChain Harness Engineering](https://blog.langchain.com/improving-deep-agents-with-harness-engineering/)** — +13.7pt gain, harness-only changes
- **[Warp Blog](https://www.warp.dev/blog/terminal-bench)** — How they scored #1 at 52% (TB 1.0)

---

## Local Model Notes

When using local models (LM Studio, Ollama, vLLM):

- **Reasoning models** (Qwen 3.5, etc.) burn tokens on internal thinking before producing output. Ensure sufficient `max_tokens` or use non-reasoning models.
- **JSON mode** (`response_format: json_object`) is often unsupported or buggy on local servers. Prefer XML or free-text parsing.
- **LM Studio** exposes OpenAI-compatible API at `localhost:1234`. From inside Docker, use `host.docker.internal:1234`.
- Use litellm prefix `openai/model-name` for LM Studio models. If `response_format` causes errors, try `openai_compatible/model-name` prefix (disables response_format autodetection).

---

## References

### Official

- [tbench.ai](https://www.tbench.ai/)
- [TB 2.0 Leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0)
- [Harbor Docs](https://www.harborframework.com/docs)
- [Harbor GitHub](https://github.com/harbor-framework/harbor)
- [Submission Repo](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard)

### Papers

- [Terminal-Bench (arXiv: 2601.11868)](https://arxiv.org/abs/2601.11868)
- [Meta-Harness (arXiv: 2603.28052)](https://arxiv.org/html/2603.28052v1)

### Blog Posts

- [LangChain: Harness Engineering](https://blog.langchain.com/improving-deep-agents-with-harness-engineering/)
- [LangChain: Anatomy of an Agent Harness](https://blog.langchain.com/the-anatomy-of-an-agent-harness/)
- [LangChain: Evaluating Deep Agents CLI on TB 2.0](https://blog.langchain.com/evaluating-deepagents-cli-on-terminal-bench-2-0/)
- [Warp: How We Scored #1](https://www.warp.dev/blog/terminal-bench)
- [Snorkel AI: Terminal-Bench 2.0](https://snorkel.ai/blog/terminal-bench-2-0-raising-the-bar-for-ai-agent-evaluation/)
