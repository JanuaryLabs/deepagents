import {
  Extension,
  type JSONContent,
  Mark,
  Node,
  mergeAttributes,
} from '@tiptap/core';
import Link from '@tiptap/extension-link';
import {
  type MarkType,
  type Node as ProseMirrorNode,
  Slice,
} from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import { tokenizePersistedPrompt } from '../../persisted-prompt.ts';
import {
  type ComposerPreparedPayload,
  createComposerState,
  createDraftFromPersistedText,
  decodeComposerTextLinkHref,
  nextWordEnd,
  previousWordStart,
} from '../ComposerCore.ts';
import { findSlashCommandByName } from '../ComposerSlashCommands.ts';
import {
  itemToken,
  startsWithTrigger,
  tokenScanPattern,
  triggerAlternation,
} from '../ComposerTriggers.ts';
import type {
  ComposerDropTransfer,
  ComposerInitialDraft,
  ComposerItemBinding,
  ComposerItemEntry,
  ComposerRemoteImage,
  ComposerRichLinkMetadata,
  ComposerState,
  ComposerTextElement,
  ComposerTriggerSets,
} from '../ComposerTypes.ts';

export type ComposerTiptapKillBuffer = {
  text: string;
  slice: ReturnType<Slice['toJSON']>;
};

type PopupKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
};

type SelectedPasteRange = {
  from: number;
  to: number;
  selectedAtomLabels?: string[];
  selectedText?: string;
};

export function createComposerTiptapExtensions(options: {
  getRemoteImageCount: () => number;
  getMentionTrigger: () => string;
}) {
  return [
    StarterKit.configure({
      link: false,
    }),
    Link.configure({
      autolink: true,
      linkOnPaste: false,
      openOnClick: false,
      HTMLAttributes: {
        'data-token': 'link',
      },
    }),
    ComposerSlashMark,
    ComposerMentionNode,
    ComposerAtomNode,
    createComposerClipboardExtension(options),
  ];
}

const TIPTAP_LARGE_PASTE_CHAR_THRESHOLD = 1000;

function stringAttribute(name: string, fallback: string | null) {
  return {
    default: fallback,
    parseHTML: (element: HTMLElement) => element.getAttribute(name) ?? fallback,
  };
}

const ComposerSlashMark = Mark.create({
  name: 'composerSlashCommand',
  inclusive: false,

  addAttributes() {
    return {
      value: { default: null },
      detail: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-slash-command]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-token': 'slash-command',
        'data-composer-slash-command': HTMLAttributes.value,
      }),
      0,
    ];
  },
});

const ComposerMentionNode = Node.create({
  name: 'composerMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: stringAttribute('id', null),
      trigger: stringAttribute('trigger', ''),
      value: stringAttribute('value', ''),
      label: stringAttribute('label', ''),
      detail: stringAttribute('detail', ''),
      persistsAs: stringAttribute('persistsAs', null),
      payload: {
        default: null,
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.payload === null || attributes.payload === undefined
            ? {}
            : { payload: JSON.stringify(attributes.payload) },
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute('payload');
          if (raw === null) {
            return null;
          }
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-mention]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label =
      node.attrs.label ||
      `${node.attrs.trigger ?? ''}${node.attrs.value ?? ''}`;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-token': 'mention',
        'data-composer-mention': node.attrs.value,
        'data-composer-mention-trigger': node.attrs.trigger,
      }),
      label,
    ];
  },

  renderText({ node }) {
    return (
      node.attrs.label || `${node.attrs.trigger ?? ''}${node.attrs.value ?? ''}`
    );
  },
});

const ComposerAtomNode = Node.create({
  name: 'composerAtom',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: 'paste' },
      label: { default: '' },
      detail: { default: '' },
      content: { default: '' },
      href: { default: '' },
      path: { default: '' },
      metadata: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-atom]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = String(node.attrs.kind ?? 'paste');
    const label = String(node.attrs.label ?? '');
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-token': kind,
        'data-composer-atom': kind,
        'data-composer-atom-detail': node.attrs.detail,
      }),
      label,
    ];
  },

  renderText({ node }) {
    return String(node.attrs.label ?? '');
  },
});

function createComposerClipboardExtension(options: {
  getRemoteImageCount: () => number;
  getMentionTrigger: () => string;
}) {
  return Extension.create({
    name: 'composerClipboard',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handlePaste(view, event) {
              const clipboard = event.clipboardData;
              if (!clipboard) {
                return false;
              }

              const imageFile = Array.from(clipboard.files).find((file) =>
                file.type.startsWith('image/'),
              );
              if (imageFile) {
                event.preventDefault();
                insertImageAtomInView(
                  view,
                  options.getRemoteImageCount(),
                  imageFile.name || 'pasted-image.png',
                );
                return true;
              }

              const fileItem = Array.from(clipboard.files).find(
                (file) => !file.type.startsWith('image/'),
              );
              if (fileItem) {
                event.preventDefault();
                insertFileMentionInView(
                  view,
                  fileItem.name || 'pasted-file',
                  options.getMentionTrigger(),
                );
                return true;
              }

              const pasted = normalizePastedText(
                firstUriListItem(clipboard.getData('text/uri-list')) ||
                  downloadUrlItem(clipboard.getData('DownloadURL')) ||
                  clipboard.getData('text/plain') ||
                  clipboard.getData('text'),
              );
              const trimmed = pasted.trim();
              if (!pasted) {
                return false;
              }

              const selectedTextRange = selectedTextPasteRange(view);
              if (selectedTextRange && isProbablyUrl(trimmed)) {
                event.preventDefault();
                const href = normalizeLinkHref(trimmed);
                const linkMark = view.state.schema.marks.link;
                if (!linkMark) {
                  return false;
                }
                return linkSelectedRangeInView(
                  view,
                  selectedTextRange,
                  href,
                  linkMark,
                );
              }

              if (isImagePath(trimmed) && !trimmed.includes('\n')) {
                event.preventDefault();
                insertImageAtomInView(
                  view,
                  options.getRemoteImageCount(),
                  trimmed,
                );
                return true;
              }

              if (isFileReference(trimmed) && !trimmed.includes('\n')) {
                event.preventDefault();
                insertFileMentionInView(
                  view,
                  trimmed,
                  options.getMentionTrigger(),
                );
                return true;
              }

              if (isProbablyUrl(trimmed) && !trimmed.includes('\n')) {
                event.preventDefault();
                return insertLinkTextInView(
                  view,
                  trimmed,
                  normalizeLinkHref(trimmed),
                );
              }

              if (
                selectedTextRange &&
                pasted &&
                !pasted.includes('\n') &&
                characterCount(pasted) <= TIPTAP_LARGE_PASTE_CHAR_THRESHOLD
              ) {
                event.preventDefault();
                insertPlainTextInView(view, pasted, selectedTextRange);
                return true;
              }

              if (characterCount(pasted) > TIPTAP_LARGE_PASTE_CHAR_THRESHOLD) {
                event.preventDefault();
                insertPasteAtomInView(view, pasted);
                return true;
              }

              return false;
            },
            handleDrop(view, event) {
              const transfer = event.dataTransfer;
              if (!transfer) {
                return false;
              }
              if (
                handleComposerDropInView(
                  view,
                  transfer,
                  options.getRemoteImageCount(),
                  options.getMentionTrigger(),
                )
              ) {
                event.preventDefault();
                return true;
              }
              return false;
            },
          },
        }),
      ];
    },
  });
}

export function handleComposerDropInView(
  view: EditorView,
  transfer: ComposerDropTransfer,
  remoteImageCount: number,
  mentionTrigger: string,
) {
  const imageFile = Array.from(transfer.files).find((file) =>
    file.type.startsWith('image/'),
  );
  if (imageFile) {
    insertImageAtomInView(
      view,
      remoteImageCount,
      imageFile.name || 'dropped-image.png',
    );
    return true;
  }
  const fileItem = Array.from(transfer.files).find(
    (file) => !file.type.startsWith('image/'),
  );
  if (fileItem) {
    insertFileMentionInView(
      view,
      fileItem.name || 'dropped-file',
      mentionTrigger,
    );
    return true;
  }
  const dropped = normalizePastedText(
    firstUriListItem(transfer.getData('text/uri-list')) ||
      downloadUrlItem(transfer.getData('DownloadURL')) ||
      transfer.getData('text/plain'),
  ).trim();
  if (!dropped) {
    return false;
  }
  if (isImagePath(dropped) && !dropped.includes('\n')) {
    insertImageAtomInView(view, remoteImageCount, dropped);
    return true;
  }
  if (isFileReference(dropped) && !dropped.includes('\n')) {
    insertFileMentionInView(view, dropped, mentionTrigger);
    return true;
  }
  if (isProbablyUrl(dropped) && !dropped.includes('\n')) {
    insertLinkTextInView(view, dropped, normalizeLinkHref(dropped));
    return true;
  }
  return false;
}

export function contentFromStateOrText({
  state,
  text,
  slashCommands,
  mentionCandidates,
  triggers,
}: {
  state?: ComposerInitialDraft;
  text?: string;
  slashCommands: ComposerItemEntry[];
  mentionCandidates: ComposerItemEntry[];
  triggers: ComposerTriggerSets;
}) {
  if (state) {
    return contentFromState(
      createComposerState({
        initialDraft: state,
        slashCommands,
        commandTriggers: triggers.commandTriggers,
        mentionCandidates,
      }),
      slashCommands,
      mentionCandidates,
      triggers,
    );
  }
  return contentFromPromptText(
    text ?? '',
    slashCommands,
    mentionCandidates,
    triggers,
  );
}

function contentFromState(
  state: Pick<
    ComposerState,
    'text' | 'elements' | 'mentionBindings' | 'localImages' | 'pendingPastes'
  >,
  slashCommands: ComposerItemEntry[],
  mentionCandidates: ComposerItemEntry[],
  triggers: ComposerTriggerSets,
): JSONContent {
  if (state.elements.length === 0) {
    return contentFromPromptText(
      state.text,
      slashCommands,
      mentionCandidates,
      triggers,
    );
  }
  const content: JSONContent[] = [];
  let cursor = 0;
  for (const element of sortElements(state.elements)) {
    if (element.range.start > cursor) {
      content.push(
        ...inlineContentFromText(
          state.text.slice(cursor, element.range.start),
          slashCommands,
          mentionCandidates,
          triggers.commandTriggers,
          triggers.mentionTriggers,
        ),
      );
    }
    const binding = state.mentionBindings.find(
      (item) =>
        item.id === element.id ||
        `${item.trigger}${item.value}` === element.label,
    );
    const localImage = state.localImages.find(
      (image) => image.placeholder === element.label,
    );
    const paste = state.pendingPastes.find(
      (item) => item.placeholder === element.label,
    );
    if (element.kind === 'mention' && binding) {
      content.push(
        mentionNodeContent(
          bindingToCandidate(binding, element, mentionCandidates),
        ),
      );
    } else if (element.kind === 'image' && localImage) {
      content.push(
        atomNodeContent({
          kind: 'image',
          label: localImage.placeholder,
          detail: localImage.path,
          path: localImage.path,
        }),
      );
    } else if (element.kind === 'paste' && paste) {
      content.push(
        atomNodeContent({
          kind: 'paste',
          label: paste.placeholder,
          detail: element.detail ?? `${characterCount(paste.content)} chars`,
          content: paste.content,
        }),
      );
    } else if (element.kind === 'rich-link') {
      content.push(
        atomNodeContent({
          kind: 'rich-link',
          label: element.label,
          detail: element.detail ?? '',
          href: element.detail ?? '',
          metadata: element.metadata,
        }),
      );
    } else if (element.kind === 'link') {
      content.push(textNode(element.label, [linkMark(element.detail ?? '')]));
    } else {
      content.push(
        ...inlineContentFromText(
          state.text.slice(element.range.start, element.range.end),
          slashCommands,
          mentionCandidates,
          triggers.commandTriggers,
          triggers.mentionTriggers,
        ),
      );
    }
    cursor = element.range.end;
  }
  if (cursor < state.text.length) {
    content.push(
      ...inlineContentFromText(
        state.text.slice(cursor),
        slashCommands,
        mentionCandidates,
        triggers.commandTriggers,
        triggers.mentionTriggers,
      ),
    );
  }
  return docFromInlineContent(content);
}

function contentFromPromptText(
  text: string,
  slashCommands: ComposerItemEntry[],
  mentionCandidates: ComposerItemEntry[],
  triggers: ComposerTriggerSets,
): JSONContent {
  const draft = createDraftFromPersistedText({
    text,
    slashCommands,
    commandTriggers: triggers.commandTriggers,
    mentionCandidates,
  });
  if ((draft.elements?.length ?? 0) > 0) {
    return contentFromState(
      createComposerState({
        initialDraft: draft,
        slashCommands,
        commandTriggers: triggers.commandTriggers,
        mentionCandidates,
      }),
      slashCommands,
      mentionCandidates,
      triggers,
    );
  }
  const lines = text.split('\n');
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: inlineContentFromText(
        line,
        slashCommands,
        mentionCandidates,
        triggers.commandTriggers,
        triggers.mentionTriggers,
      ),
    })),
  };
}

function inlineContentFromText(
  text: string,
  slashCommands: ComposerItemEntry[],
  mentionCandidates: ComposerItemEntry[],
  commandTriggers: string[],
  mentionTriggers: string[],
): JSONContent[] {
  return tokenizePersistedPrompt(text).flatMap((token) => {
    if (
      token.kind === 'inline-code' ||
      token.kind === 'code-block' ||
      token.kind === 'link' ||
      token.kind === 'skill-link'
    ) {
      return [textNode(token.source)];
    }
    return inlineContentFromPlainText(
      token.source,
      slashCommands,
      mentionCandidates,
      commandTriggers,
      mentionTriggers,
    );
  });
}

function inlineContentFromPlainText(
  text: string,
  slashCommands: ComposerItemEntry[],
  mentionCandidates: ComposerItemEntry[],
  commandTriggers: string[],
  mentionTriggers: string[],
): JSONContent[] {
  const nodes: JSONContent[] = [];
  const pattern = tokenScanPattern(commandTriggers, mentionTriggers);
  if (!pattern) {
    return [textNode(text)];
  }
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const token = match[0];
    const hasTokenBoundary = index === 0 || /\s/.test(text[index - 1] ?? '');
    if (!hasTokenBoundary) continue;
    if (index > cursor) {
      nodes.push(textNode(text.slice(cursor, index)));
    }
    if (startsWithTrigger(token, mentionTriggers)) {
      const candidate = mentionCandidates.find(
        (item) => itemToken(item) === token,
      );
      nodes.push(candidate ? mentionNodeContent(candidate) : textNode(token));
    } else {
      const command = findSlashCommandByName(
        token.replace(/^\//, ''),
        slashCommands,
      );
      nodes.push(
        command
          ? textNode(token, [
              {
                type: 'composerSlashCommand',
                attrs: {
                  value: command.value,
                  detail: command.detail,
                },
              },
            ])
          : textNode(token),
      );
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) {
    nodes.push(textNode(text.slice(cursor)));
  }
  return nodes;
}

export function serializeTiptapContent(
  content: JSONContent,
  remoteImages: ComposerRemoteImage[],
  slashCommands: ComposerItemEntry[],
  isTaskRunning: boolean,
  queueSubmissions: boolean,
  cursor: number,
): ComposerState {
  const serialized: {
    text: string;
    elements: ComposerTextElement[];
    mentionBindings: ComposerItemBinding[];
    localImages: ComposerState['localImages'];
    pendingPastes: ComposerState['pendingPastes'];
  } = {
    text: '',
    elements: [],
    mentionBindings: [],
    localImages: [],
    pendingPastes: [],
  };
  serializeNodeContent(content, serialized, slashCommands);
  const base = createComposerState({
    text: serialized.text,
    slashCommands,
    isTaskRunning,
    queueSubmissions,
  });
  return {
    ...base,
    cursor,
    elements: dedupeElements([...base.elements, ...serialized.elements]),
    mentionBindings: serialized.mentionBindings,
    localImages: serialized.localImages,
    remoteImages,
    pendingPastes: serialized.pendingPastes,
  };
}

function serializeNodeContent(
  node: JSONContent,
  output: {
    text: string;
    elements: ComposerTextElement[];
    mentionBindings: ComposerItemBinding[];
    localImages: ComposerState['localImages'];
    pendingPastes: ComposerState['pendingPastes'];
  },
  slashCommands: ComposerItemEntry[],
) {
  if (node.type === 'doc') {
    node.content?.forEach((child, index) => {
      if (index > 0 && output.text.length > 0) {
        output.text += '\n';
      }
      serializeNodeContent(child, output, slashCommands);
    });
    return;
  }
  if (node.type === 'paragraph') {
    node.content?.forEach((child) =>
      serializeNodeContent(child, output, slashCommands),
    );
    return;
  }
  if (node.type === 'hardBreak') {
    output.text += '\n';
    return;
  }
  if (node.type === 'text') {
    const label = node.text ?? '';
    const start = output.text.length;
    output.text += label;
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link' && mark.attrs?.href) {
        output.elements.push({
          id: stableId('link', label, start),
          kind: 'link',
          label,
          range: { start, end: start + label.length },
          detail: String(mark.attrs.href),
        });
      }
      if (mark.type === 'composerSlashCommand') {
        const command = findSlashCommandByName(
          label.replace(/^\//, ''),
          slashCommands,
        );
        if (!command) {
          continue;
        }
        output.elements.push({
          id: stableId('slash-command', label, start),
          kind: 'slash-command',
          label,
          range: { start, end: start + label.length },
          detail: command.detail,
        });
      }
    }
    return;
  }
  if (node.type === 'composerMention') {
    const label =
      String(node.attrs?.label ?? '') ||
      `${String(node.attrs?.trigger ?? '')}${String(node.attrs?.value ?? '')}`;
    const start = output.text.length;
    const id = String(node.attrs?.id ?? stableId('mention', label, start));
    output.text += label;
    output.elements.push({
      id,
      kind: 'mention',
      label,
      range: { start, end: start + label.length },
      detail: String(node.attrs?.detail ?? ''),
    });
    const persistsAs = node.attrs?.persistsAs;
    output.mentionBindings.push({
      id,
      trigger: String(node.attrs?.trigger ?? ''),
      value: String(node.attrs?.value ?? ''),
      payload: node.attrs?.payload,
      persistsAs: typeof persistsAs === 'string' ? persistsAs : undefined,
    });
    return;
  }
  if (node.type === 'composerAtom') {
    const label = String(node.attrs?.label ?? '');
    const kind = tokenKindFromAttr(node.attrs?.kind);
    const start = output.text.length;
    const id = stableId(kind, label, start);
    output.text += label;
    const metadata =
      kind === 'rich-link'
        ? richLinkMetadataFromAttr(node.attrs?.metadata)
        : undefined;
    output.elements.push({
      id,
      kind,
      label,
      range: { start, end: start + label.length },
      detail: String(
        node.attrs?.detail || node.attrs?.href || node.attrs?.path || '',
      ),
      ...(metadata ? { metadata } : {}),
    });
    if (kind === 'image') {
      output.localImages.push({
        id,
        placeholder: label,
        path: String(node.attrs?.path || node.attrs?.detail || ''),
      });
    }
    if (kind === 'paste') {
      output.pendingPastes.push({
        id,
        placeholder: label,
        content: String(node.attrs?.content ?? ''),
      });
    }
  }
}

function richLinkMetadataFromAttr(
  value: unknown,
): ComposerRichLinkMetadata | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const metadata: ComposerRichLinkMetadata = {};
  for (const key of [
    'title',
    'description',
    'siteName',
    'domain',
    'imageUrl',
    'faviconUrl',
  ] as const) {
    const item = Object.entries(value).find(
      ([candidateKey]) => candidateKey === key,
    )?.[1];
    if (typeof item === 'string' && item.length > 0) {
      metadata[key] = item;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function tokenKindFromAttr(value: unknown): ComposerTextElement['kind'] {
  switch (value) {
    case 'slash-command':
    case 'mention':
    case 'image':
    case 'paste':
    case 'link':
    case 'rich-link':
      return value;
    default:
      return 'paste';
  }
}

function docFromInlineContent(content: JSONContent[]) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content,
      },
    ],
  };
}

export function emptyDoc(): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  };
}

function textNode(
  text: string,
  marks?: NonNullable<JSONContent['marks']>,
): JSONContent {
  return marks && marks.length > 0
    ? { type: 'text', text, marks }
    : { type: 'text', text };
}

function linkMark(href: string) {
  return {
    type: 'link',
    attrs: {
      href,
    },
  };
}

export function mentionNodeContent(candidate: ComposerItemEntry): JSONContent {
  return {
    type: 'composerMention',
    attrs: {
      id: candidate.id,
      trigger: candidate.trigger,
      value: candidate.value,
      label: itemToken(candidate),
      detail: candidate.detail,
      payload: candidate.payload,
      persistsAs: candidate.persistsAs,
    },
  };
}

function bindingToCandidate(
  binding: ComposerItemBinding,
  element: ComposerTextElement,
  mentionCandidates: ComposerItemEntry[],
): ComposerItemEntry {
  const restoredText = `${binding.trigger}${binding.value}`;
  const catalogCandidate = mentionCandidates.find(
    (candidate) =>
      itemToken(candidate) === element.label ||
      itemToken(candidate) === restoredText,
  );
  if (catalogCandidate) {
    return catalogCandidate;
  }
  return {
    id: binding.id,
    trigger: binding.trigger,
    value: binding.value,
    label: binding.value,
    detail: '',
    atomic: true,
    payload: binding.payload,
  };
}

export function atomNodeContent({
  kind,
  label,
  detail = '',
  content = '',
  href = '',
  path = '',
  metadata,
}: {
  kind: 'image' | 'paste' | 'rich-link';
  label: string;
  detail?: string;
  content?: string;
  href?: string;
  path?: string;
  metadata?: ComposerRichLinkMetadata;
}): JSONContent {
  return {
    type: 'composerAtom',
    attrs: {
      kind,
      label,
      detail,
      content,
      href,
      path,
      metadata: metadata ?? null,
    },
  };
}

export function activeEditorToken(
  editor: Editor,
  triggers: ComposerTriggerSets,
) {
  const { selection } = editor.state;
  if (!selection.empty) {
    return null;
  }
  const $from = selection.$from;
  const textBefore = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    '\ufffc',
  );
  const textAfter = $from.parent.textBetween(
    $from.parentOffset,
    $from.parent.content.size,
    undefined,
    '\ufffc',
  );
  const allTriggers = [
    ...triggers.commandTriggers,
    ...triggers.mentionTriggers,
  ];
  if (allTriggers.length === 0) {
    return null;
  }
  const match = activeTokenFromText(textBefore, textAfter, allTriggers);
  if (!match) {
    return null;
  }
  const trigger = allTriggers.find((candidate) =>
    match.token.startsWith(candidate),
  );
  if (!trigger || match.token.slice(trigger.length).includes(trigger)) {
    return null;
  }
  return {
    trigger,
    query: match.token,
    from: selection.from - (textBefore.length - match.start),
    to: selection.from + match.tail.length,
  };
}

function activeTokenFromText(
  textBefore: string,
  textAfter: string,
  triggers: string[],
) {
  const sigilPattern = `(?:${triggerAlternation(triggers)})`;
  const start = textBefore.search(
    new RegExp(`(?:^|\\s|\\ufffc)(${sigilPattern}[^\\s\\ufffc]*)$`),
  );
  if (start === -1) {
    return null;
  }
  const tokenStart = /[\s\ufffc]/.test(textBefore[start] ?? '')
    ? start + 1
    : start;
  const tail = textAfter.match(/^[^\s\ufffc]*/)?.[0] ?? '';
  const token = textBefore.slice(tokenStart) + tail;
  return {
    start: tokenStart,
    token,
    tail,
  };
}

function insertPasteAtomInView(view: EditorView, content: string) {
  const placeholder = nextPastePlaceholderFromContent(
    view.state.doc.toJSON(),
    characterCount(content),
  );
  const node = view.state.schema.nodes.composerAtom?.create({
    kind: 'paste',
    label: placeholder,
    detail: `${characterCount(content)} chars`,
    content,
  });
  if (!node) {
    return;
  }
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
}

function selectedTextPasteRange(view: EditorView) {
  const selection = view.dom.ownerDocument.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    if (view.dom.contains(range.commonAncestorContainer)) {
      const from = view.posAtDOM(range.startContainer, range.startOffset);
      const to = view.posAtDOM(range.endContainer, range.endOffset);
      if (from !== to) {
        return {
          from: Math.min(from, to),
          to: Math.max(from, to),
          selectedAtomLabels: selectedComposerAtomLabels(range, view.dom),
          selectedText: selection.toString(),
        };
      }
    }
  }

  if (view.state.selection.empty) {
    return null;
  }
  return {
    from: view.state.selection.from,
    to: view.state.selection.to,
  };
}

function selectedComposerAtomLabels(range: Range, root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-composer-atom]'))
    .filter((element) => range.intersectsNode(element))
    .map((element) => element.textContent ?? '')
    .filter(Boolean);
}

function linkSelectedRangeInView(
  view: EditorView,
  range: SelectedPasteRange,
  href: string,
  linkMark: MarkType,
) {
  const expandedRange = expandSelectedRangeForAtomText(view.state.doc, range);
  const label = selectedPlainLinkLabel(
    view.state.doc,
    expandedRange.from,
    expandedRange.to,
  );
  const linkText = label || href;
  const textNode = view.state.schema.text(linkText, [
    linkMark.create({ href }),
  ]);
  const transaction = view.state.tr.replaceWith(
    expandedRange.from,
    expandedRange.to,
    textNode,
  );
  const cursor = expandedRange.from + linkText.length;
  view.dispatch(
    transaction
      .setSelection(TextSelection.create(transaction.doc, cursor))
      .scrollIntoView(),
  );
  return true;
}

function expandSelectedRangeForAtomText(
  doc: ProseMirrorNode,
  range: SelectedPasteRange,
) {
  if (!range.selectedText && !range.selectedAtomLabels?.length) {
    return range;
  }

  let expanded = { from: range.from, to: range.to };
  let changed = true;
  while (changed) {
    changed = false;
    doc.nodesBetween(0, doc.content.size, (node, position) => {
      if (node.type.name !== 'composerAtom') {
        return true;
      }
      const label = String(node.attrs.label ?? '');
      const selectedLabel =
        range.selectedText?.includes(label) ||
        range.selectedAtomLabels?.includes(label);
      if (!label || !selectedLabel) {
        return false;
      }
      const nodeRange = { from: position, to: position + node.nodeSize };
      const touchesSelection =
        nodeRange.from <= expanded.to + 1 && nodeRange.to >= expanded.from - 1;
      if (!touchesSelection) {
        return false;
      }
      const from = Math.min(expanded.from, nodeRange.from);
      const to = Math.max(expanded.to, nodeRange.to);
      if (from !== expanded.from || to !== expanded.to) {
        expanded = { from, to };
        changed = true;
      }
      return false;
    });
  }
  return expanded;
}

function selectedPlainLinkLabel(
  doc: ProseMirrorNode,
  from: number,
  to: number,
) {
  let label = '';
  doc.nodesBetween(from, to, (node, position) => {
    if (node.isText) {
      const text = node.text ?? '';
      const start = Math.max(from - position, 0);
      const end = Math.min(to - position, text.length);
      label += text.slice(start, end);
      return false;
    }
    if (node.type.name === 'composerMention') {
      label += String(node.attrs.label ?? '');
      return false;
    }
    if (node.type.name === 'composerAtom') {
      if (node.attrs.kind === 'rich-link') {
        label += String(node.attrs.label ?? '');
      }
      return false;
    }
    if (node.type.name === 'hardBreak') {
      label += '\n';
      return false;
    }
    return true;
  });
  return label.replace(/\n+/g, ' ').trim();
}

function insertLinkTextInView(view: EditorView, label: string, href: string) {
  const linkMark = view.state.schema.marks.link;
  if (!linkMark) {
    return false;
  }
  const { from, to } = view.state.selection;
  const tr = view.state.tr.insertText(label, from, to);
  tr.addMark(from, from + label.length, linkMark.create({ href }));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function insertPlainTextInView(
  view: EditorView,
  text: string,
  range: { from: number; to: number },
) {
  view.dispatch(
    view.state.tr
      .replaceWith(range.from, range.to, view.state.schema.text(text))
      .scrollIntoView(),
  );
}

function insertImageAtomInView(
  view: EditorView,
  remoteImageCount: number,
  path: string,
) {
  const localCount = countAtomKind(view.state.doc.toJSON(), 'image');
  const number = remoteImageCount + localCount + 1;
  const placeholder = `[Image #${number}]`;
  const node = view.state.schema.nodes.composerAtom?.create({
    kind: 'image',
    label: placeholder,
    detail: path,
    path,
  });
  if (!node) {
    return;
  }
  let transaction = view.state.tr.replaceSelectionWith(node);
  transaction = transaction.insertText(' ', transaction.selection.from);
  view.dispatch(transaction.scrollIntoView());
}

function insertFileMentionInView(
  view: EditorView,
  rawPath: string,
  trigger: string,
) {
  const path = normalizeFileReference(rawPath);
  const value = fileMentionLabel(path);
  const label = `${trigger}${value}`;
  const node = view.state.schema.nodes.composerMention?.create({
    id: stableId('mention', label, view.state.selection.from),
    trigger,
    value,
    label,
    detail: isDirectoryReference(path) ? 'directory' : 'file',
    payload: { path, type: isDirectoryReference(path) ? 'directory' : 'file' },
  });
  if (!node) {
    return;
  }
  let transaction = view.state.tr.replaceSelectionWith(node);
  transaction = transaction.insertText(' ', transaction.selection.from);
  view.dispatch(transaction.scrollIntoView());
}

export function renumberLocalImageAtoms(
  content: JSONContent,
  remoteCount: number,
) {
  let index = 0;
  return mapJsonContent(content, (node) => {
    if (node.type !== 'composerAtom' || node.attrs?.kind !== 'image') {
      return node;
    }
    index += 1;
    return {
      ...node,
      attrs: {
        ...node.attrs,
        label: `[Image #${remoteCount + index}]`,
      },
    };
  });
}

function mapJsonContent(
  node: JSONContent,
  mapNode: (node: JSONContent) => JSONContent,
): JSONContent {
  const mapped = mapNode(node);
  return {
    ...mapped,
    content: mapped.content?.map((child) => mapJsonContent(child, mapNode)),
  };
}

export function nextPastePlaceholderFromContent(
  content: JSONContent,
  charCount: number,
) {
  const base = `[Pasted Content ${charCount} chars]`;
  const existing = new Set<string>();
  walkJsonContent(content, (node) => {
    if (node.type === 'composerAtom' && node.attrs?.kind === 'paste') {
      existing.add(String(node.attrs.label ?? ''));
    }
  });
  if (!existing.has(base)) {
    return base;
  }
  let suffix = 2;
  while (existing.has(`${base} #${suffix}`)) {
    suffix += 1;
  }
  return `${base} #${suffix}`;
}

function countAtomKind(content: JSONContent, kind: string) {
  let count = 0;
  walkJsonContent(content, (node) => {
    if (node.type === 'composerAtom' && node.attrs?.kind === kind) {
      count += 1;
    }
  });
  return count;
}

function walkJsonContent(
  node: JSONContent,
  visit: (node: JSONContent) => void,
) {
  visit(node);
  node.content?.forEach((child) => walkJsonContent(child, visit));
}

export function killToLineEnd(editor: Editor): ComposerTiptapKillBuffer | null {
  const { selection } = editor.state;
  const from = selection.from;
  const to = selection.empty ? selection.$from.end() : selection.to;
  return killRange(editor, from, to);
}

export function killToLineStart(
  editor: Editor,
): ComposerTiptapKillBuffer | null {
  const { selection } = editor.state;
  const from = selection.empty
    ? visualLineStart(editor, selection.from)
    : selection.from;
  const to = selection.to;
  return killRange(editor, from, to);
}

export function deleteBackwardWord(
  editor: Editor,
): ComposerTiptapKillBuffer | null {
  const { selection } = editor.state;
  if (!selection.empty) {
    return killRange(editor, selection.from, selection.to);
  }
  const textBeforeCursor = selection.$from.parent.textBetween(
    0,
    selection.$from.parentOffset,
    undefined,
    tiptapLeafText,
  );
  const startOffset = previousWordStart(
    textBeforeCursor,
    textBeforeCursor.length,
  );
  const from = parentPositionAtTextOffset(
    selection.$from.parent,
    selection.$from.start(),
    startOffset,
  );
  return killRange(editor, from, selection.from);
}

export function moveCursorToLineEnd(editor: Editor) {
  const cursor = editor.state.selection.to;
  const lineEnd = visualLineEnd(editor, cursor);
  const transaction = editor.state.tr
    .setSelection(TextSelection.create(editor.state.doc, lineEnd))
    .scrollIntoView();
  editor.view.dispatch(transaction);
  editor.view.focus();
}

export function moveCursorByWord(editor: Editor, direction: -1 | 1) {
  const { selection } = editor.state;
  const anchor = direction === -1 ? selection.from : selection.to;
  const resolved = editor.state.doc.resolve(anchor);
  const parentText = resolved.parent.textBetween(
    0,
    resolved.parent.content.size,
    undefined,
    tiptapLeafText,
  );
  const cursorOffset = resolved.parent.textBetween(
    0,
    resolved.parentOffset,
    undefined,
    tiptapLeafText,
  ).length;
  const targetOffset =
    direction === -1
      ? previousWordStart(parentText, cursorOffset)
      : nextWordEnd(parentText, cursorOffset);
  const target = parentPositionAtTextOffset(
    resolved.parent,
    resolved.start(),
    targetOffset,
  );
  const transaction = editor.state.tr
    .setSelection(TextSelection.create(editor.state.doc, target))
    .scrollIntoView();
  editor.view.dispatch(transaction);
  editor.view.focus();
}

function visualLineStart(editor: Editor, cursor: number) {
  const { selection } = editor.state;
  let lineStart = selection.$from.start();
  editor.state.doc.nodesBetween(lineStart, cursor, (node, position) => {
    if (node.type.name === 'hardBreak') {
      lineStart = position + node.nodeSize;
    }
  });
  return lineStart;
}

function visualLineEnd(editor: Editor, cursor: number) {
  const resolved = editor.state.doc.resolve(cursor);
  let lineEnd = resolved.end();
  editor.state.doc.nodesBetween(cursor, lineEnd, (node, position) => {
    if (node.type.name === 'hardBreak' && position >= cursor) {
      lineEnd = position;
      return false;
    }
    return true;
  });
  return lineEnd;
}

function parentPositionAtTextOffset(
  parent: ProseMirrorNode,
  parentStart: number,
  targetOffset: number,
) {
  let offset = 0;
  let position = parentStart;
  for (let index = 0; index < parent.childCount; index += 1) {
    const node = parent.child(index);
    const text = inlineNodeTextForOffset(node);
    if (text === null) {
      position += node.nodeSize;
      continue;
    }
    const nextOffset = offset + text.length;
    if (targetOffset <= nextOffset) {
      if (node.isText) {
        return position + targetOffset - offset;
      }
      return targetOffset === nextOffset ? position + node.nodeSize : position;
    }
    offset = nextOffset;
    position += node.nodeSize;
  }
  return position;
}

function inlineNodeTextForOffset(node: ProseMirrorNode) {
  if (node.isText) {
    return node.text ?? '';
  }
  if (node.type.name === 'hardBreak') {
    return '\n';
  }
  if (
    node.type.name === 'composerMention' ||
    node.type.name === 'composerAtom'
  ) {
    return tiptapLeafText(node);
  }
  return null;
}

function killRange(
  editor: Editor,
  from: number,
  to: number,
): ComposerTiptapKillBuffer | null {
  if (to <= from) {
    return null;
  }
  const slice = editor.state.doc.slice(from, to);
  const killed = {
    text: editor.state.doc.textBetween(from, to, '\n', tiptapLeafText),
    slice: slice.toJSON(),
  };

  editor.chain().focus().deleteRange({ from, to }).run();
  return killed;
}

function tiptapLeafText(node: ProseMirrorNode) {
  if (node.type.name === 'composerMention') {
    return (
      String(node.attrs.label ?? '') ||
      `${String(node.attrs.trigger ?? '')}${String(node.attrs.value ?? '')}`
    );
  }
  if (node.type.name === 'composerAtom') {
    return String(node.attrs.label ?? '');
  }
  return '';
}

export function insertKilledContent(
  editor: Editor,
  killBuffer: ComposerTiptapKillBuffer | string,
) {
  const { selection } = editor.state;
  if (typeof killBuffer === 'string') {
    if (!selection.empty) {
      editor.chain().focus().deleteSelection().insertContent(killBuffer).run();
      return;
    }
    editor.chain().focus().insertContent(killBuffer).run();
    return;
  }
  const slice = Slice.fromJSON(editor.state.schema, killBuffer.slice);
  editor.view.dispatch(
    editor.state.tr.replaceSelection(slice).scrollIntoView(),
  );
  editor.view.focus();
}

export function deleteAtomAtSelectionEdge(
  editor: Editor,
  key: 'Backspace' | 'Delete',
) {
  const { selection } = editor.state;
  if (!selection.empty) {
    return false;
  }
  const edge = selection.$from;
  const node = key === 'Backspace' ? edge.nodeBefore : edge.nodeAfter;
  if (!node || !isComposerInlineAtom(node)) {
    return false;
  }
  const from =
    key === 'Backspace' ? selection.from - node.nodeSize : selection.from;
  const to =
    key === 'Backspace' ? selection.from : selection.from + node.nodeSize;
  editor.chain().focus().deleteRange({ from, to }).run();
  return true;
}

function isComposerInlineAtom(node: ProseMirrorNode) {
  return (
    node.isAtom &&
    (node.type.name === 'composerMention' || node.type.name === 'composerAtom')
  );
}

export function editorCursorOffset(editor: Editor) {
  try {
    return editor.state.doc.textBetween(
      0,
      editor.state.selection.from,
      '\n',
      '\ufffc',
    ).length;
  } catch {
    return 0;
  }
}

export function isEditorCursorAtStart(editor: Editor) {
  return editor.state.selection.empty && editorCursorOffset(editor) === 0;
}

export function queuedAction(
  prepared: NonNullable<ComposerPreparedPayload>,
  commandTriggers: string[],
) {
  if (startsWithTrigger(prepared.persistedPrompt, commandTriggers)) {
    return 'ParseSlash';
  }
  return prepared.action;
}

export function isPopupUpKey(event: PopupKeyEvent) {
  return (
    event.key === 'ArrowUp' ||
    ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p')
  );
}

export function isPopupDownKey(event: PopupKeyEvent) {
  return (
    event.key === 'ArrowDown' ||
    ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n')
  );
}

function sortElements(elements: ComposerTextElement[]) {
  return [...elements].sort((a, b) => a.range.start - b.range.start);
}

function dedupeElements(elements: ComposerTextElement[]) {
  const byRange = new Map<string, ComposerTextElement>();
  for (const element of elements) {
    byRange.set(
      `${element.kind}:${element.range.start}:${element.range.end}:${element.label}`,
      element,
    );
  }
  return sortElements([...byRange.values()]);
}

function normalizePastedText(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

export function characterCount(text: string) {
  return Array.from(text).length;
}

function isImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

function isFileReference(path: string) {
  return (
    path.startsWith('file://') ||
    path.startsWith('/') ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

function normalizeFileReference(path: string) {
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

function fileMentionLabel(path: string) {
  const normalized = path.replace(/[\\/]+$/, '');
  const label = normalized.split(/[\\/]/).filter(Boolean).pop();
  return label ? decodeURIComponent(label) : path;
}

function isDirectoryReference(path: string) {
  return /[\\/]$/.test(path);
}

function firstUriListItem(uriList: string) {
  return (
    uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) ?? ''
  );
}

function downloadUrlItem(downloadUrl: string) {
  const line = firstUriListItem(downloadUrl);
  if (!line) {
    return '';
  }
  const typedDownload = line.match(/^[\w.+-]+\/[\w.+-]+:[^:\n]+:(.+)$/);
  return typedDownload?.[1]?.trim() ?? line;
}

function isProbablyUrl(text: string) {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeLinkHref(text: string) {
  return decodeComposerTextLinkHref(text.trim());
}

export function wrapIndex(index: number, size: number) {
  return ((index % size) + size) % size;
}

export function stableId(kind: string, label: string, start: number) {
  return `${kind}:${start}:${label}`;
}
