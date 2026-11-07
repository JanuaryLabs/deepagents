# LFM3 on llama.cpp: latency experiments

Research date: 2026-11-07. This is a living record. Each experiment that tries to make LFM3 faster on this machine gets one row here. Read this record before you start an experiment, so that you do not repeat one. Add new rows at the end of each table. Do not change old rows. If a later result disproves an old row, add a new row that says so.

## Context

The `lfm` export in `packages/agent/src/lib/models.ts` calls LFM3-1.7B. Llama.app serves the model on this Mac. Llama.app runs the llama.cpp server in router mode on `http://127.0.0.1:9931/v1`.

The goal is a short time to first token, first for chat and then for long prompts. A fix goes into the inference engine when the engine can do it. A fix goes into the client (the `lfm` export) only when the engine cannot do it.

## Setup

| Item             | Value                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Machine          | MacBook Pro, Apple M4 Pro (14-core CPU), 48 GB, 273 GB/s memory bandwidth                       |
| Server           | Llama.app 0.47.0, llama.cpp 0.8.0 (build 11960, commit 8642541b2), router mode                  |
| Model            | `LiquidAI/LFM3-1.7B-GGUF:BF16`, 3,466,626,336 bytes, from the Hugging Face cache                |
| Engine settings  | the `[LiquidAI/LFM3-1.7B-GGUF:BF16]` section of `~/.config/llama/models.user.ini`               |
| Benchmark client | GuideLLM 0.8.1 (`guidellm run`), with `--backend kind=openai_http,target=http://127.0.0.1:9931` |

The chat benchmark that the results use:

```sh
HF_HUB_OFFLINE=1 uvx --python 3.13 guidellm@0.8.1 run \
  --backend kind=openai_http,target=http://127.0.0.1:9931,model=LiquidAI/LFM3-1.7B-GGUF:BF16 \
  --tokenizer kind=huggingface_auto,model=LiquidAI/LFM3-1.7B \
  --data kind=synthetic_text,first_prompt_tokens=6000,prompt_tokens=30,output_tokens=200,turns=3 \
  --profile kind=synchronous --constraint kind=max_requests,count=9 \
  --seed kind=static,value=<a new number for each run> --output kind=json,path=<file>.json
```

Each request in the JSON output has `info.turn_index`, `prompt_tokens`, `cached_tokens` and `time_to_first_token_ms`.

## Terms

- **TTFT** (time to first token): the time from sending a request to receiving the first token.
- **Prefill**: the step that reads all prompt tokens in parallel. Prefill time sets most of the TTFT.
- **Decode**: the step that makes one token per forward pass.
- **Prompt cache**: the state of an earlier prompt that the server keeps. A new prompt that starts with the same tokens does not need prefill for those tokens.
- **Context checkpoint**: a saved copy of the model state at one position. LFM3 is a hybrid model: 13 of its 24 layers are short-convolution layers, and 6 of its 11 attention layers use a 256-token sliding window. The server cannot move this state back to any position. It can only restore a context checkpoint.
- **ubatch** (`ubatch-size`): the maximum number of prompt tokens in one forward pass. llama.cpp makes a context checkpoint at `4 + ubatch` tokens before the end of the prompt, and one at 4 tokens before the end (`tools/server/server-context.cpp`, about line 4518).

## Current result

Engine setting: `ubatch-size = 256`. Llama.app selects 2048.

| Measurement (GuideLLM chat benchmark)                        | ubatch 2048    | ubatch 256     |
| ------------------------------------------------------------ | -------------- | -------------- |
| TTFT of a follow-up turn (about 42 new tokens)               | 1,143 ms       | 225 ms         |
| Prompt tokens that the follow-up takes from the prompt cache | 3,983 of 6,073 | 5,771 of 6,073 |

The client must keep the model reasoning in the chat history. Give `response.messages` from one call to the next call. The AI SDK then sends the reasoning back as `reasoning_content` (`@ai-sdk/openai-compatible` 3.0.78, `dist/index.js`, line 205).

## Experiments

| ID  | Question                                                                  | Method                                                                                                                                                  | Result                                                                                                                                                                                                | Decision                                                                                                               |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| E1  | How fast is LFM3 now?                                                     | A streaming probe measures TTFT, time per output token and throughput                                                                                   | Warm TTFT 116 ms for a 20-token prompt. Prefill about 2,070 tokens/s. Decode 50 tokens/s with no speculative drafts. 4 requests at the same time: 163 tokens/s in total, 41 tokens/s for each request | Baseline                                                                                                               |
| E2  | What is the decode limit?                                                 | Memory bandwidth divided by model size: 273 GB/s / 3.467 GB                                                                                             | 78.8 forward passes/s. The measured 50 tokens/s is 63% of this limit                                                                                                                                  | The limit is for forward passes, not for tokens. Batches and speculative drafts give more than one token for each pass |
| E3  | What does `--spec-default` (speculative decoding) do?                     | Send the same prompt again and read `timings.draft_n_accepted`                                                                                          | Repeated text: 192 to 409 tokens/s (166 of 200, and 186 of 186 drafts accepted). New text: 3% of drafts accepted                                                                                      | Use new text in each benchmark. Repeated prompts make decode seem faster                                               |
| E4  | How does TTFT change with prompt length?                                  | Prompts with new random text, 127 to 12,385 tokens                                                                                                      | About 0.55 ms for each prompt token: 674 tokens 360 ms, 3,102 tokens 1,603 ms, 12,385 tokens 7,702 ms                                                                                                 | Prefill time increases linearly with prompt length                                                                     |
| E5  | Does the prompt cache work for a repeated prompt and for a new chat turn? | Send a 6,149-token prompt again; then add a new turn                                                                                                    | Both use the prompt cache only up to 2,048 tokens before the end                                                                                                                                      | The hybrid model state restores only from a context checkpoint                                                         |
| E6  | Does the format of the chat history change the follow-up TTFT?            | Three history formats, ubatch 2048                                                                                                                      | Model reasoning removed (default): 1,129 ms. `reasoning_content` with `preserve_thinking`: 497 ms. `enable_thinking: false`: 1,242 ms                                                                 | The history must be equal, token for token, to what the model made                                                     |
| E7  | Does GuideLLM show the same result as E5?                                 | GuideLLM chat benchmark, ubatch 2048                                                                                                                    | Follow-up TTFT 1.13 to 1.29 s. Cached tokens = prompt minus 2,048                                                                                                                                     | Yes. GuideLLM is the benchmark client from now on                                                                      |
| E8  | Does GuideLLM `multiturn_reasoning` with `preserve_thinking` help?        | GuideLLM, ubatch 2048                                                                                                                                   | No change: 4,046 cached tokens                                                                                                                                                                        | GuideLLM puts the reasoning back as text in `content`. That text is not equal to the cached tokens                     |
| E9  | Does a smaller ubatch make prefill slower?                                | `llama-bench -p 4096 -n 0 -b 4096 -ub 256,512,1024,2048`                                                                                                | 2,118, 2,159, 2,182 and 2,182 tokens/s                                                                                                                                                                | Not much: 3% at ubatch 256                                                                                             |
| E10 | Which ubatch gives the shortest follow-up TTFT?                           | GuideLLM chat benchmark for each ubatch                                                                                                                 | 256: 225 ms. 512: 347 ms. 1024: 606 ms. 2048: 1,143 ms                                                                                                                                                | Applied `ubatch-size = 256`                                                                                            |
| E11 | Does `preserve_thinking` in the engine help at ubatch 256?                | AI SDK client through `lfm`, history from `response.messages`, 3 conversations; (a) no setting, (b) `chat-template-kwargs = {"preserve_thinking":true}` | (a) 297 to 339 ms; (b) 296 to 328 ms; about 5,900 of 6,400 tokens cached in both                                                                                                                      | No change. The setting is not used                                                                                     |

Note on E11: in (a) the follow-up prompt had about 6,400 tokens, the same as in (b). This means that the reasoning was in the prompt in (a) as well. `POST /apply-template` with `preserve_thinking: false` removes the reasoning. The cause of the result in (a) is not known (see N5).

## Attempts that failed

| ID  | Attempt                                                               | What happened                                                                                        | Do this instead                                                                                                      |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A1  | Stop speculative decoding for one request with `speculative.n_max: 0` | The server ignored it. 186 of 186 drafts were accepted                                               | Change `spec-type` in the engine settings                                                                            |
| A2  | `guidellm benchmark run`                                              | GuideLLM 0.8.1 has no `benchmark` command                                                            | `guidellm run`                                                                                                       |
| A3  | Run GuideLLM two times with the same seed                             | The same documents came back, and the second run used the prompt cache of the first run              | Use a new seed for each run                                                                                          |
| A4  | Start Llama.app immediately after `quit`                              | `open` failed with error -600. The server was down for 40 s                                          | Repeat `open -g -a Llama` until it succeeds                                                                          |
| A5  | Measure in the first minute after Llama.app starts                    | Sometimes, about 40 s after it starts, the app restarts its router. All requests in that time failed | Monitor the router process ID for about 60 s before you measure. Make sure that the GuideLLM `errored` list is empty |
| A6  | Use the bandwidth limit as a limit for tokens/s                       | Speculative drafts gave 409 tokens/s, more than the limit                                            | The limit is for forward passes (E2)                                                                                 |
| A7  | Apply the chat history fix to the SOB benchmark runner                | The runner sends `[...shots, user]` and never sends model output back                                | For SOB, examine the prompt cache for the shared few-shot prefix (N3)                                                |
| A8  | Expect a small ubatch to make prefill much slower                     | It was 3% slower (E9)                                                                                | Measure before you trade one value for another                                                                       |
| A9  | Expect a new chat turn to use the full prompt cache                   | The default template removes earlier reasoning, so the prompt is different (E6)                      | Send `response.messages` (AI SDK)                                                                                    |

## Open questions

| ID  | Question                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N2  | Is ubatch 128 or lower better than 256? Not measured.                                                                                                    |
| N3  | Can the SOB runner use the prompt cache for its shared few-shot prefix? llama.cpp also makes a context checkpoint at the start of the last user message. |
| N4  | Decode speed (time per output token): this is the next phase.                                                                                            |
| N5  | Why did the reasoning stay in the prompt in E11 (a) with no `preserve_thinking`?                                                                         |

Do not change `sleep-idle-seconds`. Llama.app unloads the model after 300 s with no requests, and this is intentional. The first request after that loads the model again (4 to 9 s).
