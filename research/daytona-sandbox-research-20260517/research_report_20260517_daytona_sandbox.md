---
title: Daytona Sandbox Integration Research for DeepAgents
date: 2026-05-17
mode: ultradeep
repository: /Users/ezzabuzaid/Desktop/January/deepagents
---

# Daytona Sandbox Integration Research for DeepAgents

## Executive Summary

Daytona is a credible candidate for a first-class DeepAgents sandbox backend because its documented surface overlaps strongly with DeepAgents' current `DisposableSandbox`: isolated lifecycle-managed compute, process execution, file operations, snapshot or OCI image setup, environment variables, network policy, preview URLs, and region targeting are all present in the official docs [1, 2, 3, 4, 5, 8, 9, 10, 13, 14]. The integration should not create a new runtime abstraction. It should add a Daytona-backed implementation of the existing `DisposableSandbox` and, separately, a Daytona-specific convenience wrapper that supplies Daytona defaults such as `/home/daytona` and lifecycle options [17, 19, 20].

The main implementation risk is `spawn`, not basic command execution. DeepAgents intentionally treats `spawn` as optional and only permits it when a backend can expose unbuffered stdout and stderr rather than buffered post-exit output [19, 23, 24]. Daytona's plain `process.executeCommand` is enough for buffered `executeCommand`, but DeepAgents `spawn` should be backed by Daytona process sessions with `runAsync: true` and `getSessionCommandLogs`, or by PTY only if the session log path cannot satisfy cancellation and exit semantics [5, 6, 7, 17]. The official Daytona Codex guide already uses async process sessions and streaming callbacks to run a sandboxed agent, which is strong evidence that this is the right primitive to test first [17].

The recommended first slice is a new `createDaytonaSandbox()` in `packages/context/src/lib/sandbox/daytona-sandbox.ts`, exported next to Docker, virtual, and Agent OS backends [19, 22]. It should implement `executeCommand`, `readFile`, `writeFiles`, `dispose`, and `spawn` behind a feature flag or runtime capability gate once the real streaming contract is proven against a live Daytona sandbox [4, 5, 6, 19, 23]. The verification bar should mirror the existing Docker spawn integration test: first stdout chunk before exit, independent stderr, abort behavior, `cwd`, `env`, and file-event observation through `createBashTool` [21, 23].

## Introduction

This research answers a practical implementation question: what must DeepAgents understand before adding Daytona as a supported sandbox backend? The scope includes Daytona's documented sandbox lifecycle, TypeScript SDK configuration, file system APIs, command execution APIs, streaming and PTY primitives, snapshots, network controls, preview URLs, regions, deployment modes, limits, and API key scopes [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]. It also includes the DeepAgents local code paths that any new backend must satisfy: `DisposableSandbox`, `createBashTool`, file-event observation, Docker's reference implementation, and the Docker spawn tests [19, 20, 21, 22, 23].

The central assumption is that Daytona should be integrated as one backend in the existing sandbox system, not as a replacement for Docker, virtual, or Agent OS backends. That assumption follows the current code shape: `createBashTool` explicitly takes a backend satisfying `DisposableSandbox`, composes decorators around that backend, and returns the same wrapped contract to callers [19, 20]. It also follows prior project direction recorded in memory: DeepAgents sandbox work has recently converged on explicit decorators, `DisposableSandbox`, and a strict distinction between real streaming and buffered command output [24].

The report is implementation-oriented. It does not try to describe every Daytona product feature in isolation. It filters Daytona's feature set through the actual surfaces DeepAgents must provide to agents and tests: command execution, live process streaming, filesystem mutation, cancellation, lifecycle cleanup, configured working directory, skills upload, file-event observation, network/security policy, and reproducible environments [19, 20, 21, 22, 23]. Where the docs leave an API-detail gap, the report marks that as an implementation-time verification requirement rather than inventing behavior.

## Main Analysis

### Finding 1: Daytona maps cleanly to the DeepAgents backend model

Daytona's core abstraction is close to DeepAgents' runtime needs. Daytona describes sandboxes as isolated runtime environments with a dedicated kernel, filesystem, network stack, and allocated CPU, memory, and disk [3]. DeepAgents' backend contract is much smaller: a `DisposableSandbox` must execute commands, read files, write files, and dispose; it may also expose `spawn` only when it can honestly stream unbuffered stdio [19]. This means Daytona does not need a broad adapter layer to be useful. It needs a focused backend adapter that translates Daytona's SDK modules into the existing `DisposableSandbox` shape.

The capability overlap is broad. Daytona documents filesystem operations through `sandbox.fs`, including listing, file info, creating directories, uploading, downloading, deleting, permissions, search, replace, and move operations [4]. Daytona documents process and code execution through `sandbox.process`, including code execution, shell command execution, sessions, entrypoint sessions, interactive commands, and error handling [5]. Daytona also documents lifecycle states and transitions, including creation, start, stop, archive, recover, resize, fork, snapshot creation, and delete [3]. DeepAgents does not need all of these on day one, but the extra surface gives room for durable growth without compatibility shims.

The cleanest first integration path is `createDaytonaSandbox(options): Promise<DisposableSandbox>`, not a Daytona-specific `AgentSandbox`. DeepAgents already separates raw backend creation from `createBashTool` composition [20]. Docker follows that pattern: `createDockerSandbox()` produces a backend, and `createContainerTool()` is a high-level wrapper that combines backend and bash-tool setup [22]. Daytona should follow the same split. A raw backend lets internal callers test the sandbox contract directly, while a high-level Daytona tool can pick better defaults for workspace path, lifecycle, and preview support.

The dependency risk is moderate but manageable. The current npm metadata says `@daytona/sdk` latest is `0.175.0`, with dual ESM/CJS exports and type declarations, and dependencies include `@daytona/api-client`, `@daytona/toolbox-api-client`, `axios`, `isomorphic-ws`, `form-data`, and OpenTelemetry packages [18]. That dependency set is acceptable for `packages/context` only if the package is already expected to own sandbox backends and SDK integrations. If dependency weight is a concern, the implementation can initially import lazily or make Daytona support an optional peer, but the repo rule against compatibility shims means that should be a deliberate package-boundary decision, not a half-wired fallback.

### Finding 2: `executeCommand` is straightforward, but `spawn` requires a real streaming proof

DeepAgents distinguishes two process modes. `executeCommand` returns a buffered `CommandResult` with `stdout`, `stderr`, and `exitCode`; `spawn` returns live `ReadableStream<Uint8Array>` stdout and stderr plus an `exit` promise [19]. The current Docker backend implements `executeCommand` with `docker exec` via `nano-spawn`, and implements `spawn` with Node `child_process.spawn` so stdout and stderr are live streams [22]. The Docker spawn test proves this by racing the first stdout chunk against process exit and requiring the chunk to arrive first [23].

Daytona's plain command execution can likely back `executeCommand`, because the process docs show `sandbox.process.executeCommand(...)` returning execution results and errors [5]. That path should not be used to implement `spawn` unless the SDK itself exposes streaming for that exact call. DeepAgents has an explicit no-fake-streaming rule in the local type comments and prior memory: an implementation must not aggregate output and flush it after completion while presenting it as a stream [19, 24]. A Daytona `spawn` built on buffered `executeCommand` would violate that rule even if it passed simple output tests.

Daytona provides better candidates for `spawn`. The log streaming docs show an async session command with `runAsync: true`, followed by `getSessionCommandLogs(sessionId, cmdId, onStdout, onStderr)` callbacks that process output while the command runs [6]. The process docs also describe session commands that can receive input while running, including TypeScript methods `createSession`, `executeSessionCommand`, `getSessionCommandLogs`, and `sendSessionCommandInput` [5]. The official Daytona Codex guide uses exactly that pattern to run a sandboxed agent command asynchronously and stream stdout and stderr back to the host [17].

The recommended `spawn` design is therefore session-backed. On `spawn(command, { cwd, env, signal })`, create a unique Daytona process session, start `executeSessionCommand` with `runAsync: true`, encode `cwd` as `cd <quoted cwd> && <command>` if the SDK does not accept cwd directly, encode `env` using a shell-safe environment prefix if the SDK does not accept env directly, start `getSessionCommandLogs`, and expose callback chunks through `ReadableStream` controllers [5, 6, 17, 19]. The returned `exit` promise should resolve only after the Daytona command completes and the stream closes. If Daytona's SDK does not expose an exit status from the log stream, the wrapper should retrieve the session command details or use a shell sentinel to capture the exit code, then delete the session [5, 17].

PTY is the fallback for interactive cases, not the first `spawn` backend. Daytona PTY supports terminal sessions, output callbacks, sending input, waiting, killing, resizing, and connection management [7]. That is useful for future terminal UX, but PTY output may mix stdout and stderr depending on terminal behavior, while DeepAgents `spawn` explicitly exposes separate stdout and stderr streams [7, 19]. The process-session log path preserves stdout/stderr separation in the docs, so it is a better first target [6].

### Finding 2A: Streaming surface inventory

The direct answer is yes: Daytona documents streaming. The most relevant surface for DeepAgents is session command log streaming, where a command is started asynchronously and logs are consumed through stdout and stderr callbacks [6]. The official Daytona Codex guide uses this pattern for an agent loop, creating a new process session per prompt, running the agent command asynchronously, and streaming output back to the host [17].

This should be separated from `sandbox.process.executeCommand(...)`. The plain execute-command path is useful for DeepAgents `executeCommand`, but it should be treated as buffered until the actual SDK type and runtime behavior prove otherwise [5, 19]. For DeepAgents `spawn`, the adapter should use session log streaming and convert callbacks into `ReadableStream<Uint8Array>` for stdout and stderr [6, 19, 23].

Daytona also documents PTY streaming for interactive terminals, with output callbacks, input, resize, wait, kill, and disconnect controls [7]. PTY is a future-facing option for interactive terminal UX, but it is not the first choice for DeepAgents `spawn` because terminal streams can blur stdout and stderr semantics, while session command logs are documented with separate stdout and stderr callbacks [6, 7, 19].

### Finding 3: Workspace path and file semantics need Daytona-specific defaults

DeepAgents' generic `createBashTool` default destination is `/workspace`, and the file-event observer uses that destination as the root for snapshot diffing [20, 21]. Daytona's docs say file operations without a leading slash are interpreted under the sandbox user's home directory, and the official Codex guide explicitly instructs agents to use `/home/daytona` instead of `/workspace` [4, 17]. If a Daytona backend is passed to `createBashTool` without a Daytona-aware destination, commands may run from a path that does not exist or file observation may silently observe an empty root [20, 21].

The fix should live in a high-level wrapper rather than in the core `createBashTool` default. `createBashTool` should stay backend-neutral. Add either `createDaytonaTool()` or a Daytona branch in an existing high-level container factory that calls `createBashTool({ sandbox, destination: "/home/daytona" })` and ensures the directory exists before handing the sandbox to agents [17, 20]. If DeepAgents wants all sandboxes to share `/workspace`, then the Daytona wrapper should create `/workspace` at startup and document that it intentionally deviates from Daytona's guide. The more native default is `/home/daytona`, because Daytona's own Codex guide uses it [17].

File reads and writes can use Daytona `fs` APIs directly. DeepAgents `readFile(path)` returns a string-like content in existing backends, and `writeFiles(files)` takes path/content entries [19, 22]. Daytona has upload and download APIs in the `fs` module and supports absolute paths when a leading slash is supplied [4]. The adapter should normalize all DeepAgents paths as absolute paths when possible. If `writeFiles` receives bytes in the future, the adapter should use Buffer upload paths rather than converting blindly to UTF-8, but the current `DisposableSandbox` type inherits the upstream `bash-tool` file content shape and local implementations already mostly treat content as text [19, 22].

DeepAgents file-event observation can probably wrap Daytona unchanged, but only if the sandbox image includes the Unix tools used by the observer. The observer snapshots with `find -print0` and `sha256sum` around command and file writes [21]. Daytona snapshots are OCI/Docker-compatible and can be created from controlled images [9]. The integration should either select a default image/snapshot with `find` and `sha256sum`, or run a startup capability check and return a clear error when file observation is requested without those tools [9, 21]. Hiding this behind a best-effort adapter would produce misleading `drainFileEvents()` behavior.

### Finding 4: Images, snapshots, installers, and resources should be mapped deliberately

Daytona snapshots are the closest match to Dockerfile-based repeatability in DeepAgents. Daytona documents snapshots as templates created from Docker or OCI-compatible images, including public images, local images, private registries, declarative builder, GPU snapshots, and default snapshots [9]. Docker support in DeepAgents currently includes runtime image starts, Dockerfile builds, compose stacks, installers, volumes, env, names, and resource settings [22]. Daytona cannot be a drop-in replacement for Docker Compose on day one, but it can cover the common "start a single sandbox from image or snapshot" path cleanly [3, 9, 22].

The first option set should be small and explicit. A Daytona backend should accept Daytona client configuration (`apiKey`, `apiUrl`, `target`), sandbox identity (`id`, `name`, or "create new"), environment (`envVars`), image or snapshot selection, resources, lifecycle intervals, region/target, and network policy [3, 8, 9, 10, 14]. The docs show default sandbox resources of 1 vCPU, 1 GiB RAM, and 3 GiB disk, with maximum per-sandbox limits of 4 vCPU, 8 GiB RAM, and 10 GiB disk under the documented organization limits [3]. Exposing these as typed options lets callers make resource decisions without shelling out to the Daytona CLI.

DeepAgents installers need a design choice. Docker installers currently run after container start and install packages inside the sandbox image [22]. Daytona supports configured snapshots, and snapshots are better for repeated dependency-heavy environments because the image is built once and reused [9]. For day one, do not port the Docker installer abstraction into Daytona automatically. Instead, accept `snapshot` or `image` and document that users should build a Daytona snapshot for repeatable dependencies. A later phase can add a Daytona "configure then snapshot" helper if the SDK supports creating snapshots from a live sandbox with the needed guarantees [3, 9].

GPU and Docker-in-Docker should be treated as advanced opt-in features. Daytona documents GPU sandboxes as experimental and requiring access approval, and it documents Docker and Kubernetes workloads inside sandboxes through snapshots [3, 9]. DeepAgents should not expose those in the initial supported backend unless there is a concrete consumer. The durable path is to keep the option surface typed enough to pass snapshot names and resources, then add higher-level GPU or DinD helpers when tests prove the specific workflows.

### Finding 5: Security, credentials, network, and preview behavior are not optional details

Daytona authentication is environment-driven in the SDK. The SDK can read `DAYTONA_API_KEY`, `DAYTONA_API_URL`, and `DAYTONA_TARGET`, and the docs define configuration precedence as code, environment variables, `.env`, then defaults [8]. API keys authenticate SDK and CLI requests, can have expiration, and have scopes such as `write:sandboxes`, `delete:sandboxes`, `write:snapshots`, and volume, region, runner, and audit scopes [11]. DeepAgents should not load Daytona credentials into the sandbox by default. Host-side Daytona credentials should remain host-side, while only explicit `envVars` should be passed into the sandbox [8, 11].

Network controls should be part of the public option set. Daytona supports `networkAllowList` and `networkBlockAll` at sandbox creation, can update network settings while a sandbox is running on eligible tiers, and requires IPv4 CIDR entries for allow lists [10]. The docs also say lower tiers can have organization-level restrictions that sandbox-level settings cannot override [10]. DeepAgents should surface these fields directly and translate Daytona API errors into clear `DaytonaSandboxError` messages. It should not silently relax network policy or retry with broader access.

Rate limits affect reliability under agent workloads. Daytona documents tiered request limits, sandbox creation limits, sandbox lifecycle limits, rate-limit headers, SDK `DaytonaRateLimitError`, and best practices such as exponential backoff, using `Retry-After`, queuing, reusing sandboxes, and using webhooks rather than polling when possible [12]. A DeepAgents adapter should implement retry only for safe idempotent lifecycle reads or creates where the call has not succeeded, and it should expose the underlying rate limit headers on errors where possible. Broad hidden retries around command execution would be risky because commands are not generally idempotent.

Preview URLs are a useful optional integration but should not be part of `DisposableSandbox`. Daytona can generate preview URLs for HTTP services on ports 3000 through 9999, with standard token-header URLs and signed URLs that embed a token and have a configurable expiration [13]. DeepAgents' current sandbox contract does not include preview URLs [19]. Add preview support as a Daytona-specific method on an extended type, a helper function, or metadata returned by a high-level Daytona wrapper. Do not pollute `DisposableSandbox` with a product-specific preview method.

### Finding 6: Deployment modes affect what "supported" means

Daytona can be used as hosted Daytona, open source self-hosted deployment, or customer-managed compute with custom regions and runners [1, 15, 16]. The TypeScript SDK configuration supports `apiUrl` and `target`, and the regions docs explain that sandboxes are scheduled onto runners within targeted regions [8, 14]. A supported backend should not assume `https://app.daytona.io/api` except as the SDK default. It should accept `apiUrl` and `target` explicitly and respect the SDK environment variables [8].

Self-hosting introduces operational constraints that can surface as sandbox errors. The open source deployment docs describe API, proxy, runner, SSH gateway, Caddy, wildcard TLS, firewall ports, Docker Compose, and inter-sandbox network isolation configuration [15]. Customer-managed compute uses custom region URLs for proxy, SSH gateway, and snapshot manager services, with generated credentials for those services [16]. DeepAgents does not need to manage these systems, but error messages should distinguish "Daytona API failed", "sandbox process failed", "preview proxy failed", and "network policy blocked access" rather than collapsing all failures into command stderr.

This matters for tests. Unit tests can validate option normalization and shell quoting without a Daytona account, but live integration tests require a configured Daytona environment. Tests should skip only when `DAYTONA_API_KEY` is missing, and they should fail clearly when credentials exist but the API, target, network, or rate limits are wrong. That pattern matches existing Docker tests, which detect Docker availability and skip only when Docker is not available [23]. It also keeps "supported" honest: if credentials are present, the backend should prove the real remote path.

### Finding 7: The initial implementation should be small, typed, and test-led

The first code slice should add a Daytona backend file, export it, and add integration tests without changing existing Docker or virtual behavior [19, 20, 22, 23]. The backend should implement `executeCommand` through Daytona process command execution, `readFile` and `writeFiles` through the `fs` module, `dispose` through sandbox deletion or an option-controlled stop/delete policy, and `spawn` through sessions only after the live-streaming test proves first-byte-before-exit behavior [4, 5, 6, 17, 19, 23]. If `spawn` cannot satisfy the test in the first pass, leave `spawn` undefined and document the missing exact capability rather than adding a buffered fallback [19, 24].

The first public API can be:

```ts
export interface DaytonaSandboxOptions {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  sandboxId?: string;
  name?: string;
  snapshot?: string;
  image?: string;
  language?: 'python' | 'typescript' | 'javascript';
  envVars?: Record<string, string>;
  resources?: { cpu?: number; memory?: number; disk?: number };
  networkAllowList?: string;
  networkBlockAll?: boolean;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  deleteOnDispose?: boolean;
  destination?: string;
}
```

That option set is intentionally close to Daytona docs rather than Docker-specific abstractions [3, 8, 9, 10, 14]. `deleteOnDispose` should default to true for ephemeral DeepAgents test sandboxes and should be explicit for attached sandboxes. If `sandboxId` is provided, `dispose` should probably not delete by default; attached sandboxes are often persistent developer resources. This needs a test because lifecycle semantics are expensive when wrong [3, 12].

The verification plan should mirror the existing Docker tests. Required tests are: buffered command success and nonzero exit mapping; file write and read round trip; `createBashTool` works with Daytona destination; first stdout chunk arrives before exit for `spawn`; stderr streams separately; `spawn` forwards `env`; `spawn` forwards or simulates `cwd`; abort signal terminates a long-running command; and file-event observation records a write created by a spawned process [21, 23]. The first five tests prove compatibility; the last four prevent subtle regressions in the exact areas DeepAgents previously tightened.

## Synthesis & Insights

The strongest pattern across sources is that Daytona is not just a remote `exec` API. It is a managed sandbox platform with a toolbox API, snapshots, filesystem operations, process sessions, PTY, previews, network controls, and regions [1, 3, 4, 5, 6, 7, 9, 10, 13, 14]. DeepAgents should resist the temptation to expose all of that immediately. The durable integration is a narrow `DisposableSandbox` backend plus optional Daytona helpers for Daytona-specific capabilities. That preserves the current architecture while leaving room for preview URLs, snapshots, and custom regions.

The second pattern is that process streaming is the only load-bearing uncertainty. Daytona clearly supports real-time log streaming for session commands, and its Codex guide uses that path for an agent inside a sandbox [6, 17]. However, the docs do not, by themselves, prove that the TypeScript SDK exposes every detail DeepAgents needs for `SandboxProcess.exit`, abort, cwd, env, and cleanup [5, 6, 17, 19]. The implementation must inspect the actual `@daytona/sdk` type declarations and run a real Daytona integration test before exporting `spawn` as supported.

The third pattern is that Daytona's native path conventions differ from the existing generic default. DeepAgents currently defaults to `/workspace`, while Daytona's official Codex guide uses `/home/daytona` [17, 20]. That is not a cosmetic issue because `createBashTool` uses destination for command working directory and file-event observation root [20, 21]. The integration should either create `/workspace` deliberately or default the Daytona high-level wrapper to `/home/daytona`. The report recommends the native default.

## Counterevidence Register

Daytona process sessions are promising for `spawn`, but the docs do not show a TypeScript API that directly returns a `ReadableStream` and an exit object in the DeepAgents shape [5, 6, 17, 19]. The adapter will need a small stream bridge and may need to retrieve command status separately.

Daytona PTY supports richer interactivity than process sessions, but PTY output is a terminal stream and may not preserve separate stdout and stderr semantics in the same way DeepAgents expects [7, 19]. PTY is therefore not the preferred first `spawn` implementation.

Daytona snapshots support OCI images and reproducible environments, but they do not automatically match DeepAgents' Docker installer abstraction [9, 22]. Porting installers directly would be premature without a tested snapshot creation flow.

Daytona network allow lists are IPv4 CIDR based and tier constrained, so a caller expecting domain-based allow lists or unrestricted egress may fail even when the DeepAgents adapter is correct [10]. The adapter should surface Daytona's error rather than masking it.

## Claims-Evidence Table

| Claim                                                                | Status                     | Primary evidence                                               |
| -------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------- |
| Daytona fits the backend capability model                            | Supported                  | Sandboxes, filesystem, and process docs [3, 4, 5]              |
| Daytona should use `DisposableSandbox` rather than a new abstraction | Supported                  | DeepAgents types and bash-tool composition [19, 20]            |
| Daytona has documented streaming surfaces                            | Supported                  | Session command log streaming, PTY, and Codex guide [6, 7, 17] |
| Session log streaming is the best first candidate for `spawn`        | Supported, needs live test | Log streaming docs and Codex guide [6, 17]                     |
| `/home/daytona` should be the Daytona high-level destination default | Supported                  | Codex guide and createBashTool destination behavior [17, 20]   |
| File-event observation can be reused with tool availability checks   | Supported                  | file-events implementation and snapshot/image support [9, 21]  |
| Rate limits must be handled explicitly                               | Supported                  | Daytona limits docs [12]                                       |

## Limitations & Caveats

This report is based on official Daytona docs retrieved on 2026-05-17, npm package metadata retrieved on the same date, and the current local DeepAgents checkout [1, 18, 19, 20, 21, 22, 23]. Daytona's docs are versioned around v0.176 in several pages, while npm reports `@daytona/sdk` latest as `0.175.0`; that mismatch means implementation should inspect the installed SDK type declarations before coding against exact method signatures [1, 18].

No live Daytona sandbox was created during this research because the task was research, not implementation, and no `DAYTONA_API_KEY` was provided in the prompt [8, 11]. The live-streaming, abort, cwd, env, and file-event claims for `spawn` are therefore design conclusions backed by docs and local DeepAgents tests, not live Daytona verification [6, 17, 23].

The report does not claim Daytona is a full replacement for Docker Compose in DeepAgents. Daytona has snapshots, images, regions, and custom compute, but the current Docker backend supports local Dockerfile and Compose-specific development workflows that are not automatically represented by Daytona's SDK [9, 15, 16, 22].

## Recommendations

Add `packages/context/src/lib/sandbox/daytona-sandbox.ts` with a Daytona-backed `DisposableSandbox`, export it from `packages/context/src/lib/sandbox/index.ts`, and keep the first public API focused on `createDaytonaSandbox(options)` [19, 22]. Do not change existing Docker, virtual, or Agent OS behavior in the same patch.

Implement `executeCommand`, `readFile`, `writeFiles`, and `dispose` first. Use Daytona `process.executeCommand` for buffered commands, Daytona `fs` operations for file transfer, and an explicit lifecycle policy for dispose, with attached sandboxes not deleted by default [4, 5, 19].

Implement `spawn` only through a real streaming primitive. Start with Daytona process sessions using `executeSessionCommand(..., { runAsync: true })` and `getSessionCommandLogs(...)`; expose callback chunks through `ReadableStream` and prove first-byte-before-exit behavior with a live test [6, 17, 23]. If this cannot satisfy exit or abort semantics, leave `spawn` undefined until a correct implementation exists [19, 24].

Add a Daytona-specific high-level wrapper that calls `createBashTool` with `destination: "/home/daytona"` unless the caller overrides it, creates the destination directory, and preserves skill upload and file-event observation [17, 20, 21].

Add integration tests gated on `DAYTONA_API_KEY`. The test suite should follow the Docker spawn test contract: buffered command, file read/write, bash-tool composition, real streaming, stderr separation, `env`, `cwd`, abort, and file-event writes from `spawn` [21, 23].

Expose network policy, resources, snapshots/images, and region/target as typed options. Do not hide Daytona tier, rate-limit, or network-policy errors behind generic command failures [3, 8, 9, 10, 12, 14].

## Bibliography

[1] Daytona Platforms, Inc. (2026). "Daytona Documentation". Daytona. https://www.daytona.io/docs/ (Retrieved: 2026-05-17)

[2] Daytona Platforms, Inc. (2026). "TypeScript SDK Reference". Daytona. https://www.daytona.io/docs/en/typescript-sdk/ (Retrieved: 2026-05-17)

[3] Daytona Platforms, Inc. (2026). "Sandboxes". Daytona. https://www.daytona.io/docs/en/sandboxes/ (Retrieved: 2026-05-17)

[4] Daytona Platforms, Inc. (2026). "File System Operations". Daytona. https://www.daytona.io/docs/en/file-system-operations/ (Retrieved: 2026-05-17)

[5] Daytona Platforms, Inc. (2026). "Process and Code Execution". Daytona. https://www.daytona.io/docs/en/process-code-execution/ (Retrieved: 2026-05-17)

[6] Daytona Platforms, Inc. (2026). "Log Streaming". Daytona. https://www.daytona.io/docs/en/log-streaming/ (Retrieved: 2026-05-17)

[7] Daytona Platforms, Inc. (2026). "Pseudo Terminal (PTY)". Daytona. https://www.daytona.io/docs/en/pty/ (Retrieved: 2026-05-17)

[8] Daytona Platforms, Inc. (2026). "Environment Configuration". Daytona. https://www.daytona.io/docs/en/configuration/ (Retrieved: 2026-05-17)

[9] Daytona Platforms, Inc. (2026). "Snapshots". Daytona. https://www.daytona.io/docs/en/snapshots/ (Retrieved: 2026-05-17)

[10] Daytona Platforms, Inc. (2026). "Network Limits". Daytona. https://www.daytona.io/docs/en/network-limits/ (Retrieved: 2026-05-17)

[11] Daytona Platforms, Inc. (2026). "API Keys". Daytona. https://www.daytona.io/docs/en/api-keys/ (Retrieved: 2026-05-17)

[12] Daytona Platforms, Inc. (2026). "Limits". Daytona. https://www.daytona.io/docs/en/limits/ (Retrieved: 2026-05-17)

[13] Daytona Platforms, Inc. (2026). "Preview". Daytona. https://www.daytona.io/docs/en/preview/ (Retrieved: 2026-05-17)

[14] Daytona Platforms, Inc. (2026). "Regions". Daytona. https://www.daytona.io/docs/en/regions/ (Retrieved: 2026-05-17)

[15] Daytona Platforms, Inc. (2026). "Open Source Deployment". Daytona. https://www.daytona.io/docs/en/oss-deployment/ (Retrieved: 2026-05-17)

[16] Daytona Platforms, Inc. (2026). "Customer Managed Compute". Daytona. https://www.daytona.io/docs/en/runners/ (Retrieved: 2026-05-17)

[17] Daytona Platforms, Inc. (2026). "Build a Coding Agent Using Codex SDK and Daytona". Daytona. https://www.daytona.io/docs/en/guides/codex/codex-sdk-interactive-terminal-sandbox/ (Retrieved: 2026-05-17)

[18] npm Registry (2026). "Package metadata for @daytona/sdk@0.175.0". npm. https://www.npmjs.com/package/@daytona/sdk (Retrieved with npm view: 2026-05-17)

[19] DeepAgents local source (2026). "Sandbox types". Local repository. packages/context/src/lib/sandbox/types.ts (Read: 2026-05-17)

[20] DeepAgents local source (2026). "createBashTool wrapper". Local repository. packages/context/src/lib/sandbox/bash-tool.ts (Read: 2026-05-17)

[21] DeepAgents local source (2026). "File-event observer". Local repository. packages/context/src/lib/sandbox/file-events.ts (Read: 2026-05-17)

[22] DeepAgents local source (2026). "Docker sandbox implementation". Local repository. packages/context/src/lib/sandbox/docker-sandbox.ts (Read: 2026-05-17)

[23] DeepAgents local test (2026). "Docker spawn integration test". Local repository. packages/context/test/docker-sandbox-spawn.integration.test.ts (Read: 2026-05-17)

[24] Codex memory registry (2026). "DeepAgents sandbox decorator and spawn primitive guidance". Local memory. /Users/ezzabuzaid/.codex/memories/MEMORY.md (Read: 2026-05-17)

## Methodology Appendix

Phase 1, Scope: The research decomposed the request into Daytona product capabilities, Daytona TypeScript SDK and API implications, DeepAgents backend contract requirements, and a test-driven implementation plan [1, 19, 23].

Phase 2, Plan: The retrieval plan prioritized official Daytona docs, the current npm package surface, local DeepAgents source, and prior sandbox design memory. Third-party commentary was intentionally deprioritized because implementation correctness depends on primary docs and local contracts [1, 18, 19, 24].

Phase 3, Retrieve: The research reviewed Daytona docs for sandboxes, TypeScript SDK, filesystem, process execution, log streaming, PTY, configuration, snapshots, network limits, API keys, limits, preview URLs, regions, open source deployment, customer-managed compute, and the official Codex guide [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]. It also inspected local DeepAgents sandbox source and tests [19, 20, 21, 22, 23].

Phase 4, Triangulate: Core claims were cross-checked between Daytona docs and local DeepAgents code. For example, the `spawn` recommendation uses Daytona log streaming docs, the Daytona Codex guide, DeepAgents type comments, and Docker spawn tests together rather than relying on one source [6, 17, 19, 23].

Phase 4.5, Outline refinement: The initial broad outline was narrowed around implementation risk. The evidence showed basic lifecycle, filesystem, and command execution were straightforward, while `spawn`, workspace path, file-event observation, lifecycle disposal, and rate limits deserved the most detail [6, 17, 20, 21, 23].

Phase 5, Synthesize: The report converts product facts into implementation recommendations: add a backend, keep `DisposableSandbox`, use session log streaming for `spawn`, default high-level Daytona tooling to `/home/daytona`, and verify with live integration tests [17, 19, 20, 23].

Phase 6, Critique: Counterevidence was tracked for SDK version mismatch, missing live Daytona run, PTY stdout/stderr semantics, network tier constraints, and Docker Compose non-equivalence [7, 10, 18, 22].

Phase 7, Refine: Recommendations were limited to the first durable slice and avoid broad feature expansion. Advanced features such as GPU, Docker-in-Docker, Kubernetes, preview helpers, and custom regions are documented as later extensions unless an implementation consumer requires them [9, 13, 14, 15, 16].

Phase 8, Package: The research package includes this Markdown report, `sources.jsonl`, `evidence.jsonl`, `claims.jsonl`, and `run_manifest.json` under `research/daytona-sandbox-research-20260517/`.
