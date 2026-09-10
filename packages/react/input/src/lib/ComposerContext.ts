import type { Editor } from '@tiptap/react';
import { createContext, use } from 'react';

import type {
  ActivePopup,
  ComposerDropTransfer,
  ComposerRichLinkMetadata,
  ComposerState,
  ComposerSuggestion,
} from './ComposerTypes.ts';

export type ComposerAcceptSuggestionOptions = {
  index?: number;
};

export type ComposerActions = {
  acceptSuggestion: (options?: ComposerAcceptSuggestionOptions) => void;
  toggleSlashMenu: () => void;
  insertText: (text: string) => void;
  attachImageFiles: (files: Iterable<File>) => void;
  removeImageAttachment: (id: string) => void;
  addRemoteImage: (url: string) => void;
  handleDrop: (transfer: ComposerDropTransfer) => boolean;
  insertPaste: (content: string) => void;
  insertRichLink: (
    href: string,
    label?: string,
    metadata?: ComposerRichLinkMetadata,
  ) => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  toggleShortcuts: () => void;
  submit: () => void;
  reset: () => void;
};

type ComposerEditorMeta = {
  editor: Editor | null;
};

export type ComposerMeta = ComposerEditorMeta & {
  disabled: boolean;
  activePopup: ActivePopup | null;
  suggestions: ComposerSuggestion[];
};

export type ComposerContextApi = {
  state: ComposerState;
  actions: ComposerActions;
  meta: ComposerMeta;
};

export type ComposerContextValue = {
  state: ComposerState;
  disabled: boolean;
  commandTriggers: string[];
  activePopup: ActivePopup | null;
  suggestions: ComposerSuggestion[];
  attachedImages: ReadonlyMap<string, File>;
  actions: ComposerActions;
  meta: ComposerEditorMeta;
};

export const ComposerContext = createContext<ComposerContextValue | null>(null);

export function useComposerContext(componentName: string) {
  const context = use(ComposerContext);
  if (!context) {
    throw new Error(`${componentName} must be used inside Composer.Root.`);
  }
  return context;
}

export function useComposer(componentName = 'useComposer'): ComposerContextApi {
  const context = useComposerContext(componentName);
  return {
    state: context.state,
    actions: context.actions,
    meta: {
      ...context.meta,
      disabled: context.disabled,
      activePopup: context.activePopup,
      suggestions: context.suggestions,
    },
  };
}
