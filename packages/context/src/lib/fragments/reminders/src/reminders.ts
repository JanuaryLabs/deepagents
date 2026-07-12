import { type UIMessage, generateId } from 'ai';

import { type ContextFragment, isFragment } from '../../../fragments.ts';
import { XmlRenderer } from '../../../renderers/abstract.renderer.ts';
import { extractPlainText } from '../../../text.ts';
import type {
  ConditionalReminder,
  ReminderContext,
  ReminderOptions,
  ReminderRange,
  ReminderResolution,
  ReminderTarget,
  ReminderText,
  SyncReminderText,
  SyntheticReminderMetadata,
  UserReminderMetadata,
} from './types.ts';

export function isConditionalReminder(
  fragment: ContextFragment,
): fragment is ContextFragment & {
  metadata: { reminder: ConditionalReminder };
} {
  return fragment.name === 'reminder' && !!fragment.metadata?.reminder;
}

const SYSTEM_REMINDER_OPEN_TAG = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE_TAG = '</system-reminder>';

type ReminderMetadataRecord = ReminderRange;

export function getReminderRanges(
  metadata: Record<string, unknown> | undefined,
): ReminderRange[] {
  return getReminderMetadataRecords(metadata).map((record) => ({
    partIndex: record.partIndex,
    start: record.start,
    end: record.end,
  }));
}

/**
 * Once-ids latched by `once()`-gated reminders folded into this user message.
 * Persisted so a fresh engine re-reads them (the durable suppression record for
 * user-target `once()`, mirroring synthetic reminder messages).
 */
export function getReminderOnceIds(message: UIMessage): string[] {
  const meta = message.metadata;
  if (!isRecord(meta) || !Array.isArray(meta.onceIds)) return [];
  return meta.onceIds.filter((id): id is string => typeof id === 'string');
}

function getReminderMetadataRecords(
  metadata: Record<string, unknown> | undefined,
): ReminderMetadataRecord[] {
  const reminders = metadata?.reminders;
  if (!Array.isArray(reminders)) return [];
  return reminders.filter(
    (item): item is ReminderMetadataRecord =>
      isRecord(item) &&
      typeof item.partIndex === 'number' &&
      typeof item.start === 'number' &&
      typeof item.end === 'number',
  );
}

function normalizeReminderTarget(target: unknown): ReminderTarget {
  if (target === undefined || target === 'user') return 'user';
  if (target === 'tool-output') return 'tool-output';
  if (target === 'steer') return 'steer';
  throw new Error(`Unsupported reminder target: ${String(target)}`);
}

function normalizeConditionalReminderText(
  textOrFragment: ReminderText | ContextFragment,
): ReminderText {
  return isFragment(textOrFragment)
    ? new XmlRenderer().render([textOrFragment])
    : textOrFragment;
}

export function stripTextByRanges(
  text: string,
  ranges: Array<{ start: number; end: number }>,
): string {
  if (ranges.length === 0) {
    return text;
  }

  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  if (normalized.length === 0) {
    return text;
  }

  let cursor = 0;
  let output = '';

  for (const range of normalized) {
    if (range.start < cursor) {
      if (range.end > cursor) {
        cursor = range.end;
      }
      continue;
    }

    output += text.slice(cursor, range.start);
    cursor = range.end;
  }

  output += text.slice(cursor);
  return output.trimEnd();
}

/**
 * Strip reminder content from a message using reminder metadata ranges.
 *
 * - Inline reminders are removed from text parts.
 * - Part reminders are removed as whole parts when their full text is stripped.
 * - `metadata.reminders` is removed from the returned message.
 */
export function stripReminders(message: UIMessage): UIMessage {
  if (isSyntheticReminderMessage(message)) {
    return stripSyntheticReminderMessage(message);
  }

  const reminderRecords = getReminderMetadataRecords(
    isRecord(message.metadata) ? message.metadata : undefined,
  );
  const rangesByPartIndex = new Map<
    number,
    Array<{ start: number; end: number }>
  >();

  for (const range of reminderRecords) {
    const partRanges = rangesByPartIndex.get(range.partIndex) ?? [];
    partRanges.push({ start: range.start, end: range.end });
    rangesByPartIndex.set(range.partIndex, partRanges);
  }

  const strippedParts = message.parts.flatMap((part, partIndex) => {
    const clonedPart = { ...part };

    const ranges = rangesByPartIndex.get(partIndex);

    if (clonedPart.type !== 'text' || ranges === undefined) {
      return [clonedPart];
    }

    const strippedText = stripTextByRanges(clonedPart.text, ranges);
    if (strippedText.length === 0) {
      return [];
    }

    return [{ ...clonedPart, text: strippedText }];
  });

  const nextMessage: UIMessage = {
    ...message,
    parts: strippedParts,
  };

  if (isRecord(message.metadata)) {
    const metadata = { ...message.metadata };
    delete metadata.reminders;

    if (Object.keys(metadata).length > 0) {
      nextMessage.metadata = metadata;
    } else {
      delete nextMessage.metadata;
    }
  }

  return nextMessage;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertReminderText(text: string) {
  if (text.trim().length === 0) {
    throw new Error('Reminder text must not be empty');
  }
}

function formatTaggedReminder(text: string): string {
  return `${SYSTEM_REMINDER_OPEN_TAG}${text}${SYSTEM_REMINDER_CLOSE_TAG}`;
}

function findLastTextPartIndex(message: UIMessage): number | undefined {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    if (message.parts[i].type === 'text') {
      return i;
    }
  }

  return undefined;
}

function ensureTextPart(message: UIMessage): number {
  const existingIndex = findLastTextPartIndex(message);
  if (existingIndex !== undefined) {
    return existingIndex;
  }

  const reminderPart: UIMessage['parts'][number] = {
    type: 'text',
    text: '',
  };
  message.parts.push(reminderPart);
  return message.parts.length - 1;
}

export function applyInlineReminder(
  message: UIMessage,
  value: string,
): UserReminderMetadata {
  const partIndex = ensureTextPart(message);
  const textPart = message.parts[partIndex];
  if (textPart.type !== 'text') {
    throw new Error('Failed to resolve text part for inline reminder');
  }

  const reminderText = formatTaggedReminder(value);
  const start = textPart.text.length;
  const updatedText = `${textPart.text}${reminderText}`;
  message.parts[partIndex] = { ...textPart, text: updatedText };

  return {
    id: generateId(),
    text: value,
    target: 'user',
    partIndex,
    start,
    end: start + reminderText.length,
    mode: 'inline',
  };
}

export function applyPartReminder(
  message: UIMessage,
  value: string,
): UserReminderMetadata {
  const reminderText = formatTaggedReminder(value);
  const part: UIMessage['parts'][number] = { type: 'text', text: reminderText };
  message.parts.push(part);
  const partIndex = message.parts.length - 1;

  return {
    id: generateId(),
    text: value,
    target: 'user',
    partIndex,
    start: 0,
    end: reminderText.length,
    mode: 'part',
  };
}

function normalizeReminderResolution(
  value: string | ReminderResolution,
): ReminderResolution | null {
  if (typeof value === 'string') {
    return value.trim().length === 0 ? null : { text: value };
  }

  if (value.text.trim().length === 0) {
    return null;
  }

  return value;
}

export function resolveReminder(
  item: { text: SyncReminderText; metadata?: Record<string, unknown> },
  ctx: ReminderContext,
): ReminderResolution | null {
  const resolvedText =
    typeof item.text === 'function' ? item.text(ctx) : item.text;
  const resolved = normalizeReminderResolution(resolvedText);
  if (!resolved) {
    return null;
  }

  const metadata =
    item.metadata || resolved.metadata
      ? {
          ...(item.metadata ?? {}),
          ...(resolved.metadata ?? {}),
        }
      : undefined;

  return metadata ? { ...resolved, metadata } : resolved;
}

export async function resolveReminderAsync(
  item: { text: ReminderText; metadata?: Record<string, unknown> },
  ctx: ReminderContext,
): Promise<ReminderResolution | null> {
  const text = await (typeof item.text === 'function'
    ? item.text(ctx)
    : item.text);
  const resolved = normalizeReminderResolution(text);
  if (!resolved) return null;

  const metadata =
    item.metadata || resolved.metadata
      ? { ...(item.metadata ?? {}), ...(resolved.metadata ?? {}) }
      : undefined;

  return metadata ? { ...resolved, metadata } : resolved;
}

export function mergeMessageMetadata(
  message: UIMessage,
  addedMetadata: Record<string, unknown>,
): void {
  if (Object.keys(addedMetadata).length === 0) {
    return;
  }

  const metadata = isRecord(message.metadata) ? { ...message.metadata } : {};
  message.metadata = { ...metadata, ...addedMetadata };
}

export function applyReminderToMessage(
  message: UIMessage,
  item: {
    text: SyncReminderText;
    asPart: boolean;
    metadata?: Record<string, unknown>;
  },
  ctx: ReminderContext,
): UserReminderMetadata | null {
  const resolved = resolveReminder(item, ctx);
  if (!resolved) {
    return null;
  }
  if (resolved.metadata) {
    mergeMessageMetadata(message, resolved.metadata);
  }
  return item.asPart
    ? applyPartReminder(message, resolved.text)
    : applyInlineReminder(message, resolved.text);
}

export function mergeReminderMetadata(
  message: UIMessage,
  addedReminders: UserReminderMetadata[],
): void {
  if (addedReminders.length === 0) return;
  const metadata = isRecord(message.metadata) ? { ...message.metadata } : {};
  const existing = Array.isArray(metadata.reminders) ? metadata.reminders : [];
  metadata.reminders = [...existing, ...addedReminders];
  message.metadata = metadata;
}

/**
 * Create a reminder fragment, set on the engine via `engine.set()`. The engine
 * folds it into the model's view when its `when` fires: `user` reminders bake a
 * `<system-reminder>` into the last user message at save; `steer` injects mid-
 * loop; `tool-output` injects after a completed tool step. Text may be a string,
 * a `(ctx) => string` factory (self-gates by returning `''`), or a context
 * fragment.
 *
 * For `target: 'user'`, `when` is optional — omit it for an always-on
 * instruction, or pass `once(id)` for a one-time reminder. `steer` and
 * `tool-output` require a `when` trigger.
 *
 * @example
 * ```ts
 * engine.set(reminder('Keep responses concise'));                // user, always
 * engine.set(reminder('Welcome!', { when: once('welcome') }));   // user, one-time
 * engine.set(reminder('RECAP', { when: everyNTurns(3), target: 'steer' }));
 * ```
 */
export function reminder(
  textOrFragment: ReminderText | ContextFragment,
  options?: ReminderOptions,
): ContextFragment {
  const target = normalizeReminderTarget(options?.target);
  const asPart = target === 'user' ? (options?.asPart ?? false) : false;

  if (options?.when === undefined && target !== 'user') {
    throw new Error(`Reminder target "${target}" requires a when predicate`);
  }

  const text = normalizeConditionalReminderText(textOrFragment);
  if (typeof text === 'string') {
    assertReminderText(text);
  }

  return {
    name: 'reminder',
    data: null,
    metadata: {
      reminder: {
        text,
        when: options?.when ?? (() => true),
        asPart,
        target,
      } satisfies ConditionalReminder,
    },
  };
}

/**
 * Bake resolved user reminders into a message in place: append each as a
 * `<system-reminder>` (inline or as its own part) and record the ranges in
 * `metadata.reminders` so `stripReminders` can reverse it. The save fold is the
 * only caller — user reminders are declared on the engine, not on `user()`.
 */
export function applyUserRemindersToMessage(
  message: UIMessage,
  reminders: Array<{
    text: SyncReminderText;
    asPart: boolean;
    metadata?: Record<string, unknown>;
  }>,
): void {
  if (reminders.length === 0) return;
  const plainText = extractPlainText(message);
  const added: UserReminderMetadata[] = [];
  for (const item of reminders) {
    const meta = applyReminderToMessage(message, item, { content: plainText });
    if (meta) added.push(meta);
  }
  mergeReminderMetadata(message, added);
}

/**
 * Build a hidden synthetic user message injected between model steps.
 *
 * Multiple reminder texts that fire at the same step boundary are folded into a
 * single user message (one `<system-reminder>` text part each) so the model
 * never sees two consecutive user messages — which providers like Anthropic
 * reject. The `metadata.synthetic` marker lets the chain summary, title
 * generation, and `stripReminders` treat these as non-conversational.
 */
export function synthesizeReminderMessage(
  text: string | string[],
  firedAt: number,
  onceIds: string[] = [],
): UIMessage & { role: 'user' } {
  const texts = Array.isArray(text) ? text : [text];
  for (const value of texts) assertReminderText(value);
  return {
    id: generateId(),
    role: 'user',
    parts: texts.map((value) => ({
      type: 'text',
      text: formatTaggedReminder(value),
    })),
    metadata: {
      synthetic: {
        source: 'reminder',
        firedAt,
        ...(onceIds.length > 0 ? { onceIds } : {}),
      } satisfies SyntheticReminderMetadata,
    },
  };
}

export function isSyntheticReminderMessage(
  message: UIMessage,
): message is UIMessage & {
  metadata: { synthetic: SyntheticReminderMetadata };
} {
  const meta = message.metadata;
  if (!isRecord(meta)) return false;
  const synthetic = meta.synthetic;
  if (!isRecord(synthetic)) return false;
  return synthetic.source === 'reminder';
}

/**
 * A synthetic reminder message is entirely `<system-reminder>` payload, so
 * stripping reminders drops its text parts wholesale and clears the synthetic
 * marker — leaving nothing for title/strip consumers to leak.
 */
function stripSyntheticReminderMessage(message: UIMessage): UIMessage {
  const next: UIMessage = {
    ...message,
    parts: message.parts.filter((part) => part.type !== 'text'),
  };
  if (isRecord(message.metadata)) {
    const metadata = { ...message.metadata };
    delete metadata.synthetic;
    if (Object.keys(metadata).length > 0) {
      next.metadata = metadata;
    } else {
      delete next.metadata;
    }
  }
  return next;
}
