import type { ReactNode } from 'react';

export type TokenKind =
  'slash-command' | 'mention' | 'image' | 'paste' | 'link' | 'rich-link';

export type ComposerPopupTrigger = string;

export type ActivePopup = {
  trigger: ComposerPopupTrigger;
  query: string;
  selectedIndex: number;
};

export type ComposerDropTransfer = Pick<DataTransfer, 'files' | 'getData'>;

export type ComposerTextElement = {
  id: string;
  kind: TokenKind;
  label: string;
  range: { start: number; end: number };
  detail?: string;
  metadata?: ComposerRichLinkMetadata;
};

export type ComposerRichLinkMetadata = {
  title?: string;
  description?: string;
  siteName?: string;
  domain?: string;
  imageUrl?: string;
  faviconUrl?: string;
};

export type ComposerItemBinding = {
  id: string;
  trigger: string;
  value: string;
  payload?: unknown;
  persistsAs?: string;
};

export type ComposerLocalImage = {
  id: string;
  placeholder: string;
  path: string;
};

export type ComposerPendingPaste = {
  id: string;
  placeholder: string;
  content: string;
};

export type ComposerRemoteImage = {
  id: string;
  url: string;
};

export type ComposerInitialDraft = {
  text?: string;
  elements?: ComposerTextElement[];
  mentionBindings?: ComposerItemBinding[];
  localImages?: ComposerLocalImage[];
  remoteImages?: ComposerRemoteImage[];
  remoteImageUrls?: string[];
  pendingPastes?: ComposerPendingPaste[];
};

export type ComposerDraftSource = {
  persistedPrompt: string;
  localImages: ComposerLocalImage[];
  remoteImages: ComposerRemoteImage[];
  pendingPastes: ComposerPendingPaste[];
};

export type ComposerState = {
  text: string;
  cursor: number;
  elements: ComposerTextElement[];
  mentionBindings: ComposerItemBinding[];
  localImages: ComposerLocalImage[];
  remoteImages: ComposerRemoteImage[];
  pendingPastes: ComposerPendingPaste[];
  selectedRemoteImageId: string | null;
  isTaskRunning: boolean;
  queueSubmissions: boolean;
  error: string | null;
  reverseSearch: string | null;
  shortcutsOpen: boolean;
  history: ComposerDraftSource[];
  historyCursor: number | null;
  killBuffer: string;
};

export type ComposerVisibility =
  'always' | 'hidden' | 'before-interaction' | 'after-interaction';

export type ComposerItem = {
  id: string;
  value: string;
  label: string;
  detail: string;
  atomic: boolean;
  icon?: ReactNode;
  payload?: unknown;
  expandsTo?: string;
  persistsAs?: string;
  supportsArgs?: boolean;
  aliases?: string[];
  searchTerms?: string[];
  visibility?: ComposerVisibility;
  availability?: 'enabled' | 'disabled';
};

export type ComposerItemEntry = ComposerItem & { trigger: string };

export type ComposerTriggerSets = {
  commandTriggers: string[];
  mentionTriggers: string[];
};

export type ComposerSuggestion = ComposerItemEntry;

export type ComposerSubmissionItem =
  | { type: 'text'; text: string; textElements: ComposerTextElement[] }
  | { type: 'local_image'; path: string; placeholder: string }
  | { type: 'remote_image'; url: string }
  | { type: 'link'; text: string; href: string }
  | {
      type: 'rich_link';
      text: string;
      href: string;
      metadata?: ComposerRichLinkMetadata;
    }
  | {
      type: 'item';
      id: string;
      trigger: string;
      value: string;
      payload?: unknown;
    };

export type ComposerSubmission = {
  id: string;
  at: string;
  mode: 'submitted' | 'queued' | 'command' | 'command-with-args';
  prompt: string;
  persistedPrompt: string;
  action?: string;
  command?: string;
  args?: string;
  items: ComposerSubmissionItem[];
};

export type CreateComposerStateOptions = {
  initialDraft?: ComposerInitialDraft;
  text?: string;
  slashCommands?: ComposerItemEntry[];
  mentionCandidates?: ComposerItemEntry[];
  commandTriggers?: string[];
  remoteImageUrls?: string[];
  isTaskRunning?: boolean;
  queueSubmissions?: boolean;
};
