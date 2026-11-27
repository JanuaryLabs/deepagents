export * from './index.ts';
export { Composer } from './lib/Composer.tsx';
export { useComposer } from './lib/ComposerContext.ts';
export type {
  ComposerAcceptSuggestionOptions,
  ComposerActions,
  ComposerContextApi,
  ComposerMeta,
} from './lib/ComposerContext.ts';
export type { ComposerAttachmentsProps } from './lib/ComposerAttachments.tsx';
export { useComposerDictation } from './lib/dictation/ComposerDictationContext.ts';
export type {
  ComposerDictation,
  ComposerDictationApi,
  ComposerDictationState,
  DictationEnd,
} from './lib/dictation/ComposerDictationContext.ts';
export type {
  ComposerCancelDictationProps,
  ComposerDictateProps,
} from './lib/dictation/ComposerDictationParts.tsx';
export {
  Dictation,
  useDictationContext,
  type DictationCancelProps,
  type DictationRootProps,
  type DictationToggleProps,
} from './lib/dictation/Dictation.tsx';
export { insertTranscript } from './lib/dictation/insertTranscript.ts';
export {
  useDictation,
  type DictationApi,
  type DictationOptions,
  type DictationState,
} from './lib/dictation/useDictation.ts';
export {
  DictationError,
  type DictationErrorCode,
} from './lib/dictation/DictationError.ts';
export { ComposerTokenText } from './lib/ComposerTokenText.tsx';
export { PersistedPromptText } from './lib/PersistedPromptText.tsx';
export { reconstructPersistedPromptSelection } from './lib/persisted-prompt-selection.ts';
export type {
  ComposerRootProps,
  ComposerAddRemoteImageProps,
  ComposerAttachFilesProps,
  ComposerContentProps,
  ComposerEditorProps,
  ComposerErrorProps,
  ComposerFooterProps,
  ComposerInsertPasteProps,
  ComposerInsertRichLinkProps,
  ComposerPopupProps,
  ComposerRemoteImagesProps,
  ComposerResetProps,
  ComposerShortcutsProps,
  ComposerSubmitProps,
  ComposerSubmitContext,
  ComposerToolbarProps,
} from './lib/Composer.tsx';
export {
  createComposerState,
  createComposerDraftSource,
  createDraftFromPersistedText,
  createDraftFromSource,
  createDraftFromState,
  createPersistedTextFromDraft,
  decodeComposerTextLinkHref,
  prepareComposerPayload,
  pushComposerHistory,
} from './lib/ComposerCore.ts';
export type { ComposerPreparedPayload } from './lib/ComposerCore.ts';
export { isVisibleInPhase } from './lib/ComposerVisibility.ts';
export type {
  ActivePopup,
  ComposerAttachmentLabel,
  ComposerDropTransfer,
  ComposerPastedTextLabel,
  ComposerVisibility,
  ComposerSubmissionItem,
  ComposerInitialDraft,
  ComposerDraftSource,
  ComposerItemBinding,
  ComposerMediaType,
  ComposerPendingPaste,
  ComposerRemoteImage,
  ComposerRichLinkMetadata,
  ComposerState,
  ComposerSubmission,
  ComposerSuggestion,
  ComposerPopupTrigger,
  ComposerTextElement,
  ComposerItemEntry,
  ComposerItem,
  ComposerTriggerSets,
  CreateComposerStateOptions,
} from './lib/ComposerTypes.ts';
export type {
  ComposerCommandProps,
  ComposerMentionProps,
  ComposerTriggerProps,
} from './lib/ComposerRegistry.tsx';
