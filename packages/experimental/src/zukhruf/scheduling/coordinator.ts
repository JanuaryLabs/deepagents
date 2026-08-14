import { CronExpressionParser } from 'cron-parser';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import type { ContextStore } from '@deepagents/context';

import type { AgentControlPlane } from '../control-plane/agent-control-plane.ts';
import { conversationNamespace } from '../control-plane/agent-turn-id.ts';
import type { ConversationId } from '../mailbox/types.ts';
import type { ScheduledTurnMetadata } from '../queue/turn-queue.ts';
import type { Wake, WakeScheduler } from './wake-scheduler.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const CRON_LIFETIME_MS = 7 * DAY_MS;
const MAX_CRON_JOBS = 50;

const cronDefinitionSchema = z
  .object({
    id: z.uuid(),
    expression: z.string().min(1),
    prompt: z.string(),
    recurring: z.boolean(),
    timezone: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    nextRunAt: z.number().int().nonnegative(),
    generation: z.number().int().positive(),
  })
  .strict();

const schedulingStateSchema = z
  .object({
    cron: z.record(z.string(), cronDefinitionSchema),
    dynamic: z
      .object({
        prompt: z.string(),
        reason: z.string(),
        createdAt: z.number().int().nonnegative(),
        nextRunAt: z.number().int().nonnegative(),
        generation: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine(({ cron }, context) => {
    for (const [id, definition] of Object.entries(cron)) {
      if (id !== definition.id) {
        context.addIssue({
          code: 'custom',
          message: `cron key "${id}" does not match definition id "${definition.id}"`,
          path: ['cron', id, 'id'],
        });
      }
    }
  });

type SchedulingState = z.infer<typeof schedulingStateSchema>;
type CronDefinition = SchedulingState['cron'][string];

export interface SchedulingWake {
  conversation: ConversationId;
  kind: 'cron' | 'dynamic';
  definitionId?: string;
  generation: number;
  scheduledFor: number;
}

const schedulingWakeSchema: z.ZodType<SchedulingWake> = z
  .object({
    conversation: z
      .object({ chatId: z.string().min(1), userId: z.string().min(1) })
      .strict(),
    kind: z.enum(['cron', 'dynamic']),
    definitionId: z.uuid().optional(),
    generation: z.number().int().positive(),
    scheduledFor: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((wake, context) => {
    if ((wake.kind === 'cron') !== (wake.definitionId !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'cron wakes require definitionId and dynamic wakes omit it',
      });
    }
  });

interface SchedulingCoordinatorOptions {
  store: ContextStore;
  scheduler: WakeScheduler<SchedulingWake>;
  controlPlane: AgentControlPlane;
  canMaterialize: (conversation: ConversationId) => Promise<boolean>;
  timezone: string;
}

interface CronCreateInput {
  cron: string;
  prompt: string;
  recurring?: boolean;
}

/** Conversation scheduling state, recurrence, and turn conversion. */
export class SchedulingCoordinator {
  readonly #store: ContextStore;
  readonly #scheduler: WakeScheduler<SchedulingWake>;
  readonly #controlPlane: AgentControlPlane;
  readonly #canMaterialize: SchedulingCoordinatorOptions['canMaterialize'];
  readonly timezone: string;

  constructor(options: SchedulingCoordinatorOptions) {
    this.#store = options.store;
    this.#scheduler = options.scheduler;
    this.#controlPlane = options.controlPlane;
    this.#canMaterialize = options.canMaterialize;
    this.timezone = SchedulingCoordinator.#resolveTimezone(options.timezone);
  }

  async createCron(
    conversation: ConversationId,
    input: CronCreateInput,
    operationId: string,
  ): Promise<CronDefinition> {
    const expression = input.cron.trim();
    const recurring = input.recurring ?? true;
    const createdAt = Date.now();
    const nextRunAt = this.#nextOccurrence(
      expression,
      this.timezone,
      createdAt,
    );
    const matches = (definition: CronDefinition) =>
      definition.expression === expression &&
      definition.prompt === input.prompt &&
      definition.recurring === recurring &&
      definition.timezone === this.timezone;

    const id = uuidv5(operationId, conversationNamespace(conversation));
    const state = await this.#read(conversation);
    const existing = state.cron[id];
    if (existing) {
      if (matches(existing)) return existing;
      throw new Error(`CronCreate operation "${operationId}" was reused`);
    }
    if (Object.keys(state.cron).length >= MAX_CRON_JOBS) {
      throw new Error(
        `CronCreate supports at most ${MAX_CRON_JOBS} active jobs per conversation`,
      );
    }
    const definition: CronDefinition = {
      id,
      expression,
      prompt: input.prompt,
      recurring,
      timezone: this.timezone,
      createdAt,
      expiresAt: recurring ? createdAt + CRON_LIFETIME_MS : nextRunAt,
      nextRunAt,
      generation: 1,
    };
    await this.#armCron(conversation, definition);

    let committed = definition;
    await this.#update(conversation, (current) => {
      const currentDefinition = current.cron[id];
      if (currentDefinition) {
        if (!matches(currentDefinition)) {
          throw new Error(`CronCreate operation "${operationId}" was reused`);
        }
        committed = currentDefinition;
        return current;
      }
      if (Object.keys(current.cron).length >= MAX_CRON_JOBS) {
        throw new Error(
          `CronCreate supports at most ${MAX_CRON_JOBS} active jobs per conversation`,
        );
      }
      return { ...current, cron: { ...current.cron, [id]: definition } };
    });
    return committed;
  }

  async cronJobs(conversation: ConversationId): Promise<CronDefinition[]> {
    const state = await this.#read(conversation);
    return Object.values(state.cron).toSorted((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async deleteCron(conversation: ConversationId, id: string): Promise<void> {
    let removed: CronDefinition | undefined;
    await this.#update(conversation, (state) => {
      removed = state.cron[id];
      if (!removed) throw new Error(`CronDelete could not find job "${id}"`);
      const cron = { ...state.cron };
      delete cron[id];
      return { ...state, cron };
    });
    try {
      await this.#scheduler.cancel(this.#cronWake(conversation, removed!).id);
    } catch {
      // Metadata is authoritative; a claimed/stale receipt validates and no-ops.
    }
  }

  async scheduleDynamic(
    conversation: ConversationId,
    input: { delaySeconds: number; reason: string; prompt: string },
  ): Promise<{
    scheduledFor: number;
    clampedDelaySeconds: number;
    wasClamped: boolean;
  }> {
    const rounded = Math.round(input.delaySeconds);
    const clampedDelaySeconds = Math.min(3_600, Math.max(60, rounded));
    const createdAt = Date.now();
    const nextRunAt = createdAt + clampedDelaySeconds * 1_000;
    const generation = SchedulingCoordinator.#randomGeneration();
    let previous: SchedulingState['dynamic'];
    const dynamic = {
      prompt: input.prompt,
      reason: input.reason,
      createdAt,
      nextRunAt,
      generation,
    };
    await this.#scheduler.schedule(this.#dynamicWake(conversation, dynamic));
    await this.#update(conversation, (state) => {
      previous = state.dynamic;
      return { ...state, dynamic };
    });
    if (previous) {
      try {
        await this.#scheduler.cancel(
          this.#dynamicWake(conversation, previous).id,
        );
      } catch {
        // Replacement is committed; stale delivery validates and no-ops.
      }
    }
    return {
      scheduledFor: nextRunAt,
      clampedDelaySeconds,
      wasClamped: rounded !== clampedDelaySeconds,
    };
  }

  async stopDynamic(conversation: ConversationId): Promise<number> {
    let removed: SchedulingState['dynamic'];
    await this.#update(conversation, (state) => {
      removed = state.dynamic;
      if (!removed) return state;
      const { dynamic: _, ...withoutDynamic } = state;
      return withoutDynamic;
    });
    if (!removed) return 0;
    try {
      await this.#scheduler.cancel(this.#dynamicWake(conversation, removed).id);
    } catch {
      // Metadata is authoritative; stale delivery validates and no-ops.
    }
    return 1;
  }

  async work(): Promise<AsyncDisposable> {
    return this.#scheduler.consume((wake) => this.#handle(wake));
  }

  async materializeDueIfEligible(conversation: ConversationId): Promise<void> {
    if (!(await this.#canMaterialize(conversation))) return;
    const state = await this.#read(conversation);
    const now = Date.now();
    const due = [
      ...Object.values(state.cron).map((definition) => ({
        runAt: definition.nextRunAt,
        wake: this.#cronWake(conversation, definition),
      })),
      ...(state.dynamic
        ? [
            {
              runAt: state.dynamic.nextRunAt,
              wake: this.#dynamicWake(conversation, state.dynamic),
            },
          ]
        : []),
    ]
      .filter(({ runAt }) => runAt <= now)
      .toSorted(
        (left, right) =>
          left.runAt - right.runAt || left.wake.id.localeCompare(right.wake.id),
      )[0];
    if (due) await this.#handle(due.wake);
  }

  async #handle(rawWake: Wake<SchedulingWake>): Promise<void> {
    const wake = schedulingWakeSchema.parse(rawWake.data);
    if (rawWake.runAt.getTime() !== wake.scheduledFor) {
      throw new Error('Scheduling wake due time does not match its payload');
    }
    if (rawWake.id !== this.#wakeId(wake)) {
      throw new Error(
        `Scheduling wake id "${rawWake.id}" does not match its payload`,
      );
    }
    const state = await this.#read(wake.conversation);
    const definition = this.#matchingCron(state, wake);
    const dynamic = this.#matchingDynamic(state, wake);
    const prompt = definition?.prompt ?? dynamic?.prompt;
    if (prompt === undefined) return;
    if (definition && definition.nextRunAt > definition.expiresAt) {
      await this.#update(wake.conversation, (current) => {
        const expired = this.#matchingCron(current, wake);
        if (!expired) return current;
        const cron = { ...current.cron };
        delete cron[expired.id];
        return { ...current, cron };
      });
      return;
    }
    if (!(await this.#canMaterialize(wake.conversation))) return;

    const successor =
      definition?.recurring === true
        ? {
            ...definition,
            nextRunAt: this.#nextOccurrence(
              definition.expression,
              definition.timezone,
              Math.max(Date.now(), definition.nextRunAt),
            ),
            generation: definition.generation + 1,
          }
        : undefined;
    const activeSuccessor =
      successor && successor.nextRunAt <= successor.expiresAt
        ? successor
        : undefined;
    if (activeSuccessor) {
      await this.#armCron(wake.conversation, activeSuccessor);
    }

    const occurrenceId = this.#occurrenceId(wake);
    const schedule: ScheduledTurnMetadata = {
      kind: wake.kind,
      ...(wake.definitionId === undefined
        ? {}
        : { definitionId: wake.definitionId }),
      generation: wake.generation,
      scheduledFor: wake.scheduledFor,
      occurrenceId,
    };
    await this.#controlPlane.enqueueScheduled(wake.conversation, {
      id: occurrenceId,
      input: prompt,
      schedule,
    });

    await this.#update(wake.conversation, (current) => {
      if (wake.kind === 'dynamic') {
        if (!this.#matchingDynamic(current, wake)) return current;
        const { dynamic: _, ...withoutDynamic } = current;
        return withoutDynamic;
      }

      const definition = this.#matchingCron(current, wake);
      if (!definition) return current;
      const cron = { ...current.cron };
      if (!activeSuccessor) {
        delete cron[definition.id];
        return { ...current, cron };
      }
      cron[definition.id] = activeSuccessor;
      return { ...current, cron };
    });
  }

  #matchingCron(
    state: SchedulingState,
    wake: SchedulingWake,
  ): CronDefinition | undefined {
    if (wake.kind !== 'cron' || wake.definitionId === undefined) return;
    const definition = state.cron[wake.definitionId];
    return definition?.generation === wake.generation &&
      definition.nextRunAt === wake.scheduledFor
      ? definition
      : undefined;
  }

  #matchingDynamic(
    state: SchedulingState,
    wake: SchedulingWake,
  ): SchedulingState['dynamic'] {
    if (wake.kind !== 'dynamic') return;
    return state.dynamic?.generation === wake.generation &&
      state.dynamic.nextRunAt === wake.scheduledFor
      ? state.dynamic
      : undefined;
  }

  #armCron(
    conversation: ConversationId,
    definition: CronDefinition,
  ): Promise<void> {
    return this.#scheduler.schedule(this.#cronWake(conversation, definition));
  }

  #cronWake(
    conversation: ConversationId,
    definition: CronDefinition,
  ): Wake<SchedulingWake> {
    return this.#toWake({
      conversation,
      kind: 'cron',
      definitionId: definition.id,
      generation: definition.generation,
      scheduledFor: definition.nextRunAt,
    });
  }

  #dynamicWake(
    conversation: ConversationId,
    dynamic: NonNullable<SchedulingState['dynamic']>,
  ): Wake<SchedulingWake> {
    return this.#toWake({
      conversation,
      kind: 'dynamic',
      generation: dynamic.generation,
      scheduledFor: dynamic.nextRunAt,
    });
  }

  #toWake(data: SchedulingWake): Wake<SchedulingWake> {
    return {
      id: this.#wakeId(data),
      runAt: new Date(data.scheduledFor),
      data,
    };
  }

  #wakeId(wake: SchedulingWake): string {
    return uuidv5(
      JSON.stringify([
        'wake',
        wake.kind,
        wake.definitionId ?? null,
        wake.generation,
        wake.scheduledFor,
      ]),
      conversationNamespace(wake.conversation),
    );
  }

  #occurrenceId(wake: SchedulingWake): string {
    return uuidv5(
      JSON.stringify([
        'occurrence',
        wake.kind,
        wake.definitionId ?? null,
        wake.generation,
        wake.scheduledFor,
      ]),
      conversationNamespace(wake.conversation),
    );
  }

  #nextOccurrence(expression: string, timezone: string, after: number): number {
    if (expression.split(/\s+/).length !== 5) {
      throw new Error('CronCreate requires exactly five cron fields');
    }
    const oneYearLater = new Date(after);
    oneYearLater.setUTCFullYear(oneYearLater.getUTCFullYear() + 1);
    try {
      return CronExpressionParser.parse(expression, {
        currentDate: new Date(after),
        endDate: oneYearLater,
        tz: timezone,
      })
        .next()
        .getTime();
    } catch (cause) {
      throw new Error(
        'CronCreate requires a valid five-field expression with a match in the next year',
        { cause },
      );
    }
  }

  async #read(conversation: ConversationId): Promise<SchedulingState> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (!chat)
      throw new Error(`Scheduling chat "${conversation.chatId}" not found`);
    if (chat.userId !== conversation.userId) {
      throw new Error(
        `chat "${conversation.chatId}" belongs to user "${chat.userId}", not "${conversation.userId}"`,
      );
    }
    return this.#parse(chat.metadata);
  }

  async #update(
    conversation: ConversationId,
    update: (state: SchedulingState) => SchedulingState,
  ): Promise<void> {
    await this.#store.updateChat(conversation.chatId, (chat) => {
      if (chat.userId !== conversation.userId) {
        throw new Error(
          `chat "${conversation.chatId}" belongs to user "${chat.userId}", not "${conversation.userId}"`,
        );
      }
      const state = update(this.#parse(chat.metadata));
      const metadata = chat.metadata ?? {};
      const zukhruf = SchedulingCoordinator.#record(metadata.zukhruf);
      return {
        metadata: {
          ...metadata,
          zukhruf: { ...zukhruf, scheduling: state },
        },
      };
    });
  }

  #parse(metadata: Record<string, unknown> | undefined): SchedulingState {
    if (metadata?.zukhruf === undefined) return { cron: {} };
    const zukhruf = SchedulingCoordinator.#record(metadata.zukhruf);
    if (zukhruf.scheduling === undefined) return { cron: {} };
    const parsed = schedulingStateSchema.safeParse(zukhruf.scheduling);
    if (!parsed.success) {
      throw new Error('Invalid metadata.zukhruf.scheduling state', {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  static #record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Invalid metadata.zukhruf state');
    }
    return value as Record<string, unknown>;
  }

  static #resolveTimezone(timezone: string): string {
    try {
      return new Intl.DateTimeFormat('en', {
        timeZone: timezone,
      }).resolvedOptions().timeZone;
    } catch (cause) {
      throw new Error(`Invalid scheduling timezone "${timezone}"`, { cause });
    }
  }

  static #randomGeneration(): number {
    const [high, low] = crypto.getRandomValues(new Uint32Array(2));
    return Number((BigInt(high) << 21n) | BigInt(low >>> 11)) || 1;
  }
}
