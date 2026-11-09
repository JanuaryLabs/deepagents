# LFM3 on llama.cpp: latency experiments

Research started 2026-11-07. This folder records experiments to reduce LFM3 latency on the MacBook Pro described below. Review the catalog before running an experiment to avoid repeating completed work.

- [`experiments.yaml`](./experiments.yaml) is the catalog of completed, running, proposed, and rejected experiments.
- This file describes the setup, catalog format, workloads, recorded engine settings, and engine comparisons.

## Context

The `lfm` export in [`packages/agent/src/lib/models.ts`](../../../packages/agent/src/lib/models.ts) creates an AI SDK model for `LiquidAI/LFM3-1.7B-GGUF:BF16`. It defaults to Llama.app's llama.cpp router at `http://127.0.0.1:9931/v1`; set `LLAMA_BASE_URL` to use another endpoint. The helper connects to an existing server; it does not start Llama.app or install the model.

The first goal is to reduce time to first token for chat, then for long prompts. The next goal is faster decoding. Prefer engine settings in `~/.config/llama/models.user.ini`; change the `lfm` client only when the engine cannot address the issue.

The model file stays `LiquidAI/LFM3-1.7B-GGUF:BF16`. Do not try another quantization or precision of it (Ezz, 2026-11-08: "we need to stick to current model"). `X-quant-q8-0`, `X-quant-qad-q4-0` and `X-f16-vs-bf16` are rejected for this reason.

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

| Field                             | Meaning                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                              | A stable name, for example `X-quant-q8-0`. Early experiments use numbered `E` identifiers.                                                                  |
| `name`                            | The combination in words: `"<phase>: <knob=value> + <knob=value> on <workload>"`                                                                            |
| `phase`                           | `TTFT`, `TTFOT`, `TPOT` or `throughput`                                                                                                                     |
| `combination`                     | `engine` (engine selection or server options), `client` (request fields), and `workload` (an id from `workloads` or a probe description)                    |
| `hypothesis`, `expected`, `risks` | What should change, how much, and what can go wrong                                                                                                         |
| `source`, `evidence`              | Where the idea comes from                                                                                                                                   |
| `measure`                         | The workloads and the metrics to compare, and the baseline for the comparison                                                                               |
| `status`                          | `proposed`, `running`, `done` or `rejected`                                                                                                                 |
| `attempts`                        | One entry for each run: date, tool, GuideLLM labels and seeds, and the numbers                                                                              |
| `verdict`                         | A `result` (`yielded`, `no-gain`, `regression`, `mixed`, `baseline`, `unproven`, or `rejected`) with an optional `note`; `null` when no verdict is recorded |

Rules:

- Add a new experiment with `status: proposed` and `attempts: []` before you run it.
- Give each GuideLLM run the labels `--label experiment=<id> --label attempt=<n>`, and one label for each value that you change, for example `--label ubatch=256`.
- Use a new seed for independent GuideLLM runs unless prompt reuse is part of the measurement. The same seed sends the same documents, which can reuse an earlier run's prompt cache. Matched A/B arms can reuse seeds when each arm starts with an empty prompt cache, as in `E16-ubatch-replication-reversed`.
- Do not change old attempts. If a later result disproves one, add a new attempt or a new experiment that says so.
- Quote strings containing commas inside YAML flow collections (`{ ... }` or `[ ... ]`). An unquoted comma separates entries and can turn part of a description into a stray key.

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

## Recorded engine settings

The baseline recorded on 2026-11-07 uses `ubatch-size = 256` (Llama.app selects 2048), with `ctx-size 262144`, `parallel 4`, `batch-size 2048`, `kv-unified true`, `--spec-default`, and `--reasoning-preserve`. The catalog's `baseline` section records the remaining settings.

The interleaved `E16-ubatch-replication-reversed` comparison on 2026-11-08 confirmed the earlier `E15` chat result: ubatch 256 reduced median follow-up TTFT by about 81% compared with 2048. First-turn chat TTFT rose 1.8%. The other fresh-prompt workloads showed 4–18% higher median TTFT at 256, with 7–15% variation between the two 2048 arms. The baseline remains ubatch 256. The parallel 6/8 results remain unproven.

The first `X-no-cache-idle-slots-4users` attempt is invalid because the Mac slept during it. Attempt 2 used interleaved, traffic-checked arms without sleep: follow-up TTFT differed by about 1%, within the 1.9% baseline spread. The flag remains off. A possible first-turn gain still needs a larger sample.

For this recorded build and workload, keep `ubatch-size` at least 250 when clients drop reasoning from history. The diagnostic trace found that a nonzero checkpoint needs at least 254 tokens of margin before the first differing token, while the follow-up checkpoint sits `4 + ubatch` tokens before the previous prompt ends (`X-diag-followup-checkpoint-trace`).

`X-checkpoint-min-step-0-shots` reduced evaluated prompt tokens by 1,451 per repeated-shot item. Clean comparisons in attempts 2 and 4 measured 36–37% lower median SOB few-shot prefill time; attempts 2 and 5 measured 13–19% higher median chat follow-up TTFT. The setting remains off globally. A separate SOB preset (`X-sob-preset-min-step-0`) and keeping two router models loaded (`X-models-max-2`) remain proposed.

The client must keep the model reasoning in the chat history: give `response.messages` from one call to the next call. The AI SDK then sends the reasoning back as `reasoning_content` (`@ai-sdk/openai-compatible` 3.0.78, `dist/index.js`, line 205).

Do not change `sleep-idle-seconds`. Llama.app unloads the model after 900 s with no requests (its `sleepIdleTime` setting; 300 s before 2026-11-07 17:37 +0300), and this is intentional. The first request after that loads the model again (4 to 9 s).

## Recorded engine comparisons

`X-vllm-metal-comparison` attempt 2 compared vLLM-Metal 0.33.0 with llama.cpp on the same BF16 weights and matched workloads. Median one-user chat follow-up TTFT was 50% lower with vLLM-Metal. At eight concurrent chats, output throughput was 42% higher, while ITL was 15% higher and first-turn TTFT was 89% higher. On four concurrent fresh 4.2k-token prompts, median TTFT was about 6.1 s with vLLM-Metal versus 2.4 s with llama.cpp. Only one vLLM-Metal arm completed, so its run-to-run spread is unknown. These results describe that run; a second arm remains pending, and the serving engine is unchanged.

`X-uzu-comparison` records feasibility with a local LFM3 conversion. Output equivalence against the reference implementation and a matched benchmark remain pending; its sanity-run token rate does not establish a speedup.

## Terms

- **TTFT** (time to first token): the time from sending a request to receiving the first token, reasoning or answer.
- **TTFOT** (time to first output token): the time to the first answer token, after the reasoning.
- **Prefill**: the step that reads all prompt tokens in parallel. Prefill time sets most of the TTFT.
- **Decode**: generating tokens after prefill. Without speculative decoding, a forward pass produces one token per sequence; accepted speculative drafts can produce more.
- **ITL** (inter-token latency): the time between two output tokens. It measures decode speed.
- **Prompt cache**: the state of an earlier prompt that the server keeps. A new prompt that starts with the same tokens does not need prefill for those tokens.
- **Context checkpoint**: a saved copy of the model state at one position. LFM3 is a hybrid model: 13 of its 24 layers are short-convolution layers, 6 are full-attention layers and 5 are 256-token sliding-window attention layers. The server cannot move this state back to any position. It can only restore a context checkpoint.
- **ubatch** (`ubatch-size`): the maximum number of prompt tokens in one forward pass. In the recorded build, llama.cpp makes checkpoints `4 + ubatch` tokens before the end of the prompt, 4 tokens before the end, and at selected user-message starts (`tools/server/server-context.cpp`, about lines 4502 to 4518).
