import {
  type GenerateTextOnStartCallback,
  type GenerateTextOnStepEndCallback,
  type GenerateTextOnStepStartCallback,
  type ModelMessage,
  type PrepareStepFunction,
  type StepResult,
  type ToolSet,
  asSchema,
  modelMessageSchema,
} from 'ai';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  type CompactResult,
  type CompactionFailureReason,
  compact,
  estimateTokens,
} from '@deepagents/compaction';
import type { ContextEngine, ContextStore } from '@deepagents/context';

import type { AgentCompaction } from '../agent.ts';

/** Payload of AI SDK `data-compaction` parts; IDs group one evaluation. */
export type CompactionEvent = { id: string } & (
  | {
      status: 'restored';
      sourceMessages: number;
      replacementMessages: number;
    }
  | {
      status: 'started';
      /** Absent on historical events that counted only messages. */
      tokenScope?: 'request';
      triggerIndex: number;
      tokensBefore: number;
      targetTokens: number;
      messageCount: number;
    }
  | {
      status: 'completed';
      /** Absent on historical events that counted only messages. */
      tokenScope?: 'request';
      tokens: CompactResult['tokens'];
      replacedRange: { start: number; end: number };
      usage: CompactResult['usage'];
    }
  | {
      status: 'failed';
      phase: 'restore' | 'evaluate' | 'compact' | 'persist';
      reason: CompactionFailureReason | 'request-overhead' | 'error';
    }
);

const checkpointSchema = z.object({
  sourceCount: z.number().int().positive(),
  sourceHash: z.string(),
  replacement: z
    .array(z.unknown())
    .transform((messages) =>
      messages.map((message) => modelMessageSchema.parse(message)),
    ),
});

const cacheObservationSchema = z.object({
  scope: z.string(),
  prefixLength: z.number().int().nonnegative(),
  prefixHash: z.string(),
  startedAt: z.number().int().nonnegative(),
  retentionMs: z.number().int().positive().optional(),
});

const inputUsageSchema = cacheObservationSchema
  .pick({ scope: true, prefixLength: true, prefixHash: true })
  .extend({ inputTokens: z.number().int().nonnegative() });

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve policy from the provider's request metadata after model middleware. */
function cacheRetentionMs<TOOLS extends ToolSet>(
  step: Pick<
    StepResult<TOOLS>,
    'model' | 'request' | 'response' | 'providerMetadata' | 'usage'
  >,
): number | undefined {
  let body = step.request.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(body)) return undefined;
  const provider = step.model.provider;
  const routed = provider === 'openrouter' || provider === 'openrouter.chat';
  const upstream = routed
    ? step.providerMetadata?.openrouter?.provider
    : undefined;

  if (
    provider === 'openai.responses' ||
    provider === 'openai.chat' ||
    (routed && upstream === 'OpenAI')
  ) {
    // https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime
    const options = body.prompt_cache_options;
    if (options !== undefined && !isRecord(options)) return undefined;
    if (isRecord(options) && options.ttl !== undefined) {
      return options.ttl === '30m' ? 30 * 60_000 : undefined;
    }
    const version = /^(?:openai\/)?gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(
      step.response.modelId,
    );
    if (
      version &&
      (Number(version[1]) >= 6 ||
        (Number(version[1]) === 5 && Number(version[2]) >= 6))
    ) {
      return 30 * 60_000;
    }
    // Earlier models: use the documented upper retention bound. An omitted
    // policy depends on the organization's data-retention settings, so is unknown.
    if (body.prompt_cache_retention === 'in_memory') return 60 * 60_000;
    if (body.prompt_cache_retention === '24h') return 24 * 60 * 60_000;
    return undefined;
  }

  if (
    provider === 'anthropic.messages' ||
    provider === 'claude.messages' ||
    (routed && upstream === 'Anthropic')
  ) {
    // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
    // Inspect only wire-level cache breakpoints, not arbitrary tool input schemas.
    const blocks: unknown[] = [body];
    for (const field of ['system', 'tools', 'messages']) {
      if (Array.isArray(body[field])) blocks.push(...body[field]);
    }
    const windows: number[] = [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (Array.isArray(block.content)) blocks.push(...block.content);
      const control = block.cache_control;
      if (control === undefined) continue;
      if (!isRecord(control) || control.type !== 'ephemeral') return undefined;
      // ttl is optional in Anthropic's native cache-control schema; omission is 5m.
      if (control.ttl === undefined || control.ttl === '5m')
        windows.push(5 * 60_000);
      else if (control.ttl === '1h') windows.push(60 * 60_000);
      else return undefined;
    }
    const creation = step.usage.raw?.cache_creation;
    if (isRecord(creation)) {
      if (
        typeof creation.ephemeral_1h_input_tokens === 'number' &&
        creation.ephemeral_1h_input_tokens > 0
      )
        return 60 * 60_000;
      if (
        step.usage.inputTokenDetails.cacheReadTokens === 0 &&
        creation.ephemeral_1h_input_tokens === 0 &&
        typeof creation.ephemeral_5m_input_tokens === 'number' &&
        creation.ephemeral_5m_input_tokens > 0
      )
        return 5 * 60_000;
    }
    // Reads do not identify their TTL. Mixed requested windows alone cannot
    // establish which breakpoint was eligible for caching.
    return new Set(windows).size === 1 ? windows[0] : undefined;
  }
  return undefined;
}

/** Projects model history while leaving the durable UI transcript untouched. */
export function createCompaction<TOOLS extends ToolSet>(
  config: AgentCompaction,
  engine: ContextEngine,
  store: ContextStore,
  signal: AbortSignal,
  onEvent: (event: CompactionEvent) => void,
) {
  let initialized = false;
  let source: ModelMessage[] = [];
  let replacement: ModelMessage[] = [];
  let cache: z.infer<typeof cacheObservationSchema> | null = null;
  let baseline: z.infer<typeof inputUsageSchema> | null = null;
  let request: Omit<z.infer<typeof cacheObservationSchema>, 'retentionMs'>;
  let settingsHash: string;
  let settings: Parameters<GenerateTextOnStartCallback<TOOLS>>[0];

  // The SDK calls onStart before prepareStep, with the complete tool set
  // including sandbox tools. Resolve descriptions at each preparation boundary.
  const onStart: GenerateTextOnStartCallback<TOOLS> = (input) => {
    settings = input;
  };

  const envelope = async (
    input: Pick<
      Parameters<PrepareStepFunction<ToolSet>>[0],
      'instructions' | 'toolsContext' | 'experimental_sandbox'
    >,
  ) => {
    const toolsContext: Readonly<Record<string, unknown>> = input.toolsContext;
    const tools =
      settings.tools === undefined
        ? []
        : await Promise.all(
            Object.entries(settings.tools)
              .filter(
                ([name]) =>
                  settings.activeTools === undefined ||
                  settings.activeTools.includes(name),
              )
              .map(async ([name, tool]) => [
                name,
                tool.type === 'provider'
                  ? [tool.id, tool.args]
                  : [
                      typeof tool.description === 'function'
                        ? tool.description({
                            context: toolsContext[name],
                            experimental_sandbox: input.experimental_sandbox,
                          })
                        : tool.description,
                      await asSchema(tool.inputSchema).jsonSchema,
                      tool.providerOptions,
                      tool.inputExamples,
                      tool.strict,
                    ],
              ]),
          );
    const responseFormat = await settings.output?.responseFormat;
    settingsHash = hash([
      tools,
      settings.providerOptions,
      settings.toolChoice,
      settings.activeTools,
      settings.toolOrder,
      responseFormat,
    ]);
    const messages: ModelMessage[] =
      typeof input.instructions === 'string'
        ? [{ role: 'system', content: input.instructions }]
        : input.instructions === undefined
          ? []
          : Array.isArray(input.instructions)
            ? [...input.instructions]
            : [input.instructions];
    // Estimate the schema/catalog text without cloning SDK tool-caller formatting.
    if (tools.length > 0)
      messages.push({ role: 'system', content: JSON.stringify(tools) });
    if (responseFormat?.type === 'json')
      messages.push({
        role: 'system',
        content: JSON.stringify(responseFormat),
      });
    return estimateTokens(messages);
  };

  const scope = (
    model: string | { provider: string; modelId: string },
    instructions: unknown,
  ) =>
    hash([
      engine.branch,
      typeof model === 'string' ? model : [model.provider, model.modelId],
      instructions,
      settingsHash,
    ]);

  const prepareStep = async (
    input: Pick<
      Parameters<PrepareStepFunction<ToolSet>>[0],
      | 'messages'
      | 'model'
      | 'instructions'
      | 'toolsContext'
      | 'experimental_sandbox'
    >,
  ) => {
    const id = randomUUID();
    let phase: 'restore' | 'evaluate' | 'compact' | 'persist' = 'restore';
    let reason: CompactionFailureReason | 'request-overhead' | 'error' =
      'error';
    try {
      signal.throwIfAborted();
      let messages = input.messages;
      if (!initialized) {
        const chat = await store.getChat(engine.chatId);
        const metadata = chat?.metadata?.zukhruf;
        const saved = isRecord(metadata) ? metadata.compaction : undefined;
        const savedCache = isRecord(metadata)
          ? metadata.promptCache
          : undefined;
        baseline =
          inputUsageSchema.safeParse(
            isRecord(metadata) ? metadata.inputUsage : undefined,
          ).data ?? null;
        if (savedCache !== undefined) {
          cache = cacheObservationSchema.nullable().parse(savedCache);
        }
        if (saved !== undefined) {
          const checkpoint = checkpointSchema.parse(saved);
          const prefix = messages.slice(0, checkpoint.sourceCount);
          // Rewinds, changed approvals, and edits may invalidate a checkpoint.
          // Only reuse it when its entire source prefix still matches.
          if (
            prefix.length === checkpoint.sourceCount &&
            hash(prefix) === checkpoint.sourceHash
          ) {
            source = prefix;
            replacement = checkpoint.replacement;
            messages = [
              ...replacement,
              ...messages.slice(checkpoint.sourceCount),
            ];
            onEvent({
              id,
              status: 'restored',
              sourceMessages: source.length,
              replacementMessages: replacement.length,
            });
          }
        }
        initialized = true;
      }

      // AI SDK carries prepareStep message overrides into subsequent steps.
      // Recover the original prefix solely for durable source attribution.
      if (
        replacement.length > 0 &&
        hash(messages.slice(0, replacement.length)) !== hash(replacement)
      ) {
        source = [];
        replacement = [];
      }
      phase = 'evaluate';
      const original = [...source, ...messages.slice(replacement.length)];
      const overhead = await envelope(input);
      const messageTokens = await (config.countTokens ?? estimateTokens)(
        messages,
      );
      const tokens =
        config.countTokens === undefined &&
        baseline !== null &&
        baseline.scope === scope(input.model, input.instructions) &&
        baseline.prefixLength <= messages.length &&
        baseline.prefixHash === hash(messages.slice(0, baseline.prefixLength))
          ? baseline.inputTokens +
            estimateTokens(messages.slice(baseline.prefixLength))
          : messageTokens + overhead;
      if (
        !Number.isSafeInteger(messageTokens) ||
        messageTokens < 0 ||
        !Number.isSafeInteger(tokens)
      ) {
        throw new RangeError(
          'compaction countTokens must return a non-negative safe integer.',
        );
      }
      signal.throwIfAborted();
      const now = Date.now();
      // ponytail: prefix age is a heuristic; exact liveness needs provider support.
      const cacheAgeMs =
        cache !== null &&
        cache.scope === scope(input.model, input.instructions) &&
        cache.prefixLength <= messages.length &&
        cache.prefixHash === hash(messages.slice(0, cache.prefixLength)) &&
        now >= cache.startedAt
          ? now - cache.startedAt
          : undefined;
      const context = {
        messages,
        tokens,
        cacheAgeMs,
        cacheRetentionMs: cache?.retentionMs,
      };
      let triggerIndex = -1;
      for (const [index, trigger] of config.triggers.entries()) {
        signal.throwIfAborted();
        if (await trigger(context)) {
          triggerIndex = index;
          break;
        }
      }
      signal.throwIfAborted();
      if (triggerIndex === -1) return { messages };

      phase = 'compact';
      onEvent({
        id,
        status: 'started',
        tokenScope: 'request',
        triggerIndex,
        tokensBefore: tokens,
        targetTokens: config.targetTokens,
        messageCount: messages.length,
      });
      const targetTokens = config.targetTokens - overhead;
      if (targetTokens < 1) {
        reason = 'request-overhead';
        throw new Error(
          'Compaction input target is exhausted by instructions and tools.',
        );
      }
      const result = await compact({
        ...config,
        targetTokens,
        messages,
        abortSignal: signal,
      });
      if (result.usage) await engine.trackUsage(result.usage);
      if (result.status === 'cannot-fit') {
        reason = result.reason;
        throw new Error(
          `Compaction could not fit the conversation: ${result.reason}`,
        );
      }
      const sourceCount =
        source.length +
        Math.max(0, result.replacedRange.end - replacement.length);
      const nextSource = original.slice(0, sourceCount);
      const nextReplacement = result.messages.slice(
        0,
        result.messages.length - (original.length - sourceCount),
      );
      const checkpoint = {
        sourceCount,
        sourceHash: hash(nextSource),
        replacement: nextReplacement,
      };
      signal.throwIfAborted();
      // The queue serializes turns per chat. Commit the complete checkpoint before
      // sending its projection to the model; recovery revalidates its source hash.
      phase = 'persist';
      await store.updateChat(engine.chatId, ({ metadata }) => ({
        metadata: {
          ...metadata,
          zukhruf: {
            ...(isRecord(metadata?.zukhruf) ? metadata.zukhruf : {}),
            compaction: checkpoint,
            inputUsage: null,
          },
        },
      }));
      signal.throwIfAborted();
      source = nextSource;
      replacement = nextReplacement;
      baseline = null;
      onEvent({
        id,
        status: 'completed',
        tokenScope: 'request',
        tokens: { before: tokens, after: result.tokens.after + overhead },
        replacedRange: result.replacedRange,
        usage: result.usage,
      });
      return { messages: result.messages };
    } catch (error) {
      // Cancellation closes the turn stream; its durable status is authoritative.
      if (!signal.aborted) onEvent({ id, status: 'failed', phase, reason });
      throw error;
    }
  };

  const onStepStart: GenerateTextOnStepStartCallback<TOOLS> = (input) => {
    request = {
      scope: scope(input, input.instructions),
      prefixLength: input.messages.length,
      prefixHash: hash(input.messages),
      startedAt: Date.now(),
    };
  };
  const onStepEnd: GenerateTextOnStepEndCallback<TOOLS> = async (step) => {
    if (signal.aborted || step.finishReason === 'error') return;
    const iterations = step.usage.raw?.iterations;
    // Native compaction/iteration totals can describe billing, not the sent prompt.
    const ambiguous =
      (iterations != null &&
        (!Array.isArray(iterations) ||
          iterations.length !== 1 ||
          !isRecord(iterations[0]) ||
          iterations[0].type !== 'message')) ||
      step.content.some(
        (part) =>
          (part.type === 'custom' && part.kind === 'openai.compaction') ||
          (part.type === 'text' &&
            part.providerMetadata?.anthropic?.type === 'compaction'),
      );
    const nextBaseline = ambiguous
      ? null
      : (inputUsageSchema.safeParse({
          ...request,
          inputTokens: step.usage.inputTokens,
        }).data ?? null);
    const { cacheReadTokens, cacheWriteTokens } = step.usage.inputTokenDetails;
    const next =
      (cacheReadTokens !== undefined && cacheReadTokens > 0) ||
      (cacheWriteTokens !== undefined && cacheWriteTokens > 0)
        ? { ...request, retentionMs: cacheRetentionMs(step) }
        : null;
    if (
      next === null &&
      cache === null &&
      nextBaseline === null &&
      baseline === null
    )
      return;
    await store.updateChat(engine.chatId, ({ metadata }) => ({
      metadata: {
        ...metadata,
        zukhruf: {
          ...(isRecord(metadata?.zukhruf) ? metadata.zukhruf : {}),
          promptCache: next,
          inputUsage: nextBaseline,
        },
      },
    }));
    cache = next;
    baseline = nextBaseline;
  };
  return {
    prepareStep,
    onStart,
    onStepStart,
    onStepEnd,
    include: { requestBody: true },
  };
}
