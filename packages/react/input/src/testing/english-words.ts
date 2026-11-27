import { createElement } from 'react';

import type {
  ComposerFooterProps,
  ComposerPopupProps,
  ComposerRootProps,
  ComposerShortcutsProps,
} from '../lib/Composer.tsx';
import type { ComposerAttachmentsProps } from '../lib/ComposerAttachments.tsx';
import type { ComposerAttachmentMedia } from '../lib/ComposerTypes.ts';

const mediaNames: Record<ComposerAttachmentMedia, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
};

export const rootWords = {
  editorAriaLabel: 'Rich prompt composer',
  submitFailedMessage: 'Could not send prompt',
  submitErrorMessage: (error) => error.message,
  unsupportedFileMessage: ({ name }) =>
    `Only image, video, or audio files can be attached: ${name ?? 'unnamed file'}`,
  unknownCommandMessage: ({ name }) => `Unrecognized command: /${name}`,
  attachmentLabel: ({ media, number }) => `[${mediaNames[media]} #${number}]`,
  pastedTextLabel: ({ chars }) => `[Pasted Content ${chars} chars]`,
  missingAttachmentMessage: ({ label }) =>
    `Attached image is no longer available: ${label}`,
} satisfies Partial<ComposerRootProps>;

export const expandedTextLimitMessage: NonNullable<
  ComposerRootProps['expandedTextLimit']
>['message'] = ({ chars, maxChars }) =>
  `Prompt is too long after expanding pasted content (${chars} chars; max ${maxChars} chars).`;

export const editorWords = {
  placeholder: 'Type a message or / for commands',
};

export const popupWords = {
  listboxLabel: 'Suggestions',
  noMatchesLabel: 'no matches',
  argsLabel: 'args',
} satisfies ComposerPopupProps;

export const attachmentsWords = {
  'aria-label': 'Attached files',
  removeLabel: (label) => `Remove ${label}`,
  removeIcon: createElement('svg', { 'aria-hidden': true }),
} satisfies ComposerAttachmentsProps;

export const attachFilesWords = { inputLabel: 'Attach media files' };

export const shortcutsWords = {
  heading: 'Keyboard shortcuts',
  closeLabel: 'close',
  groupTitles: { send: 'Send', edit: 'Edit', navigate: 'Navigate' },
  descriptions: {
    send: 'send or queue',
    newline: 'newline',
    killToEnd: 'kill to end',
    killToStart: 'kill to start',
    killWord: 'kill word',
    yank: 'yank',
    history: 'history',
    reverseSearch: 'reverse search',
    lineEnd: 'line end',
    wordMove: 'word move',
  },
} satisfies ComposerShortcutsProps;

export const footerWords = {
  draftHints: {
    send: 'send',
    queue: 'queue',
    newline: 'newline',
    history: 'history',
    lineEnd: 'line end',
    killToEnd: 'kill',
    killToStart: 'kill back',
    killWord: 'word kill',
    wordMove: 'word move',
    yank: 'yank',
  },
  popupHints: { insert: 'insert', dismiss: 'dismiss' },
  reverseSearchHints: {
    label: 'reverse-i-search:',
    previous: 'previous',
    next: 'next',
    accept: 'accept',
    cancel: 'cancel',
  },
} satisfies ComposerFooterProps;
