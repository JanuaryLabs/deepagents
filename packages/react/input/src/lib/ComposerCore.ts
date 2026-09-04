import { escapeRegExp } from 'lodash-es';

import {
  serializePersistedPromptLink,
  tokenizePersistedPrompt,
} from '../persisted-prompt.ts';
import { findSlashCommandByName } from './ComposerSlashCommands.ts';
import {
  itemToken,
  startsWithTrigger,
  triggerAlternation,
} from './ComposerTriggers.ts';
import type {
  ComposerDraftSource,
  ComposerInitialDraft,
  ComposerItemBinding,
  ComposerItemEntry,
  ComposerPendingPaste,
  ComposerState,
  ComposerSubmission,
  ComposerSubmissionItem,
  ComposerTextElement,
  CreateComposerStateOptions,
  TokenKind,
} from './ComposerTypes.ts';

export function createComposerState({
  initialDraft,
  text = '',
  slashCommands = [],
  mentionCandidates = [],
  commandTriggers = [],
  remoteImageUrls = [],
  isTaskRunning = false,
  queueSubmissions = false,
}: CreateComposerStateOptions = {}): ComposerState {
  const draftText = initialDraft?.text ?? text;
  const mentionElements = mentionCandidates.flatMap((candidate) => {
    const element = elementForLabel(
      'mention',
      itemToken(candidate),
      draftText,
      {
        detail: candidate.detail,
      },
    );
    return element ? [element] : [];
  });
  const mentionBindings = mentionElements.flatMap((element) => {
    const candidate = mentionCandidates.find(
      (item) => itemToken(item) === element.label,
    );
    return candidate
      ? [
          {
            id: element.id,
            trigger: candidate.trigger,
            value: candidate.value,
            payload: candidate.payload,
            persistsAs: candidate.persistsAs,
          },
        ]
      : [];
  });
  const remoteImages =
    initialDraft?.remoteImages ??
    (initialDraft?.remoteImageUrls ?? remoteImageUrls).map((url, index) => ({
      id: stableId('remote-image', url, index),
      url,
    }));
  return {
    text: draftText,
    cursor: draftText.length,
    elements: sortElements(
      initialDraft?.elements ?? [
        ...completedSlashElements(draftText, slashCommands, commandTriggers),
        ...mentionElements,
      ],
    ),
    mentionBindings: initialDraft?.mentionBindings ?? mentionBindings,
    imageAttachments: [],
    remoteImages,
    pendingPastes: initialDraft?.pendingPastes ?? [],
    selectedRemoteImageId: null,
    isTaskRunning,
    queueSubmissions,
    error: null,
    reverseSearch: null,
    shortcutsOpen: false,
    history: [],
    historyCursor: null,
    killBuffer: '',
  };
}

export function isComposerDraftEmpty(state: ComposerState) {
  return (
    state.text.length === 0 &&
    state.imageAttachments.length === 0 &&
    state.remoteImages.length === 0 &&
    state.pendingPastes.length === 0
  );
}

export function prepareComposerPayload(
  state: ComposerState,
  slashCommands: ComposerItemEntry[],
  commandTriggers: string[],
) {
  return preparePayload(state, slashCommands, commandTriggers);
}

export type ComposerPreparedPayload = ReturnType<typeof prepareComposerPayload>;

export function expandedTextLimitError(
  prepared: NonNullable<ComposerPreparedPayload>,
  maxExpandedTextChars?: number,
) {
  if (!maxExpandedTextChars || maxExpandedTextChars < 1) {
    return null;
  }
  const expandedChars = characterCount(prepared.prompt);
  if (expandedChars <= maxExpandedTextChars) {
    return null;
  }
  return `Prompt is too long after expanding pasted content (${expandedChars} chars; max ${maxExpandedTextChars} chars).`;
}

function syncTextElements(
  state: ComposerState,
  slashCommands: ComposerItemEntry[],
  commandTriggers: string[],
): ComposerState {
  let elements = rebaseTextElements(state.elements, state.text);

  elements = [
    ...elements.filter((element) => element.kind !== 'slash-command'),
    ...completedSlashElements(state.text, slashCommands, commandTriggers),
  ];

  const mentionBindings = state.mentionBindings.filter((binding) =>
    elements.some((element) => element.id === binding.id),
  );
  const imageAttachments = state.imageAttachments.filter((image) =>
    elements.some(
      (element) =>
        element.kind === 'image' && element.label === image.placeholder,
    ),
  );
  const pendingPastes = state.pendingPastes.filter((paste) =>
    elements.some(
      (element) =>
        element.kind === 'paste' && element.label === paste.placeholder,
    ),
  );

  return {
    ...state,
    elements: sortElements(elements),
    mentionBindings,
    imageAttachments: renumberImageAttachments(
      imageAttachments,
      state.remoteImages.length,
    ),
    pendingPastes,
  };
}

function preparePayload(
  state: ComposerState,
  slashCommands: ComposerItemEntry[],
  commandTriggers: string[],
) {
  const displayText = state.text.trim();
  const displayElements = trimTextElements(
    state.text,
    displayText,
    state.elements,
  );
  const expanded = expandPendingPastesWithElements(
    state.text,
    state.elements,
    state.pendingPastes,
  );
  const expandedText = expanded.text;
  const trimmedText = expandedText.trim();
  const elements = trimTextElements(
    expandedText,
    trimmedText,
    expanded.elements,
  );
  const liveImageAttachments = state.imageAttachments.filter((image) =>
    state.text.includes(image.placeholder),
  );
  const persistableDisplay = withoutImageElements(displayText, displayElements);
  const persistedPrompt = createPersistedTextFromDraft({
    text: persistableDisplay.text,
    elements: persistableDisplay.elements,
    mentionBindings: state.mentionBindings,
  });
  const serializedPrompt = createPersistedTextFromDraft({
    text: trimmedText,
    elements,
    mentionBindings: state.mentionBindings,
  });

  if (
    !trimmedText &&
    liveImageAttachments.length === 0 &&
    state.remoteImages.length === 0
  ) {
    return null;
  }

  const slashCommand = startsWithTrigger(expandedText, commandTriggers)
    ? slashCommandPayload(trimmedText, elements, slashCommands, commandTriggers)
    : null;
  const customPrompt =
    slashCommand?.prompt === undefined
      ? null
      : slashCommand.args
        ? `${slashCommand.prompt}\n\n${createPersistedTextFromDraft({
            text: slashCommand.args,
            elements: slashCommand.argsElements,
            mentionBindings: state.mentionBindings,
          })}`
        : slashCommand.prompt;
  const customHistoryPrompt =
    slashCommand?.prompt === undefined
      ? null
      : slashCommand.args
        ? (() => {
            const args = withoutImageElements(
              slashCommand.args,
              slashCommand.argsElements,
            );
            return `${slashCommand.prompt}\n\n${createPersistedTextFromDraft({
              text: args.text,
              elements: args.elements,
              mentionBindings: state.mentionBindings,
            })}`;
          })()
        : slashCommand.prompt;
  const prompt = customPrompt ?? serializedPrompt;
  const mode: ComposerSubmission['mode'] =
    slashCommand?.args !== undefined
      ? 'command-with-args'
      : slashCommand
        ? 'command'
        : 'submitted';
  const items: ComposerSubmissionItem[] = [
    ...state.remoteImages.map((image) => ({
      type: 'remote_image' as const,
      url: image.url,
    })),
  ];

  if (!slashCommand && trimmedText) {
    items.push({
      type: 'text',
      text: trimmedText,
      textElements: elements,
    });
  }

  const mentionSearchText = slashCommand?.args ?? trimmedText;
  for (const binding of state.mentionBindings) {
    const token = `${binding.trigger}${binding.value}`;
    if (!token || !mentionSearchText.includes(token)) {
      continue;
    }
    items.push({
      type: 'item',
      id: binding.id,
      trigger: binding.trigger,
      value: binding.value,
      payload: binding.payload,
    });
  }

  for (const element of elements) {
    if (element.kind === 'link' && element.detail) {
      items.push({
        type: 'link',
        text: element.label,
        href: element.detail,
      });
    }
    if (element.kind === 'rich-link' && element.detail) {
      items.push({
        type: 'rich_link',
        text: element.label,
        href: element.detail,
        metadata: element.metadata,
      });
    }
  }

  return {
    mode,
    prompt,
    persistedPrompt,
    historyPrompt: customHistoryPrompt ?? persistedPrompt,
    action:
      slashCommand?.args !== undefined
        ? 'CommandWithArgs'
        : slashCommand
          ? 'Command'
          : 'Plain',
    command: slashCommand?.command,
    args: slashCommand?.args,
    items,
    elements: displayElements,
    payloadElements: elements,
    mentionBindings: state.mentionBindings,
  };
}

function completedSlashElements(
  text: string,
  slashCommands: ComposerItemEntry[],
  commandTriggers: string[],
): ComposerTextElement[] {
  const elements: ComposerTextElement[] = [];
  if (commandTriggers.length === 0) {
    return elements;
  }
  const matches = text.matchAll(
    new RegExp(
      `(^|\\s)((?:${triggerAlternation(commandTriggers)})([A-Za-z0-9_:-]+))(?=\\s|$)`,
      'g',
    ),
  );

  for (const match of matches) {
    const command = findSlashCommandByName(match[3], slashCommands);
    if (!command) {
      continue;
    }
    const label = match[2];
    const start = match.index + match[1].length;
    elements.push({
      id: stableId('slash-command', label, start),
      kind: 'slash-command',
      label,
      range: { start, end: start + label.length },
      detail: command.detail,
    });
  }

  return elements;
}

function slashCommandPayload(
  text: string,
  elements: ComposerTextElement[],
  slashCommands: ComposerItemEntry[],
  commandTriggers: string[],
) {
  const match = text.match(
    new RegExp(
      `^(?:${triggerAlternation(commandTriggers)})([A-Za-z0-9_:-]+)(?:\\s+([\\s\\S]+))?$`,
    ),
  );
  if (!match) {
    return null;
  }
  const command = findSlashCommandByName(match[1], slashCommands);
  if (!command) {
    return null;
  }
  const rest = match[2] ?? '';
  if (!rest.trim()) {
    return { command: command.value, prompt: command.expandsTo };
  }
  if (!command.supportsArgs) {
    return null;
  }
  const commandEnd = command.trigger.length + command.value.length;
  const restStart = text.slice(commandEnd).search(/\S/);
  const argsStart = restStart === -1 ? commandEnd : commandEnd + restStart;
  const args = rest.trim();
  return {
    command: command.value,
    prompt: command.expandsTo,
    args,
    argsElements: sliceTextElements(
      elements,
      argsStart,
      argsStart + args.length,
    ),
  };
}

export function unknownSlashCommand(
  text: string,
  slashCommands: ComposerItemEntry[],
  commandTriggers: string[],
) {
  if (commandTriggers.length === 0) {
    return null;
  }
  const match = text.match(
    new RegExp(
      `^(?:${triggerAlternation(commandTriggers)})([A-Za-z0-9_:-]+)(?:\\s+[\\s\\S]*)?$`,
    ),
  );
  if (!match) {
    return null;
  }
  const command = findSlashCommandByName(match[1], slashCommands);
  if (command || isKnownAbsolutePathRoot(match[1])) {
    return null;
  }
  return match[1];
}

const KNOWN_ABSOLUTE_PATH_ROOTS = new Set([
  'Applications',
  'Library',
  'System',
  'Users',
  'Volumes',
  'bin',
  'dev',
  'etc',
  'home',
  'mnt',
  'opt',
  'private',
  'sbin',
  'tmp',
  'usr',
  'var',
  'workspace',
]);

function isKnownAbsolutePathRoot(segment: string) {
  return KNOWN_ABSOLUTE_PATH_ROOTS.has(segment);
}

function expandPendingPastesWithElements(
  text: string,
  elements: ComposerTextElement[],
  pendingPastes: ComposerPendingPaste[],
) {
  if (pendingPastes.length === 0 || elements.length === 0) {
    return { text, elements };
  }

  const pendingByPlaceholder = new Map<string, string[]>();
  for (const paste of pendingPastes) {
    const queue = pendingByPlaceholder.get(paste.placeholder) ?? [];
    queue.push(paste.content);
    pendingByPlaceholder.set(paste.placeholder, queue);
  }

  let rebuiltText = '';
  const rebuiltElements: ComposerTextElement[] = [];
  let cursor = 0;
  for (const element of sortElements(elements)) {
    const start = Math.min(element.range.start, text.length);
    const end = Math.min(element.range.end, text.length);
    if (start > end) {
      continue;
    }
    if (start > cursor) {
      rebuiltText += text.slice(cursor, start);
    }
    const elementText = text.slice(start, end);
    const replacement = pendingByPlaceholder.get(element.label)?.shift();
    if (replacement !== undefined) {
      rebuiltText += replacement;
    } else {
      const nextStart = rebuiltText.length;
      rebuiltText += elementText;
      rebuiltElements.push({
        ...element,
        range: {
          start: nextStart,
          end: rebuiltText.length,
        },
      });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    rebuiltText += text.slice(cursor);
  }

  return { text: rebuiltText, elements: rebuiltElements };
}

function sliceTextElements(
  elements: ComposerTextElement[],
  start: number,
  end: number,
) {
  return elements
    .filter((element) => element.range.end > start && element.range.start < end)
    .map((element) => ({
      ...element,
      range: {
        start: Math.max(0, element.range.start - start),
        end: Math.min(end, element.range.end) - start,
      },
    }))
    .filter((element) => element.range.start < element.range.end);
}

function trimTextElements(
  originalText: string,
  trimmedText: string,
  elements: ComposerTextElement[],
) {
  const offset = originalText.indexOf(trimmedText);
  if (offset <= 0) {
    return elements;
  }
  return elements
    .filter((element) => element.range.end > offset)
    .map((element) => ({
      ...element,
      range: {
        start: Math.max(0, element.range.start - offset),
        end: Math.max(0, element.range.end - offset),
      },
    }));
}

function withoutImageElements(text: string, elements: ComposerTextElement[]) {
  const images = sortElements(
    elements.filter((element) => element.kind === 'image'),
  );
  for (const image of images.toReversed()) {
    text = replaceTextRange(text, image.range, '');
  }
  const removedBefore = (offset: number) =>
    images.reduce(
      (length, image) =>
        length +
        Math.max(0, Math.min(offset, image.range.end) - image.range.start),
      0,
    );
  return {
    text,
    elements: sortElements(
      elements.filter((element) => element.kind !== 'image'),
    ).map((element) => {
      return {
        ...element,
        range: {
          start: element.range.start - removedBefore(element.range.start),
          end: element.range.end - removedBefore(element.range.end),
        },
      };
    }),
  };
}

function rangesOverlap(
  start: number,
  end: number,
  otherStart: number,
  otherEnd: number,
) {
  return start < otherEnd && end > otherStart;
}

function replaceTextRange(
  text: string,
  range: { start: number; end: number },
  replacement: string,
) {
  return text.slice(0, range.start) + replacement + text.slice(range.end);
}

function rebaseTextElements(elements: ComposerTextElement[], text: string) {
  const claimedRanges = new Map<
    string,
    Array<{ start: number; end: number }>
  >();
  return sortElements(elements)
    .map((element) => {
      const candidates = matchingLabelRanges(text, element.label);
      if (candidates.length === 0) {
        return null;
      }

      const claimKey = `${element.kind}:${element.label}`;
      const claimedForKey = claimedRanges.get(claimKey) ?? [];
      const range =
        unclaimedExactRange(candidates, element, claimedForKey) ??
        nearestUnclaimedRange(candidates, element, claimedForKey) ??
        nearestRange(candidates, element);

      claimedRanges.set(claimKey, [...claimedForKey, range]);
      return {
        ...element,
        range,
      };
    })
    .filter((element): element is ComposerTextElement => Boolean(element));
}

function matchingLabelRanges(text: string, label: string) {
  if (!label) {
    return [];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let start = text.indexOf(label);
  while (start !== -1) {
    ranges.push({ start, end: start + label.length });
    start = text.indexOf(label, start + label.length);
  }
  return ranges;
}

function unclaimedExactRange(
  ranges: Array<{ start: number; end: number }>,
  element: ComposerTextElement,
  claimedRanges: Array<{ start: number; end: number }>,
) {
  return ranges.find(
    (range) =>
      range.start === element.range.start &&
      range.end === element.range.end &&
      !rangeWasClaimed(range, claimedRanges),
  );
}

function nearestUnclaimedRange(
  ranges: Array<{ start: number; end: number }>,
  element: ComposerTextElement,
  claimedRanges: Array<{ start: number; end: number }>,
) {
  return nearestRange(
    ranges.filter((range) => !rangeWasClaimed(range, claimedRanges)),
    element,
  );
}

function nearestRange(
  ranges: Array<{ start: number; end: number }>,
  element: ComposerTextElement,
) {
  return [...ranges].sort(
    (a, b) =>
      Math.abs(a.start - element.range.start) -
        Math.abs(b.start - element.range.start) || a.start - b.start,
  )[0];
}

function rangeWasClaimed(
  range: { start: number; end: number },
  claimedRanges: Array<{ start: number; end: number }>,
) {
  return claimedRanges.some(
    (claimed) =>
      range.start === claimed.start &&
      range.end === claimed.end &&
      rangesOverlap(range.start, range.end, claimed.start, claimed.end),
  );
}

function elementForLabel(
  kind: TokenKind,
  label: string,
  text: string,
  options: { detail?: string } = {},
) {
  const start = text.indexOf(label);
  if (start === -1) {
    return null;
  }
  return {
    id: stableId(kind, label, start),
    kind,
    label,
    range: { start, end: start + label.length },
    detail: options.detail,
  };
}

function sortElements(elements: ComposerTextElement[]) {
  return [...elements].sort((a, b) => a.range.start - b.range.start);
}

function renumberImageAttachments(
  images: ComposerState['imageAttachments'],
  remoteCount: number,
) {
  return images.map((image, index) => ({
    ...image,
    placeholder: `[Image #${remoteCount + index + 1}]`,
  }));
}

export function selectedRemoteImageIndex(
  state: ComposerState,
  selectedRemoteImageId: string | null,
) {
  if (!selectedRemoteImageId) {
    return null;
  }
  const index = state.remoteImages.findIndex(
    (image) => image.id === selectedRemoteImageId,
  );
  return index === -1 ? null : index;
}

export function characterCount(text: string) {
  return Array.from(text).length;
}

export function isFileReference(path: string) {
  return (
    path.startsWith('file://') ||
    path.startsWith('/') ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

export function normalizeFileReference(path: string) {
  const trimmed = path.trim();
  if (!trimmed.startsWith('file://')) {
    return trimmed;
  }
  try {
    return decodeURI(new URL(trimmed).pathname);
  } catch {
    return trimmed;
  }
}

export function fileMentionLabel(path: string) {
  const normalized = path.replace(/[\\/]+$/, '');
  const label = normalized.split(/[\\/]/).filter(Boolean).pop();
  return label ? decodeURIComponent(label) : path;
}

export function isDirectoryReference(path: string) {
  return /[\\/]$/.test(path);
}

export function firstUriListItem(uriList: string) {
  return (
    uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) ?? ''
  );
}

export function downloadUrlItem(downloadUrl: string) {
  const line = firstUriListItem(downloadUrl);
  if (!line) {
    return '';
  }
  return line.split(':').slice(2).join(':').trim();
}

export function createDraftFromState(
  state: ComposerState,
): ComposerInitialDraft {
  const draft = withoutImageElements(state.text, state.elements);
  return {
    text: draft.text,
    elements: cloneTextElements(draft.elements),
    mentionBindings: cloneMentionBindings(state.mentionBindings),
    remoteImages: state.remoteImages.map((image) => ({ ...image })),
    pendingPastes: clonePendingPastes(state.pendingPastes),
  };
}

export function createComposerDraftSource(
  state: ComposerState,
  persistedPrompt: string,
): ComposerDraftSource {
  return {
    persistedPrompt,
    remoteImages: state.remoteImages.map((image) => ({ ...image })),
    pendingPastes: clonePendingPastes(state.pendingPastes),
  };
}

export function pushComposerHistory(
  state: ComposerState,
  persistedPrompt: string,
) {
  const source = createComposerDraftSource(state, persistedPrompt);
  if (
    !source.persistedPrompt.trim() &&
    source.remoteImages.length === 0 &&
    source.pendingPastes.length === 0
  ) {
    return state.history;
  }
  return [source, ...state.history].slice(0, 8);
}

export function createDraftFromPersistedText({
  text,
  slashCommands = [],
  commandTriggers = [],
  mentionCandidates = [],
}: {
  text: string;
  slashCommands?: ComposerItemEntry[];
  commandTriggers?: string[];
  mentionCandidates?: ComposerItemEntry[];
}): ComposerInitialDraft {
  const decoded = decodePersistedPromptText(text, mentionCandidates);
  const direct = directPersistedTextElements(
    decoded.text,
    decoded.elements,
    decoded.protectedRanges,
    slashCommands,
    mentionCandidates,
  );
  const state = createComposerState({
    initialDraft: {
      text: decoded.text,
      elements: sortElements([...decoded.elements, ...direct.elements]),
      mentionBindings: [...decoded.mentionBindings, ...direct.mentionBindings],
    },
    slashCommands,
  });

  return createDraftFromState(
    syncTextElements(state, slashCommands, commandTriggers),
  );
}

export function createDraftFromSource({
  source,
  slashCommands = [],
  mentionCandidates = [],
}: {
  source: ComposerDraftSource;
  slashCommands?: ComposerItemEntry[];
  mentionCandidates?: ComposerItemEntry[];
}): ComposerInitialDraft {
  const draft = createDraftFromPersistedText({
    text: source.persistedPrompt,
    slashCommands,
    mentionCandidates,
  });
  const payloadElements = [
    ...source.pendingPastes.flatMap((paste) => {
      const element = elementForLabel(
        'paste',
        paste.placeholder,
        draft.text ?? '',
        {
          detail: `${characterCount(paste.content)} chars`,
        },
      );
      return element ? [element] : [];
    }),
  ];

  return {
    ...draft,
    elements: sortElements([...(draft.elements ?? []), ...payloadElements]),
    remoteImages: source.remoteImages.map((image) => ({ ...image })),
    pendingPastes: clonePendingPastes(source.pendingPastes),
  };
}

export function createPersistedTextFromDraft(draft: ComposerInitialDraft) {
  let text = draft.text ?? '';
  const replacements = sortElements(draft.elements ?? [])
    .map((element) => persistedTextReplacement(element, draft))
    .filter(
      (
        replacement,
      ): replacement is {
        range: ComposerTextElement['range'];
        text: string;
      } => Boolean(replacement),
    )
    .sort((left, right) => right.range.start - left.range.start);

  for (const replacement of replacements) {
    text = replaceTextRange(text, replacement.range, replacement.text);
  }

  return text;
}

export function decodeComposerTextLinkHref(href: string) {
  if (!href.startsWith('composer-text-link://')) {
    return href;
  }
  return decodeURIComponent(href.replace(/^composer-text-link:\/\//, ''));
}

function decodePersistedPromptText(
  text: string,
  mentionCandidates: ComposerItemEntry[],
) {
  const elements: ComposerTextElement[] = [];
  const mentionBindings: ComposerItemBinding[] = [];
  const protectedRanges: ComposerTextElement['range'][] = [];
  let decodedText = '';
  for (const token of tokenizePersistedPrompt(text)) {
    if (token.kind === 'inline-code' || token.kind === 'code-block') {
      const start = decodedText.length;
      decodedText += token.source;
      protectedRanges.push({ start, end: decodedText.length });
      continue;
    }
    if (
      token.kind !== 'link' &&
      token.kind !== 'skill-link' &&
      token.kind !== 'mention'
    ) {
      decodedText += token.source;
      continue;
    }

    const label = token.label;
    const rawHref = token.href;
    const href = decodeComposerTextLinkHref(rawHref);
    const mention = mentionCandidateFromPersistedLink(label, mentionCandidates);
    const displayLabel = mention ? itemToken(mention) : label;
    const rangeStart = decodedText.length;
    decodedText += displayLabel;

    if (mention) {
      const id = stableId('mention', displayLabel, rangeStart);
      elements.push({
        id,
        kind: 'mention',
        label: displayLabel,
        range: { start: rangeStart, end: rangeStart + displayLabel.length },
        detail: mention.detail,
      });
      mentionBindings.push({
        id,
        trigger: mention.trigger,
        value: mention.value,
        payload: mention.payload,
        persistsAs: mention.persistsAs,
      });
    } else {
      elements.push({
        id: stableId('link', displayLabel, rangeStart),
        kind: 'link',
        label: displayLabel,
        range: { start: rangeStart, end: rangeStart + displayLabel.length },
        detail: href,
      });
    }
  }

  return {
    text: decodedText,
    elements,
    mentionBindings,
    protectedRanges,
  };
}

function mentionCandidateFromPersistedLink(
  label: string,
  mentionCandidates: ComposerItemEntry[],
): ComposerItemEntry | null {
  return (
    mentionCandidates.find((candidate) => itemToken(candidate) === label) ??
    null
  );
}

function declaredTriggers(items: ComposerItemEntry[]) {
  return [...new Set(items.map((item) => item.trigger).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
}

function slashCommandScanPattern(slashCommands: ComposerItemEntry[]) {
  const triggers = declaredTriggers(slashCommands);
  if (triggers.length === 0) {
    return null;
  }
  return new RegExp(
    `(?:${triggers.map(escapeRegExp).join('|')})[A-Za-z0-9_:-]+`,
    'g',
  );
}

function commandTriggerLength(
  token: string,
  slashCommands: ComposerItemEntry[],
) {
  const trigger = declaredTriggers(slashCommands).find((candidate) =>
    token.startsWith(candidate),
  );
  return trigger?.length ?? 0;
}

function directPersistedTextElements(
  text: string,
  existingElements: ComposerTextElement[],
  protectedRanges: ComposerTextElement['range'][],
  slashCommands: ComposerItemEntry[],
  mentionCandidates: ComposerItemEntry[],
) {
  const elements: ComposerTextElement[] = [];
  const mentionBindings: ComposerItemBinding[] = [];
  const claimed: ComposerTextElement['range'][] = [];

  const isFreeRange = (start: number, token: string) => {
    const end = start + token.length;
    return (
      (start === 0 || /\s/.test(text[start - 1] ?? '')) &&
      !elementRangeIsClaimed(start, token, existingElements) &&
      !claimed.some((range) => start < range.end && end > range.start) &&
      !protectedRanges.some((range) => start < range.end && end > range.start)
    );
  };

  const longestTokenFirst = [...mentionCandidates].sort(
    (left, right) => itemToken(right).length - itemToken(left).length,
  );

  for (const candidate of longestTokenFirst) {
    const token = itemToken(candidate);
    if (!token) {
      continue;
    }
    for (
      let start = text.indexOf(token);
      start !== -1;
      start = text.indexOf(token, start + token.length)
    ) {
      const end = start + token.length;
      if (/[\w-]/.test(text[end] ?? '') || !isFreeRange(start, token)) {
        continue;
      }
      const id = stableId('mention', token, start);
      claimed.push({ start, end });
      elements.push({
        id,
        kind: 'mention',
        label: token,
        range: { start, end },
        detail: candidate.detail,
      });
      mentionBindings.push({
        id,
        trigger: candidate.trigger,
        value: candidate.value,
        payload: candidate.payload,
        persistsAs: candidate.persistsAs,
      });
    }
  }

  const commandPattern = slashCommandScanPattern(slashCommands);
  for (const match of commandPattern ? text.matchAll(commandPattern) : []) {
    const start = match.index ?? 0;
    const token = match[0];
    if (!isFreeRange(start, token)) {
      continue;
    }
    const command = findSlashCommandByName(
      token.slice(commandTriggerLength(token, slashCommands)),
      slashCommands,
    );
    if (!command) {
      continue;
    }
    claimed.push({ start, end: start + token.length });
    elements.push({
      id: stableId('slash-command', token, start),
      kind: 'slash-command',
      label: token,
      range: { start, end: start + token.length },
      detail: command.detail,
    });
  }

  return {
    elements,
    mentionBindings,
  };
}

function elementRangeIsClaimed(
  start: number,
  token: string,
  elements: ComposerTextElement[],
) {
  const end = start + token.length;
  return elements.some(
    (element) => start < element.range.end && end > element.range.start,
  );
}

function persistedTextReplacement(
  element: ComposerTextElement,
  draft: ComposerInitialDraft,
) {
  if (element.kind === 'mention') {
    const binding = (draft.mentionBindings ?? []).find(
      (item) =>
        item.id === element.id ||
        `${item.trigger}${item.value}` === element.label,
    );
    if (!binding) {
      return null;
    }
    return {
      range: element.range,
      text: binding.persistsAs ?? element.label,
    };
  }

  if (
    (element.kind === 'link' || element.kind === 'rich-link') &&
    element.detail
  ) {
    return {
      range: element.range,
      text: serializePersistedPromptLink(element.label, element.detail),
    };
  }

  return null;
}

function cloneTextElements(elements: ComposerTextElement[]) {
  return elements.map((element) => {
    const cloned = {
      ...element,
      range: { ...element.range },
    };
    if (!element.metadata) {
      return cloned;
    }
    return {
      ...cloned,
      metadata: { ...element.metadata },
    };
  });
}

function cloneMentionBindings(bindings: ComposerItemBinding[]) {
  return bindings.map((binding) => ({ ...binding }));
}

function clonePendingPastes(pastes: ComposerPendingPaste[]) {
  return pastes.map((paste) => ({ ...paste }));
}

export function findHistorySearchMatch(
  history: ComposerDraftSource[],
  query: string,
  currentIndex: number | null,
  direction: -1 | 1 = 1,
) {
  if (query.length === 0) {
    return null;
  }
  const normalizedQuery = query.toLowerCase();
  const matches = history
    .map((entry, index) => ({ index, entry }))
    .filter((match) =>
      match.entry.persistedPrompt.toLowerCase().includes(normalizedQuery),
    );
  if (matches.length === 0) {
    return null;
  }
  if (currentIndex === null) {
    return matches[0];
  }
  const currentMatchIndex = matches.findIndex(
    (match) => match.index === currentIndex,
  );
  if (currentMatchIndex === -1) {
    return matches[0];
  }
  return matches[wrapIndex(currentMatchIndex + direction, matches.length)];
}

export function shouldNavigateHistory(
  text: string,
  cursor: number,
  direction: -1 | 1,
) {
  if (direction === -1) {
    return cursor === 0 || !text.slice(0, cursor).includes('\n');
  }
  return cursor === text.length || !text.slice(cursor).includes('\n');
}

export function previousWordStart(text: string, cursor: number) {
  let index = clampToCodePointBoundary(text, cursor);
  while (index > 0 && isWhitespace(charBefore(text, index))) {
    index = previousCodePointStart(text, index);
  }
  if (index === 0) {
    return 0;
  }

  const mode = wordPieceMode(charBefore(text, index));
  if (mode === 'cjk') {
    return previousCodePointStart(text, index);
  }
  while (index > 0) {
    const previous = charBefore(text, index);
    if (wordPieceMode(previous) !== mode) {
      break;
    }
    index = previousCodePointStart(text, index);
  }
  return index;
}

export function nextWordEnd(text: string, cursor: number) {
  let index = clampToCodePointBoundary(text, cursor);
  while (index < text.length && isWhitespace(charAt(text, index))) {
    index = nextCodePointEnd(text, index);
  }
  if (index >= text.length) {
    return text.length;
  }

  const mode = wordPieceMode(charAt(text, index));
  if (mode === 'cjk') {
    return nextCodePointEnd(text, index);
  }
  while (index < text.length) {
    const current = charAt(text, index);
    if (wordPieceMode(current) !== mode) {
      break;
    }
    index = nextCodePointEnd(text, index);
  }
  return index;
}

export function wrapIndex(index: number, size: number) {
  return ((index % size) + size) % size;
}

export function stableId(kind: string, label: string, start: number) {
  return `${kind}:${start}:${label}`;
}

function clampToCodePointBoundary(text: string, cursor: number) {
  let index = Math.max(0, Math.min(cursor, text.length));
  if (
    index > 0 &&
    index < text.length &&
    isLowSurrogate(text.charCodeAt(index))
  ) {
    index -= 1;
  }
  return index;
}

function previousCodePointStart(text: string, cursor: number) {
  const index = cursor - 1;
  if (index > 0 && isLowSurrogate(text.charCodeAt(index))) {
    return index - 1;
  }
  return Math.max(index, 0);
}

function nextCodePointEnd(text: string, cursor: number) {
  const index = cursor + (isHighSurrogate(text.charCodeAt(cursor)) ? 2 : 1);
  return Math.min(index, text.length);
}

function charBefore(text: string, cursor: number) {
  const start = previousCodePointStart(text, cursor);
  return text.slice(start, cursor);
}

function charAt(text: string, cursor: number) {
  return text.slice(cursor, nextCodePointEnd(text, cursor));
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}

function isWhitespace(value: string) {
  return /\s/u.test(value);
}

function isWordChar(value: string) {
  return !isCjkChar(value) && /[\p{Letter}\p{Number}_]/u.test(value);
}

function isCjkChar(value: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    value,
  );
}

function wordPieceMode(value: string) {
  if (isCjkChar(value)) {
    return 'cjk';
  }
  return isWordChar(value) ? 'word' : 'separator';
}
