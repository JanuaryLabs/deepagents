# LFM3 on llama.cpp: latency experiments

Research started 2026-11-07. This folder is a living record of each try to make LFM3 faster on this machine. Read it before you start an experiment, so that you do not repeat one.

- `experiments.yaml` is the catalog. It holds every experiment: done, running, proposed and rejected.
- This file gives the context, the format, the workloads and the current engine settings.

## Context

The `lfm` export in `packages/agent/src/lib/models.ts` calls LFM3-1.7B. Llama.app serves the model on this Mac. Llama.app runs the llama.cpp server in router mode on `http://127.0.0.1:9931/v1`.

The goal is a short wait for the first token, first for chat and then for long prompts. After that, the goal is a fast decode. A fix goes into the inference engine (`~/.config/llama/models.user.ini`) when the engine can do it. A fix goes into the client (the `lfm` export) only when the engine cannot do it.

## Setup

| Item             | Value                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Machine          | MacBook Pro, Apple M4 Pro (14-core CPU), 48 GB, 273 GB/s memory bandwidth                       |
| Server           | Llama.app 0.47.0, llama.cpp 0.8.0 (build 11960, commit 8642541b2), router mode                  |
| Model            | `LiquidAI/LFM3-1.7B-GGUF:BF16`, 3,466,626,336 bytes, from the Hugging Face cache                |
| Engine settings  | the `[LiquidAI/LFM3-1.7B-GGUF:BF16]` section of `~/.config/llama/models.user.ini`               |
| Benchmark client | GuideLLM 0.8.1 (`guidellm run`), with `--backend kind=openai_http,target=http://127.0.0.1:9931` |

## Format of an experiment

One experiment is one named combination of changes, compared with the baseline in `experiments.yaml`:

| Field                             | Meaning                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `id`                              | A stable name, for example `X-quant-q8-0`. The ids `E01` to `E13` are the first experiments.        |
| `name`                            | The combination in words: `"<phase>: <knob=value> + <knob=value> on <workload>"`                    |
| `phase`                           | `TTFT`, `TTFOT`, `TPOT` or `throughput`                                                             |
| `combination`                     | `engine` (llama.cpp server options), `client` (request fields), `workload` (an id from `workloads`) |
| `hypothesis`, `expected`, `risks` | What should change, how much, and what can go wrong                                                 |
| `source`, `evidence`              | Where the idea comes from                                                                           |
| `measure`                         | The workloads and the metrics to compare, and the baseline for the comparison                       |
| `status`                          | `proposed`, `running`, `done` or `rejected`                                                         |
| `attempts`                        | One entry for each run: date, tool, GuideLLM labels and seeds, and the numbers                      |
| `verdict`                         | `yielded`, `no-gain`, `regression`, `mixed`, `baseline` or `unproven`, with one sentence            |

Rules:

- Add a new experiment with `status: proposed` and `attempts: []` before you run it.
- Give each GuideLLM run the labels `--label experiment=<id> --label attempt=<n>`, and one label for each value that you change, for example `--label ubatch=256`.
- Use a new seed for each GuideLLM run. The same seed sends the same documents, and the server then uses its prompt cache from the earlier run.
- Do not change old attempts. If a later result disproves one, add a new attempt or a new experiment that says so.

## Workloads

The `workloads` section of `experiments.yaml` gives the exact GuideLLM options for each workload id. The common options are:

```sh
HF_HUB_OFFLINE=1 uvx --python 3.13 guidellm@0.8.1 run \
  --backend kind=openai_http,target=http://127.0.0.1:9931,model=LiquidAI/LFM3-1.7B-GGUF:BF16 \
  --tokenizer kind=huggingface_auto,model=LiquidAI/LFM3-1.7B \
  --data <workload data> --profile <workload profile> --constraint kind=max_requests,count=<n> \
  --seed kind=static,value=<new number> --label experiment=<id> --label attempt=<n> \
  --output kind=json,path=<file>.json
```

Read these fields from each request in the JSON output: `info.turn_index`, `prompt_tokens`, `cached_tokens`, `time_to_first_token_ms`, `time_to_first_output_token_ms` and `inter_token_latency_ms`.

Two GuideLLM fields need care:

- `time_per_output_token_ms` divides the full request time by the output tokens, so it includes the TTFT. Use `inter_token_latency_ms` for decode speed.
- `time_to_first_output_token_ms` is the time to the first non-reasoning token. For a thinking model, this is the time that a user waits. It is empty when the output length ends the request before the model stops its reasoning.

## Current engine settings

`ubatch-size = 256` (Llama.app selects 2048). See `E10`, `E13` and `E15` in `experiments.yaml`: chat follow-ups are 4.9 times faster, and fresh prompts are equal or faster. All other values are Llama.app or llama.cpp defaults: `ctx-size 262144`, `parallel 4`, `kv-unified true`, `--spec-default`, `--reasoning-preserve`.

The client must keep the model reasoning in the chat history: give `response.messages` from one call to the next call. The AI SDK then sends the reasoning back as `reasoning_content` (`@ai-sdk/openai-compatible` 3.0.78, `dist/index.js`, line 205).

Do not change `sleep-idle-seconds`. Llama.app unloads the model after 900 s with no requests (its `sleepIdleTime` setting; 300 s before 2026-11-07 17:37 +0300), and this is intentional. The first request after that loads the model again (4 to 9 s).

## Terms

- **TTFT** (time to first token): the time from sending a request to receiving the first token, reasoning or answer.
- **TTFOT** (time to first output token): the time to the first answer token, after the reasoning.
- **Prefill**: the step that reads all prompt tokens in parallel. Prefill time sets most of the TTFT.
- **Decode**: the step that makes one token for each forward pass.
- **ITL** (inter-token latency): the time between two output tokens. It measures decode speed.
- **Prompt cache**: the state of an earlier prompt that the server keeps. A new prompt that starts with the same tokens does not need prefill for those tokens.
- **Context checkpoint**: a saved copy of the model state at one position. LFM3 is a hybrid model: 13 of its 24 layers are short-convolution layers, 6 are full-attention layers and 5 are 256-token sliding-window attention layers. The server cannot move this state back to any position. It can only restore a context checkpoint.
- **ubatch** (`ubatch-size`): the maximum number of prompt tokens in one forward pass. llama.cpp makes a context checkpoint at `4 + ubatch` tokens and at 4 tokens before the end of the prompt, and one at the start of the last user message (`tools/server/server-context.cpp`, about lines 4502 to 4518).
