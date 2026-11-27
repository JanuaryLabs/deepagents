import type {
  ComposerPopupProps,
  ComposerRootProps,
  ComposerShortcutsProps,
} from '../lib/Composer.tsx';
import type { ComposerAttachmentsProps } from '../lib/ComposerAttachments.tsx';

export const rootWords = {
  editorAriaLabel: 'Rich prompt composer',
  submitFailedMessage: 'Could not send prompt',
} satisfies Partial<ComposerRootProps>;

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
  removeLabel: (placeholder) => `Remove ${placeholder}`,
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
