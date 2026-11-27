import { Button } from '@base-ui/react/button';
import type { JSONContent } from '@tiptap/core';
import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import { useClock } from '@zukhruf/ui';
import { cn } from 'cn';
import {
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ComposerAttachments } from './ComposerAttachments.tsx';
import {
  type ComposerAcceptSuggestionOptions,
  ComposerContext,
  type ComposerContextValue,
  useComposerContext,
} from './ComposerContext.ts';
import {
  type ComposerPreparedPayload,
  attachmentMediaOf,
  attachmentPlaceholder,
  characterCount,
  composerFileDisposition,
  createComposerDraftSource,
  createDraftFromSource,
  createDraftFromState,
  findHistorySearchMatch,
  isComposerDraftEmpty,
  prepareComposerPayload,
  pushComposerHistory,
  selectedRemoteImageIndex,
  shouldNavigateHistory,
  stableId,
  unknownSlashCommand,
  wrapIndex,
} from './ComposerCore.ts';
import { readStoredDraft, writeStoredDraft } from './ComposerDraft.ts';
import {
  ComposerCommand,
  ComposerMention,
  ComposerTrigger,
  collectComposerRegistry,
  composerRegistrySignature,
} from './ComposerRegistry.tsx';
import { popupSuggestionMatches } from './ComposerSuggestions.ts';
import { itemToken } from './ComposerTriggers.ts';
import type {
  ActivePopup,
  ComposerAttachmentLabel,
  ComposerDraftSource,
  ComposerDropTransfer,
  ComposerInitialDraft,
  ComposerItemEntry,
  ComposerMediaType,
  ComposerPopupTrigger,
  ComposerRemoteImage,
  ComposerRichLinkMetadata,
  ComposerState,
  ComposerSubmission,
} from './ComposerTypes.ts';
import {
  type ComposerDictation,
  ComposerDictationContext,
} from './dictation/ComposerDictationContext.ts';
import {
  ComposerCancelDictation,
  ComposerDictate,
} from './dictation/ComposerDictationParts.tsx';
import { useComposerDictationController } from './dictation/useComposerDictationController.ts';
import {
  type ComposerAttachImageFile,
  type ComposerTiptapKillBuffer,
  activeEditorToken,
  atomNodeContent,
  contentFromStateOrText,
  createComposerTiptapExtensions,
  deleteAtomAtSelectionEdge,
  deleteBackwardWord,
  editorCursorOffset,
  emptyDoc,
  handleComposerDropInView,
  imageAttachmentNodeContent,
  insertKilledContent,
  isEditorCursorAtStart,
  isPopupDownKey,
  isPopupUpKey,
  killToLineEnd,
  killToLineStart,
  mentionNodeContent,
  moveCursorByWord,
  moveCursorToLineEnd,
  nextPastePlaceholderFromContent,
  queuedAction,
  removeImageAttachmentAtom,
  renumberImageAttachmentAtoms,
  serializeTiptapContent,
} from './tiptap/ComposerTiptapDomain.ts';

export type ComposerRootProps = {
  initialDraft?: ComposerInitialDraft;
  draftKey?: string;
  disabled?: boolean;
  isTaskRunning?: boolean;
  queueSubmissions?: boolean;
  hasInteracted?: boolean;
  /** Refuses a send whose prompt, its pasted content expanded, is longer than `maxChars`. */
  expandedTextLimit?: {
    maxChars: number;
    message: (counts: { chars: number; maxChars: number }) => string;
  };
  editorAriaLabel: string;
  /** Shown when `onSubmit` rejects with something other than an `Error`. */
  submitFailedMessage: string;
  /** Shown when `onSubmit` rejects with an `Error`, such as a failed upload; the host maps it to its words. */
  submitErrorMessage: (error: Error) => string;
  /**
   * The media types the file picker offers and that a picked, pasted or dropped file must have.
   * Without it, any image, video or audio file is attached and any other pasted or dropped file
   * becomes an `@name` mention, for a coding agent that reads files by path.
   */
  acceptedMediaTypes?: readonly ComposerMediaType[];
  /** Shown when a file is refused: outside `acceptedMediaTypes`, or not an image, video or audio file; `name` is undefined for a file without one. */
  unsupportedFileMessage: (file: { name: string | undefined }) => string;
  /** Shown when a sent prompt starts with a slash command that no trigger knows. */
  unknownCommandMessage: (command: { name: string }) => string;
  /** Shown when a sent prompt holds an attachment whose file is gone, such as one brought back by undo after its removal. */
  missingAttachmentMessage: (attachment: { placeholder: string }) => string;
  className?: string;
  children?: ReactNode;
  dictation?: ComposerDictation;
  validateSubmission?: (event: ComposerSubmission) => string | null;
  onSubmit?: (
    event: ComposerSubmission,
    context: ComposerSubmitContext,
  ) => void | Promise<unknown>;
  onStateChange?: (
    state: ComposerState,
    preparedPayload: ComposerPreparedPayload,
  ) => void;
};

export type ComposerSubmitContext = {
  editableSource: ComposerDraftSource;
};

export type ComposerContentProps = ComponentPropsWithoutRef<'div'>;

export type ComposerToolbarProps = ComponentPropsWithoutRef<'div'>;

export type ComposerRemoteImagesProps = ComponentPropsWithoutRef<'div'> & {
  /** Names each remote image in its row. */
  attachmentLabel: ComposerAttachmentLabel;
};

export type ComposerEditorProps = ComponentPropsWithoutRef<'div'> & {
  placeholder: string;
};

export type ComposerErrorProps = ComponentPropsWithoutRef<'div'>;

export type ComposerPopupProps = ComponentPropsWithoutRef<'div'> & {
  listboxLabel: string;
  noMatchesLabel: string;
  /** Marks a suggestion whose command takes arguments. */
  argsLabel: string;
};

type ComposerShortcutGroup = 'send' | 'edit' | 'navigate';

type ComposerShortcutAction =
  | 'send'
  | 'newline'
  | 'killToEnd'
  | 'killToStart'
  | 'killWord'
  | 'yank'
  | 'history'
  | 'reverseSearch'
  | 'lineEnd'
  | 'wordMove';

export type ComposerShortcutsProps = ComponentPropsWithoutRef<'div'> & {
  heading: string;
  closeLabel: string;
  groupTitles: Record<ComposerShortcutGroup, string>;
  descriptions: Record<ComposerShortcutAction, string>;
};

export type ComposerFooterProps = ComponentPropsWithoutRef<'div'> & {
  /** The hints while the prompt is being written. */
  draftHints: Record<
    | 'send'
    | 'queue'
    | 'newline'
    | 'history'
    | 'lineEnd'
    | 'killToEnd'
    | 'killToStart'
    | 'killWord'
    | 'wordMove'
    | 'yank',
    string
  >;
  /** The hints while a suggestion popup is open. */
  popupHints: Record<'insert' | 'dismiss', string>;
  /** The hints while a reverse history search is open; `label` leads its query. */
  reverseSearchHints: Record<
    'label' | 'previous' | 'next' | 'accept' | 'cancel',
    string
  >;
};

type ComposerActionTriggerProps = Button.Props;

export type ComposerAttachFilesProps = ComposerActionTriggerProps & {
  multiple?: boolean;
  /** The label of the hidden file input. */
  inputLabel: string;
};

export type ComposerAddRemoteImageProps = ComposerActionTriggerProps & {
  url: string;
};

export type ComposerInsertPasteProps = ComposerActionTriggerProps & {
  content: string;
};

export type ComposerInsertRichLinkProps = ComposerActionTriggerProps & {
  href: string;
  label?: string;
  metadata?: ComposerRichLinkMetadata;
};

export type ComposerSubmitProps = ComposerActionTriggerProps;

export type ComposerResetProps = ComposerActionTriggerProps;

type ComposerKeyboardEvent = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
};

function ComposerRoot(props: ComposerRootProps) {
  return <ComposerRootInner key={props.draftKey ?? ''} {...props} />;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function ComposerRootInner({
  initialDraft: providedInitialDraft,
  draftKey,
  disabled = false,
  isTaskRunning = false,
  queueSubmissions = false,
  hasInteracted = false,
  expandedTextLimit,
  editorAriaLabel,
  submitFailedMessage,
  submitErrorMessage,
  acceptedMediaTypes,
  unsupportedFileMessage,
  unknownCommandMessage,
  missingAttachmentMessage,
  className,
  children,
  dictation,
  validateSubmission,
  onSubmit,
  onStateChange,
}: ComposerRootProps) {
  const clock = useClock();
  const collectedRegistry = collectComposerRegistry(children);
  const registryRef = useRef({
    signature: composerRegistrySignature(collectedRegistry),
    slashCommands: collectedRegistry.slashCommands,
    mentionCandidates: collectedRegistry.mentionCandidates,
    commandTriggers: collectedRegistry.commandTriggers,
    mentionTriggers: collectedRegistry.mentionTriggers,
  });
  const registrySignature = composerRegistrySignature(collectedRegistry);
  if (registrySignature !== registryRef.current.signature) {
    registryRef.current = {
      signature: registrySignature,
      slashCommands: collectedRegistry.slashCommands,
      mentionCandidates: collectedRegistry.mentionCandidates,
      commandTriggers: collectedRegistry.commandTriggers,
      mentionTriggers: collectedRegistry.mentionTriggers,
    };
  }
  const { slashCommands, mentionCandidates, commandTriggers, mentionTriggers } =
    registryRef.current;
  const triggers = useMemo(
    () => ({ commandTriggers, mentionTriggers }),
    [commandTriggers, mentionTriggers],
  );
  const mentionTriggersRef = useRef(mentionTriggers);
  mentionTriggersRef.current = mentionTriggers;

  const [initialDraft] = useState(() => {
    if (providedInitialDraft) {
      return providedInitialDraft;
    }
    if (draftKey === undefined) {
      return undefined;
    }
    const source = readStoredDraft(draftKey);
    return source
      ? createDraftFromSource({ source, slashCommands, mentionCandidates })
      : undefined;
  });
  const initialRemoteImagesRef = useRef(initialDraft?.remoteImages ?? []);
  const initialContentRef = useRef(
    contentFromStateOrText({
      state: initialDraft,
      slashCommands,
      mentionCandidates,
      triggers,
    }),
  );
  const pendingSendsRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [remoteImages, setRemoteImages] = useState<ComposerRemoteImage[]>(
    initialRemoteImagesRef.current,
  );
  const [activePopup, setActivePopup] = useState<ActivePopup | null>(null);
  const [composer, setComposer] = useState<ComposerState>(() =>
    serializeTiptapContent(
      initialContentRef.current,
      initialRemoteImagesRef.current,
      slashCommands,
      isTaskRunning,
      queueSubmissions,
      0,
    ),
  );
  const composerRef = useRef(composer);
  const remoteImagesRef = useRef(remoteImages);
  const activePopupRef = useRef(activePopup);
  const richKillBufferRef = useRef<ComposerTiptapKillBuffer | null>(null);
  const pendingRemoteImageSelectionRef = useRef<string | null>(null);
  const pendingHistoryCursorRef = useRef<number | null | undefined>(undefined);
  const historyCursorRef = useRef<number | null>(null);
  const pendingHistoryDraftRef = useRef<ComposerInitialDraft | null>(null);
  const reverseSearchStartRef = useRef<ComposerState | null>(null);
  const reportStateChange = useEffectEvent(
    (state: ComposerState, prepared: ComposerPreparedPayload) => {
      onStateChange?.(state, prepared);
    },
  );
  const validateSubmissionRef = useRef(validateSubmission);
  const onSubmitRef = useRef(onSubmit);
  const attachedImagesRef = useRef(new Map<string, File>());
  const attachImageFileRef = useRef<ComposerAttachImageFile>(() => null);
  const acceptedMediaTypesRef = useRef(acceptedMediaTypes);
  acceptedMediaTypesRef.current = acceptedMediaTypes;

  const refreshFromEditorRef = useRef<(editor: Editor) => void>(
    () => undefined,
  );
  const syncPopupFromEditorRef = useRef<(editor: Editor) => void>(
    () => undefined,
  );
  const handleNativeEditorKeyDownRef = useRef<
    (event: KeyboardEvent) => boolean
  >(() => false);

  const [editorPlaceholder, setEditorPlaceholder] = useState('');
  const editorPlaceholderRef = useRef(editorPlaceholder);
  editorPlaceholderRef.current = editorPlaceholder;

  const editorExtensions = useMemo(
    () =>
      createComposerTiptapExtensions({
        getPlaceholder: () => editorPlaceholderRef.current,
        getMentionTrigger: () => mentionTriggersRef.current[0] ?? '@',
        getRemoteImageCount: () => remoteImagesRef.current.length,
        getAcceptedMediaTypes: () => acceptedMediaTypesRef.current,
        attachImageFile: (file) => attachImageFileRef.current(file),
      }),
    [],
  );

  const editor = useEditor({
    extensions: editorExtensions,
    content: initialContentRef.current,
    editable: !disabled,
    editorProps: {
      attributes: {
        'data-slot': 'composer-editor',
        role: 'textbox',
        'aria-label': editorAriaLabel,
        'aria-placeholder': editorPlaceholder,
        'aria-disabled': disabled ? 'true' : 'false',
        dir: 'auto',
        spellcheck: 'false',
      },
      handleKeyDown(_view, event) {
        return handleNativeEditorKeyDownRef.current(event);
      },
    },
    immediatelyRender: false,
    onUpdate({ editor }) {
      refreshFromEditorRef.current(editor);
      syncPopupFromEditorRef.current(editor);
    },
    onSelectionUpdate({ editor }) {
      refreshFromEditorRef.current(editor);
      syncPopupFromEditorRef.current(editor);
    },
  });

  const suggestions = useMemo(
    () =>
      activePopup
        ? popupSuggestionMatches(
            activePopup,
            slashCommands,
            mentionCandidates,
            hasInteracted,
          )
        : [],
    [activePopup, hasInteracted, mentionCandidates, slashCommands],
  );
  const preparedPayload = useMemo(
    () => prepareComposerPayload(composer, slashCommands, commandTriggers),
    [commandTriggers, composer, slashCommands],
  );

  useEffect(() => {
    composerRef.current = composer;
  }, [composer]);

  useEffect(() => {
    remoteImagesRef.current = remoteImages;
  }, [remoteImages]);

  useEffect(() => {
    activePopupRef.current = activePopup;
  }, [activePopup]);

  useEffect(() => {
    if (!composer.shortcutsOpen) {
      return;
    }
    if (
      activePopup ||
      composer.reverseSearch !== null ||
      !isComposerDraftEmpty(composer)
    ) {
      setComposer((current) =>
        current.shortcutsOpen
          ? {
              ...current,
              shortcutsOpen: false,
            }
          : current,
      );
    }
  }, [activePopup, composer]);

  useEffect(() => {
    validateSubmissionRef.current = validateSubmission;
  }, [validateSubmission]);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    editor.setEditable(!disabled);
    if (disabled) {
      setActivePopup(null);
    }
  }, [disabled, editor]);

  useEffect(() => {
    reportStateChange(composer, preparedPayload);
    if (draftKey === undefined) {
      return;
    }
    if (preparedPayload) {
      writeStoredDraft(
        draftKey,
        createComposerDraftSource(composer, preparedPayload.persistedPrompt),
      );
    } else if (pendingSendsRef.current === 0) {
      // Submit clears the editor before the send settles; keep the stored
      // draft until the outcome is known so a mid-flight reload loses nothing.
      writeStoredDraft(draftKey, null);
    }
  }, [composer, draftKey, preparedPayload]);

  useEffect(() => {
    setComposer((current) =>
      current.isTaskRunning === isTaskRunning &&
      current.queueSubmissions === queueSubmissions
        ? current
        : {
            ...current,
            isTaskRunning,
            queueSubmissions,
          },
    );
  }, [isTaskRunning, queueSubmissions]);

  refreshFromEditorRef.current = (currentEditor) => {
    if (disabled) {
      return;
    }
    const next = serializeTiptapContent(
      currentEditor.getJSON(),
      remoteImagesRef.current,
      slashCommands,
      isTaskRunning,
      queueSubmissions,
      editorCursorOffset(currentEditor),
    );
    const pendingSelectedRemoteImageId = pendingRemoteImageSelectionRef.current;
    const pendingHistoryCursor = pendingHistoryCursorRef.current;
    pendingRemoteImageSelectionRef.current = null;
    pendingHistoryCursorRef.current = undefined;
    setComposer((current) => {
      const nextHistoryCursor =
        pendingHistoryCursor !== undefined
          ? pendingHistoryCursor
          : historyCursorRef.current;
      historyCursorRef.current = nextHistoryCursor;
      const shortcutsOpen = current.shortcutsOpen && isComposerDraftEmpty(next);
      return {
        ...next,
        error: current.error,
        history: current.history,
        historyCursor: nextHistoryCursor,
        killBuffer: current.killBuffer,
        reverseSearch: current.reverseSearch,
        shortcutsOpen,
        selectedRemoteImageId: pendingSelectedRemoteImageId,
      };
    });
  };

  syncPopupFromEditorRef.current = (currentEditor) => {
    if (disabled) {
      setActivePopup(null);
      return;
    }
    const token = activeEditorToken(currentEditor, triggers);
    if (!token) {
      setActivePopup(null);
      return;
    }
    if (commandTriggers.includes(token.trigger)) {
      const popup = {
        trigger: token.trigger,
        query: token.query,
        selectedIndex: 0,
      };
      const matches = popupSuggestionMatches(
        popup,
        slashCommands,
        mentionCandidates,
        hasInteracted,
      );
      setActivePopup((current) =>
        matches.length === 0
          ? null
          : {
              ...popup,
              selectedIndex:
                current?.trigger === popup.trigger
                  ? Math.min(current.selectedIndex, matches.length - 1)
                  : 0,
            },
      );
      return;
    }

    setActivePopup((current) => {
      const trigger: ComposerPopupTrigger = token.trigger;
      const popup = {
        trigger,
        query: token.query,
        selectedIndex: current?.trigger === trigger ? current.selectedIndex : 0,
      };
      const matches = popupSuggestionMatches(
        popup,
        slashCommands,
        mentionCandidates,
        hasInteracted,
      );
      return {
        ...popup,
        selectedIndex:
          current?.trigger === trigger
            ? Math.min(current.selectedIndex, Math.max(matches.length - 1, 0))
            : 0,
      };
    });
  };

  function replaceEditorContent(content: JSONContent) {
    editor?.commands.setContent(content);
    if (editor) {
      refreshFromEditorRef.current(editor);
      syncPopupFromEditorRef.current(editor);
    }
  }

  function insertSlashCommand(command: ComposerItemEntry) {
    if (disabled || !editor) {
      return;
    }
    const token = activeEditorToken(editor, triggers);
    const replacement = [
      {
        type: 'text',
        text: `${command.trigger}${command.value}`,
        marks: [
          {
            type: 'composerSlashCommand',
            attrs: {
              value: command.value,
              detail: command.detail,
            },
          },
        ],
      },
      { type: 'text', text: ' ' },
    ];
    if (token && token.trigger === command.trigger) {
      editor
        .chain()
        .focus()
        .deleteRange({ from: token.from, to: token.to })
        .insertContent(replacement)
        .run();
    } else {
      editor.chain().focus().insertContent(replacement).run();
    }
    setActivePopup(null);
  }

  function acceptSuggestion({
    index = activePopupRef.current?.selectedIndex ?? 0,
  }: ComposerAcceptSuggestionOptions = {}) {
    const popup = activePopupRef.current;
    if (disabled || !editor || !popup) {
      return;
    }
    const matches = popupSuggestionMatches(
      popup,
      slashCommands,
      mentionCandidates,
      hasInteracted,
    );
    const suggestion = matches[index] ?? matches[0];
    if (!suggestion) {
      return;
    }
    if (!suggestion.atomic) {
      insertSlashCommand(suggestion);
      return;
    }

    const token = activeEditorToken(editor, triggers);
    const replacesActiveToken = token?.trigger === popup.trigger;
    const chain = editor.chain().focus();
    if (replacesActiveToken && token) {
      chain.deleteRange({ from: token.from, to: token.to });
    }
    chain
      .insertContent([
        mentionNodeContent(suggestion),
        { type: 'text', text: ' ' },
      ])
      .run();
    setActivePopup(null);
  }

  function toggleSlashMenu() {
    if (disabled || !editor) {
      return;
    }
    editor.commands.focus();
    const commandTrigger = commandTriggers[0];
    if (!commandTrigger) {
      return;
    }
    setActivePopup((current) =>
      current?.trigger === commandTrigger
        ? null
        : {
            trigger: commandTrigger,
            query: '',
            selectedIndex: 0,
          },
    );
  }

  function canOpenShortcuts(state: ComposerState) {
    return (
      isComposerDraftEmpty(state) &&
      state.reverseSearch === null &&
      activePopupRef.current === null
    );
  }

  function openShortcuts() {
    if (disabled) {
      return;
    }
    setComposer((state) =>
      canOpenShortcuts(state) && !state.shortcutsOpen
        ? {
            ...state,
            shortcutsOpen: true,
            selectedRemoteImageId: null,
            error: null,
          }
        : state,
    );
  }

  function closeShortcuts() {
    setComposer((state) =>
      state.shortcutsOpen
        ? {
            ...state,
            shortcutsOpen: false,
          }
        : state,
    );
  }

  function toggleShortcuts() {
    if (disabled) {
      return;
    }
    setComposer((state) => {
      if (state.shortcutsOpen) {
        return {
          ...state,
          shortcutsOpen: false,
        };
      }
      if (!canOpenShortcuts(state)) {
        return state;
      }
      return {
        ...state,
        shortcutsOpen: true,
        selectedRemoteImageId: null,
        error: null,
      };
    });
  }

  function insertText(text: string) {
    if (disabled || !editor || !text) {
      return;
    }
    editor.chain().focus().insertContent(text).run();
  }

  function attachImageFile(file: File) {
    if (composerFileDisposition(file, acceptedMediaTypes) !== 'attach') {
      setComposer((state) => ({
        ...state,
        error: unsupportedFileMessage({ name: file.name || undefined }),
        shortcutsOpen: false,
      }));
      setActivePopup(null);
      return null;
    }
    const id = crypto.randomUUID();
    attachedImagesRef.current.set(id, file);
    return id;
  }

  function insertImageAttachment(currentEditor: Editor, file: File) {
    const id = attachImageFile(file);
    if (id === null) {
      return;
    }
    const current = currentStateFromEditor();
    const number =
      current.remoteImages.length + current.imageAttachments.length + 1;
    const media = attachmentMediaOf(file) ?? 'image';
    currentEditor
      .chain()
      .focus()
      .insertContent([
        imageAttachmentNodeContent(
          id,
          attachmentPlaceholder(media, number),
          media,
        ),
        { type: 'text', text: ' ' },
      ])
      .run();
  }

  function attachImageFiles(files: Iterable<File>) {
    if (disabled || !editor) {
      return;
    }
    for (const file of files) {
      insertImageAttachment(editor, file);
    }
  }

  function removeImageAttachment(id: string) {
    if (disabled || !editor) {
      return;
    }
    attachedImagesRef.current.delete(id);
    replaceEditorContent(
      renumberImageAttachmentAtoms(
        removeImageAttachmentAtom(editor.getJSON(), id),
        remoteImagesRef.current.length,
      ),
    );
  }

  function addRemoteImage(url: string) {
    if (disabled || !editor) {
      return;
    }
    const nextRemoteImages = [
      ...remoteImagesRef.current,
      {
        id: stableId('remote-image', url, clock.Date.now()),
        url,
      },
    ];
    remoteImagesRef.current = nextRemoteImages;
    setRemoteImages(nextRemoteImages);
    replaceEditorContent(
      renumberImageAttachmentAtoms(editor.getJSON(), nextRemoteImages.length),
    );
  }

  function handleDrop(transfer: ComposerDropTransfer) {
    if (disabled || !editor) {
      return false;
    }
    return handleComposerDropInView(editor.view, transfer, {
      getRemoteImageCount: () => remoteImagesRef.current.length,
      getMentionTrigger: () => mentionTriggers[0] ?? '@',
      getAcceptedMediaTypes: () => acceptedMediaTypes,
      attachImageFile,
    });
  }

  function selectRemoteImageAt(index: number) {
    if (disabled) {
      return;
    }
    const image =
      remoteImagesRef.current[index] ?? composerRef.current.remoteImages[index];
    if (!image) {
      return;
    }
    pendingRemoteImageSelectionRef.current = image.id;
    setComposer((state) => ({
      ...state,
      selectedRemoteImageId: image.id,
      shortcutsOpen: false,
    }));
  }

  function clearRemoteImageSelection() {
    if (disabled) {
      return;
    }
    pendingRemoteImageSelectionRef.current = null;
    setComposer((state) =>
      state.selectedRemoteImageId
        ? {
            ...state,
            selectedRemoteImageId: null,
            shortcutsOpen: false,
          }
        : state,
    );
  }

  function clearRemoteImageSelectionForEditorIntent(
    event: ComposerKeyboardEvent,
  ) {
    if (!composerRef.current.selectedRemoteImageId) {
      return false;
    }
    if (
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight' ||
      event.key === 'Escape' ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a')
    ) {
      clearRemoteImageSelection();
      setActivePopup(null);
      return true;
    }
    if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      clearRemoteImageSelection();
      return true;
    }
    return false;
  }

  function handleRemoteImageKeyDown(event: ComposerKeyboardEvent) {
    if (disabled) {
      event.preventDefault();
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      clearRemoteImageSelection();
      setActivePopup(null);
      editor?.commands.selectAll();
      return true;
    }
    const current = currentStateFromEditor();
    const selectedRemoteImageId = composerRef.current.selectedRemoteImageId;
    if (!activePopupRef.current && event.key === 'ArrowUp') {
      const selectedIndex = selectedRemoteImageIndex(
        {
          ...current,
          selectedRemoteImageId,
        },
        selectedRemoteImageId,
      );
      if (selectedIndex !== null) {
        event.preventDefault();
        selectRemoteImageAt(Math.max(0, selectedIndex - 1));
        return true;
      }
      if (
        ((editor && isEditorCursorAtStart(editor)) || current.cursor === 0) &&
        current.remoteImages.length > 0
      ) {
        event.preventDefault();
        selectRemoteImageAt(current.remoteImages.length - 1);
        return true;
      }
    }

    if (
      !activePopupRef.current &&
      selectedRemoteImageId &&
      event.key === 'ArrowDown'
    ) {
      event.preventDefault();
      const selectedIndex = selectedRemoteImageIndex(
        {
          ...current,
          selectedRemoteImageId,
        },
        selectedRemoteImageId,
      );
      if (
        selectedIndex !== null &&
        selectedIndex + 1 < current.remoteImages.length
      ) {
        selectRemoteImageAt(selectedIndex + 1);
      } else {
        clearRemoteImageSelection();
      }
      return true;
    }

    if (
      !activePopupRef.current &&
      selectedRemoteImageId &&
      (event.key === 'Backspace' || event.key === 'Delete')
    ) {
      event.preventDefault();
      removeRemoteImage(selectedRemoteImageId);
      return true;
    }

    clearRemoteImageSelectionForEditorIntent(event);
    return false;
  }

  function removeRemoteImage(imageId: string) {
    if (disabled || !editor) {
      return;
    }
    const current = currentStateFromEditor();
    const selectedIndex = current.remoteImages.findIndex(
      (image) => image.id === imageId,
    );
    const nextRemoteImages = current.remoteImages.filter(
      (image) => image.id !== imageId,
    );
    const nextSelectedImage =
      selectedIndex === -1
        ? null
        : (nextRemoteImages[selectedIndex] ??
          nextRemoteImages[selectedIndex - 1] ??
          null);
    pendingRemoteImageSelectionRef.current = nextSelectedImage?.id ?? null;
    remoteImagesRef.current = nextRemoteImages;
    setRemoteImages(nextRemoteImages);
    replaceEditorContent(
      renumberImageAttachmentAtoms(editor.getJSON(), nextRemoteImages.length),
    );
    setComposer((state) => ({
      ...state,
      remoteImages: nextRemoteImages,
      selectedRemoteImageId: nextSelectedImage?.id ?? null,
      shortcutsOpen: false,
    }));
  }

  function insertPaste(content: string) {
    if (disabled || !editor) {
      return;
    }
    const placeholder = nextPastePlaceholderFromContent(
      editor.getJSON(),
      characterCount(content),
    );
    editor
      .chain()
      .focus()
      .insertContent(
        atomNodeContent({
          kind: 'paste',
          label: placeholder,
          detail: `${characterCount(content)} chars`,
          content,
        }),
      )
      .run();
  }

  function insertRichLink(
    href: string,
    label = href,
    metadata?: ComposerRichLinkMetadata,
  ) {
    if (disabled) {
      return;
    }
    editor
      ?.chain()
      .focus()
      .insertContent(
        atomNodeContent({
          kind: 'rich-link',
          label,
          detail: href,
          href,
          metadata,
        }),
      )
      .run();
  }

  function currentStateFromEditor() {
    if (!editor) {
      return composerRef.current;
    }
    const serialized = serializeTiptapContent(
      editor.getJSON(),
      remoteImagesRef.current,
      slashCommands,
      isTaskRunning,
      queueSubmissions,
      editorCursorOffset(editor),
    );
    return {
      ...serialized,
      error: composerRef.current.error,
      history: composerRef.current.history,
      historyCursor:
        historyCursorRef.current ?? composerRef.current.historyCursor,
      killBuffer: composerRef.current.killBuffer,
      reverseSearch: composerRef.current.reverseSearch,
      shortcutsOpen: composerRef.current.shortcutsOpen,
      selectedRemoteImageId: composerRef.current.selectedRemoteImageId,
    };
  }

  function rejectInvalidSubmission(event: ComposerSubmission) {
    const validationError = validateSubmissionRef.current?.(event);
    if (!validationError) {
      return false;
    }
    setComposer((state) => ({
      ...state,
      error: validationError,
      shortcutsOpen: false,
    }));
    setActivePopup(null);
    return true;
  }

  // The space rule has a copy in dictation/insertTranscript.ts (strike 2;
  // ledger: docs/dictation/copied-space-rule.md). Mirror every fix in both.
  function insertTranscript(transcript: string) {
    const current = currentStateFromEditor();
    const beforeCursor = current.text.slice(0, current.cursor);
    insertText(
      beforeCursor && !/\s$/.test(beforeCursor) ? ` ${transcript}` : transcript,
    );
  }

  function submit() {
    if (dictationController?.endWithSend()) {
      return;
    }
    submitDraft();
  }

  function submitDraft() {
    if (disabled) {
      return;
    }
    const current = currentStateFromEditor();
    const submittedContent = editor?.getJSON() ?? emptyDoc();
    const shouldQueue = current.isTaskRunning || current.queueSubmissions;
    const unknownSlash = shouldQueue
      ? null
      : unknownSlashCommand(current.text, slashCommands, commandTriggers);
    if (unknownSlash) {
      setComposer((state) => ({
        ...state,
        error: unknownCommandMessage({ name: unknownSlash }),
        shortcutsOpen: false,
      }));
      setActivePopup(null);
      return;
    }
    const preparedPayload = prepareComposerPayload(
      current,
      slashCommands,
      commandTriggers,
    );
    const prepared =
      preparedPayload ??
      ({
        mode: 'submitted',
        prompt: '',
        persistedPrompt: '',
        historyPrompt: '',
        action: 'Plain',
        command: undefined,
        args: undefined,
        items: [],
        elements: [],
        payloadElements: [],
        mentionBindings: [],
      } satisfies NonNullable<ComposerPreparedPayload>);
    const chars = characterCount(prepared.prompt);
    if (expandedTextLimit && chars > expandedTextLimit.maxChars) {
      setComposer((state) => ({
        ...state,
        error: expandedTextLimit.message({
          chars,
          maxChars: expandedTextLimit.maxChars,
        }),
        shortcutsOpen: false,
      }));
      setActivePopup(null);
      return;
    }
    const sentImageFiles = new Map<string, File>();
    const imageItems: ComposerSubmission['items'] = [];
    for (const image of current.imageAttachments) {
      const file = attachedImagesRef.current.get(image.id);
      if (!file) {
        setComposer((state) => ({
          ...state,
          error: missingAttachmentMessage({ placeholder: image.placeholder }),
          shortcutsOpen: false,
        }));
        setActivePopup(null);
        return;
      }
      sentImageFiles.set(image.id, file);
      imageItems.push({
        type: image.media,
        placeholder: image.placeholder,
        file,
      });
    }
    const remoteItems = prepared.items.filter(
      (item) => item.type === 'remote_image',
    );
    const items = [
      ...remoteItems,
      ...imageItems,
      ...prepared.items.filter((item) => item.type !== 'remote_image'),
    ];
    const event: ComposerSubmission = {
      id: crypto.randomUUID(),
      at: new Date(clock.Date.now()).toLocaleTimeString(),
      mode: shouldQueue ? 'queued' : prepared.mode,
      prompt: prepared.prompt,
      persistedPrompt: prepared.persistedPrompt,
      action: shouldQueue
        ? queuedAction(prepared, commandTriggers)
        : prepared.action,
      command: prepared.command,
      args: prepared.args,
      items,
    };
    if (rejectInvalidSubmission(event)) {
      return;
    }
    for (const id of sentImageFiles.keys()) {
      attachedImagesRef.current.delete(id);
    }
    const editableSource = createComposerDraftSource(
      current,
      prepared.persistedPrompt,
    );
    const submitResult = onSubmitRef.current?.(event, { editableSource });
    if (isThenable(submitResult)) {
      pendingSendsRef.current += 1;
      submitResult
        .then(() => {
          if (draftKey !== undefined) writeStoredDraft(draftKey, null);
        })
        .catch((error: unknown) => {
          for (const [id, file] of sentImageFiles) {
            attachedImagesRef.current.set(id, file);
          }
          if (draftKey !== undefined)
            writeStoredDraft(draftKey, editableSource);
          if (mountedRef.current) {
            replaceEditorContent(submittedContent);
            editor?.commands.focus('end');
            setComposer((state) => ({
              ...state,
              error:
                error instanceof Error
                  ? submitErrorMessage(error)
                  : submitFailedMessage,
            }));
          }
        })
        .finally(() => {
          pendingSendsRef.current -= 1;
        });
    }
    const nextHistory = preparedPayload
      ? pushComposerHistory(current, prepared.historyPrompt)
      : current.history;
    historyCursorRef.current = null;
    remoteImagesRef.current = [];
    setRemoteImages([]);
    setActivePopup(null);
    replaceEditorContent(emptyDoc());
    setComposer((state) => ({
      ...state,
      text: '',
      cursor: 0,
      elements: [],
      mentionBindings: [],
      imageAttachments: [],
      remoteImages: [],
      pendingPastes: [],
      selectedRemoteImageId: null,
      error: null,
      shortcutsOpen: false,
      history: nextHistory,
      historyCursor: null,
    }));
  }

  function reset() {
    if (disabled) {
      return;
    }
    const history = composerRef.current.history;
    const killBuffer = composerRef.current.killBuffer;
    historyCursorRef.current = null;
    reverseSearchStartRef.current = null;
    attachedImagesRef.current.clear();
    remoteImagesRef.current = initialRemoteImagesRef.current;
    setRemoteImages(initialRemoteImagesRef.current);
    setActivePopup(null);
    replaceEditorContent(initialContentRef.current);
    editor?.commands.focus('end');
    setComposer((state) => ({
      ...state,
      history,
      historyCursor: null,
      killBuffer,
      reverseSearch: null,
      selectedRemoteImageId: null,
      error: null,
      shortcutsOpen: false,
    }));
  }

  function recallHistory(direction: number) {
    if (disabled) {
      return;
    }
    if (!editor || composerRef.current.history.length === 0) {
      return;
    }
    const current = composerRef.current;
    const historyCursor = historyCursorRef.current ?? current.historyCursor;
    if (
      direction > 0 &&
      historyCursor === 0 &&
      pendingHistoryDraftRef.current
    ) {
      restoreDraft(pendingHistoryDraftRef.current, null);
      pendingHistoryDraftRef.current = null;
      return;
    }
    const index =
      historyCursor === null
        ? direction < 0
          ? 0
          : current.history.length - 1
        : wrapIndex(historyCursor + direction, current.history.length);
    if (historyCursor === null) {
      pendingHistoryDraftRef.current = createDraftFromState(
        currentStateFromEditor(),
      );
    }
    const entry = current.history[index];
    restoreHistoryEntry(entry, index);
  }

  function restoreHistoryEntry(
    entry: ComposerDraftSource,
    historyCursor: number | null,
  ) {
    const draft = createDraftFromSource({
      source: entry,
      slashCommands,
      mentionCandidates,
    });
    restoreDraft(draft, historyCursor);
  }

  function restoreDraft(
    draft: ComposerInitialDraft,
    historyCursor: number | null,
  ) {
    const remoteImages = draft.remoteImages ?? [];
    remoteImagesRef.current = remoteImages;
    composerRef.current = {
      ...composerRef.current,
      historyCursor,
      shortcutsOpen: false,
    };
    historyCursorRef.current = historyCursor;
    pendingHistoryCursorRef.current = historyCursor;
    setRemoteImages(remoteImages);
    replaceEditorContent(
      contentFromStateOrText({
        state: draft,
        slashCommands,
        mentionCandidates,
        triggers,
      }),
    );
    editor?.commands.focus('end');
    setComposer((state) => ({
      ...state,
      historyCursor,
      shortcutsOpen: false,
    }));
  }

  function startReverseSearch() {
    if (disabled) {
      return;
    }
    setActivePopup(null);
    historyCursorRef.current = null;
    reverseSearchStartRef.current = currentStateFromEditor();
    setComposer((state) => ({
      ...state,
      reverseSearch: '',
      historyCursor: null,
      shortcutsOpen: false,
    }));
  }

  function handleReverseSearch(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (event.key === 'Escape') {
      restoreReverseSearchStart(null);
      reverseSearchStartRef.current = null;
      return;
    }
    if (event.key === 'Enter') {
      reverseSearchStartRef.current = null;
      setComposer((state) => ({
        ...state,
        reverseSearch: null,
        shortcutsOpen: false,
      }));
      return;
    }
    if (event.key === 'Backspace') {
      updateReverseSearch((query) => query.slice(0, -1));
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
      cycleReverseSearch(1);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      cycleReverseSearch(-1);
      return;
    }
    if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.altKey &&
      !event.ctrlKey
    ) {
      updateReverseSearch((query) => `${query}${event.key}`);
    }
  }

  function updateReverseSearch(update: (query: string) => string) {
    if (disabled) {
      return;
    }
    const current = composerRef.current;
    const query = update(current.reverseSearch ?? '');
    const match = findHistorySearchMatch(current.history, query, null);
    if (!editor || !match) {
      restoreReverseSearchStart(query);
      return;
    }
    applyReverseSearchMatch(match.entry, match.index, query);
  }

  function cycleReverseSearch(direction: -1 | 1) {
    if (disabled || !editor) {
      return;
    }
    const current = composerRef.current;
    const query = current.reverseSearch ?? '';
    const match = findHistorySearchMatch(
      current.history,
      query,
      current.historyCursor,
      direction,
    );
    if (!match) {
      return;
    }
    applyReverseSearchMatch(match.entry, match.index, query);
  }

  function applyReverseSearchMatch(
    entry: ComposerDraftSource,
    index: number,
    query: string,
  ) {
    const currentEditor = editor;
    if (!currentEditor) {
      return;
    }
    const draft = createDraftFromSource({
      source: entry,
      slashCommands,
      mentionCandidates,
    });
    const remoteImages = draft.remoteImages ?? [];
    remoteImagesRef.current = remoteImages;
    setRemoteImages(remoteImages);
    replaceEditorContent(
      contentFromStateOrText({
        state: draft,
        slashCommands,
        mentionCandidates,
        triggers,
      }),
    );
    currentEditor.commands.focus('end');
    setComposer((state) => ({
      ...state,
      historyCursor: index,
      reverseSearch: query,
      selectedRemoteImageId: null,
      shortcutsOpen: false,
    }));
  }

  function restoreReverseSearchStart(reverseSearch: string | null) {
    if (disabled) {
      return;
    }
    const start = reverseSearchStartRef.current;
    if (!start || !editor) {
      setComposer((state) => ({
        ...state,
        reverseSearch,
        shortcutsOpen: false,
      }));
      return;
    }
    const restored = {
      ...start,
      history: composerRef.current.history,
      killBuffer: composerRef.current.killBuffer,
      reverseSearch,
      historyCursor: null,
      selectedRemoteImageId: null,
      shortcutsOpen: false,
    };
    historyCursorRef.current = null;
    remoteImagesRef.current = restored.remoteImages;
    setRemoteImages(restored.remoteImages);
    replaceEditorContent(
      contentFromStateOrText({
        state: restored,
        slashCommands,
        mentionCandidates,
        triggers,
      }),
    );
    editor.commands.focus('end');
    setComposer(restored);
  }

  handleNativeEditorKeyDownRef.current = disabled
    ? (event) => {
        event.preventDefault();
        return true;
      }
    : handleRemoteImageKeyDown;
  attachImageFileRef.current = attachImageFile;

  function onEditorKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest('[data-slot="composer-editor"]')
    ) {
      return;
    }
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (!editor) {
      return;
    }

    if (handleRemoteImageKeyDown(event)) {
      return;
    }

    if (composerRef.current.reverseSearch !== null) {
      handleReverseSearch(event);
      return;
    }

    if (composerRef.current.shortcutsOpen && event.key === 'Escape') {
      event.preventDefault();
      closeShortcuts();
      return;
    }

    if (
      event.key === '?' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      canOpenShortcuts(currentStateFromEditor())
    ) {
      event.preventDefault();
      toggleShortcuts();
      return;
    }

    if (isInsertNewlineShortcut(event)) {
      event.preventDefault();
      editor.chain().focus().setHardBreak().run();
      historyCursorRef.current = null;
      setActivePopup(null);
      return;
    }

    if (activePopupRef.current) {
      if (isPopupUpKey(event) || isPopupDownKey(event)) {
        event.preventDefault();
        movePopupSelection(isPopupUpKey(event) ? -1 : 1);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        acceptSuggestion();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (suggestions.length === 0) {
          setActivePopup(null);
          submit();
          return;
        }
        acceptSuggestion();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setActivePopup(null);
        return;
      }
    }

    if (isDeleteBackwardWordShortcut(event)) {
      const killed = deleteBackwardWord(editor);
      if (killed) {
        event.preventDefault();
        richKillBufferRef.current = killed;
        setComposer((state) => ({
          ...state,
          killBuffer: killed.text,
        }));
      }
      historyCursorRef.current = null;
      return;
    }

    const wordMovementDirection = wordMovementShortcutDirection(event);
    if (wordMovementDirection !== null) {
      event.preventDefault();
      moveCursorByWord(editor, wordMovementDirection);
      historyCursorRef.current = null;
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      moveCursorToLineEnd(editor);
      historyCursorRef.current = null;
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      const killed = killToLineEnd(editor);
      if (killed) {
        event.preventDefault();
        richKillBufferRef.current = killed;
        setComposer((state) => ({
          ...state,
          killBuffer: killed.text,
        }));
      }
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') {
      const killed = killToLineStart(editor);
      if (killed) {
        event.preventDefault();
        richKillBufferRef.current = killed;
        setComposer((state) => ({
          ...state,
          killBuffer: killed.text,
        }));
      }
      return;
    }

    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'y' &&
      composerRef.current.killBuffer
    ) {
      event.preventDefault();
      insertKilledContent(
        editor,
        richKillBufferRef.current ?? composerRef.current.killBuffer,
      );
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      startReverseSearch();
      return;
    }

    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      clearWholeEditorSelection(editor)
    ) {
      event.preventDefault();
      historyCursorRef.current = null;
      setActivePopup(null);
      return;
    }

    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      deleteAtomAtSelectionEdge(editor, event.key)
    ) {
      event.preventDefault();
      historyCursorRef.current = null;
      return;
    }

    if (
      event.key === 'Backspace' ||
      event.key === 'Delete' ||
      (event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey)
    ) {
      historyCursorRef.current = null;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      submit();
      return;
    }

    const historyDirection = historyNavigationDirection(event);
    if (historyDirection !== null && !activePopupRef.current) {
      const current = currentStateFromEditor();
      if (
        event.key === 'ArrowUp' &&
        (isEditorCursorAtStart(editor) || current.cursor === 0) &&
        current.remoteImages.length > 0
      ) {
        event.preventDefault();
        selectRemoteImageAt(current.remoteImages.length - 1);
        return;
      }
      if (
        shouldNavigateHistory(current.text, current.cursor, historyDirection)
      ) {
        event.preventDefault();
        recallHistory(historyDirection);
      }
    }
  }

  function onComposerMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest('[data-slot="composer-editor"]')) {
      clearRemoteImageSelection();
    }
  }

  function movePopupSelection(direction: number) {
    if (disabled) {
      return;
    }
    setActivePopup((current) => {
      if (!current) {
        return current;
      }
      const size = popupSuggestionMatches(
        current,
        slashCommands,
        mentionCandidates,
        hasInteracted,
      ).length;
      if (size === 0) {
        return current;
      }
      return {
        ...current,
        selectedIndex: wrapIndex(current.selectedIndex + direction, size),
      };
    });
  }

  const dictationController = useComposerDictationController({
    dictation,
    disabled,
    insertTranscript,
    submitDraft,
  });

  const contextValue: ComposerContextValue = {
    state: composer,
    disabled,
    acceptedMediaTypes,
    commandTriggers,
    activePopup,
    suggestions,
    attachedImages: attachedImagesRef.current,
    setEditorPlaceholder,
    actions: {
      acceptSuggestion,
      toggleSlashMenu,
      insertText,
      attachImageFiles,
      removeImageAttachment,
      addRemoteImage,
      handleDrop,
      insertPaste,
      insertRichLink,
      openShortcuts,
      closeShortcuts,
      toggleShortcuts,
      submit,
      reset,
    },
    meta: {
      editor,
    },
  };

  return (
    <ComposerContext value={contextValue}>
      <ComposerDictationContext value={dictationController?.api ?? null}>
        <section
          data-slot="composer"
          className={cn(
            'border-border bg-card relative border font-[inherit]',
            className,
          )}
        >
          <div
            onKeyDownCapture={onEditorKeyDown}
            onMouseDownCapture={onComposerMouseDown}
          >
            {children}
          </div>
        </section>
      </ComposerDictationContext>
    </ComposerContext>
  );
}

function ComposerContent({ className, ...props }: ComposerContentProps) {
  return <div className={cn('space-y-2', className)} {...props} />;
}

function ComposerToolbar({ className, ...props }: ComposerToolbarProps) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      {...props}
    />
  );
}

function ComposerRemoteImages({
  className,
  attachmentLabel,
  ...props
}: ComposerRemoteImagesProps) {
  const { state } = useComposerContext('Composer.RemoteImages');
  if (state.remoteImages.length === 0) {
    return null;
  }
  return (
    <div
      className={cn('border-border space-y-1 border-b pb-2 text-sm', className)}
      {...props}
    >
      {state.remoteImages.map((image, index) => {
        const selected = state.selectedRemoteImageId === image.id;
        return (
          <div
            key={image.id}
            className={cn(
              'flex h-6 items-center gap-2 rounded-sm px-2',
              selected ? 'bg-primary text-primary-foreground' : 'text-sky-500',
            )}
          >
            <span className="shrink-0">
              {attachmentLabel({ media: 'image', number: index + 1 })}
            </span>
            <span className="truncate text-xs opacity-70">{image.url}</span>
          </div>
        );
      })}
    </div>
  );
}

function acceptFileDrag(event: ReactDragEvent<HTMLDivElement>) {
  if (event.dataTransfer.types.includes('Files')) {
    event.preventDefault();
  }
}

function ComposerEditor({
  className,
  onDragEnter,
  onDragOver,
  onDrop,
  placeholder,
  ...props
}: ComposerEditorProps) {
  const { disabled, meta, actions, setEditorPlaceholder } =
    useComposerContext('Composer.Editor');
  useLayoutEffect(() => {
    setEditorPlaceholder(placeholder);
  }, [placeholder, setEditorPlaceholder]);
  return (
    <div
      data-slot="composer-frame"
      className={className}
      aria-disabled={disabled}
      data-disabled={disabled ? '' : undefined}
      onDragEnter={(event) => {
        onDragEnter?.(event);
        acceptFileDrag(event);
      }}
      onDragOver={(event) => {
        onDragOver?.(event);
        acceptFileDrag(event);
      }}
      onDrop={(event) => {
        onDrop?.(event);
        if (event.defaultPrevented) {
          return;
        }
        if (actions.handleDrop(event.dataTransfer)) {
          event.preventDefault();
        }
      }}
      {...props}
    >
      <EditorContent editor={meta.editor} />
    </div>
  );
}

function ComposerError({ className, ...props }: ComposerErrorProps) {
  const { state } = useComposerContext('Composer.Error');
  if (!state.error) {
    return null;
  }
  return (
    <div
      role="alert"
      className={cn(
        'border-primary/30 bg-primary/10 text-primary rounded-md border px-3 py-2 text-xs',
        className,
      )}
      {...props}
    >
      {state.error}
    </div>
  );
}

function ComposerPopup({
  className,
  listboxLabel,
  noMatchesLabel,
  argsLabel,
  ...props
}: ComposerPopupProps) {
  const {
    activePopup,
    suggestions,
    actions: { acceptSuggestion },
  } = useComposerContext('Composer.Popup');
  if (!activePopup) {
    return null;
  }

  // A single icon reserves the slot for every row, so tokens keep one left edge
  // even when a host gives icons to only part of its registry.
  const withIcons = suggestions.some((suggestion) => suggestion.icon);

  return (
    <div
      className={cn(
        'border-border bg-popover absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-10 rounded-xl border shadow-lg',
        className,
      )}
      {...props}
    >
      <div
        className="flex max-h-72 flex-col gap-1 overflow-y-auto p-1"
        role="listbox"
        aria-label={listboxLabel}
      >
        {suggestions.map((suggestion, index) => (
          <PopupRow
            key={`item:${suggestion.id}`}
            selected={index === activePopup.selectedIndex}
            icon={withIcons ? suggestion.icon : null}
            token={itemToken(suggestion)}
            argsLabel={suggestion.supportsArgs === true ? argsLabel : null}
            description={suggestion.detail}
            onMouseDown={() => acceptSuggestion({ index })}
          />
        ))}
        {suggestions.length === 0 ? (
          <div className="text-muted-foreground px-2 py-1 text-[13px] leading-4">
            {noMatchesLabel}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PopupRow({
  selected,
  icon,
  token,
  argsLabel,
  description,
  onMouseDown,
}: {
  selected: boolean;
  icon: ReactNode;
  token: string;
  argsLabel: string | null;
  description: string;
  onMouseDown: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selected) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  return (
    <button
      ref={rowRef}
      type="button"
      role="option"
      aria-selected={selected}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-[13px] leading-4 [&_svg]:size-4 [&_svg]:shrink-0',
        selected
          ? 'bg-accent text-foreground'
          : 'text-foreground/80 hover:bg-accent/60',
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown();
      }}
    >
      {icon === null ? null : (
        <span className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      )}
      <span className="truncate">{token}</span>
      {argsLabel === null ? null : (
        <span className="text-muted-foreground shrink-0">{argsLabel}</span>
      )}
      <span className="text-muted-foreground truncate">{description}</span>
    </button>
  );
}

const SHORTCUT_GROUPS = [
  {
    group: 'send',
    items: [
      ['Enter', 'send'],
      ['Shift Enter', 'newline'],
      ['Alt Enter', 'newline'],
    ],
  },
  {
    group: 'edit',
    items: [
      ['Ctrl K', 'killToEnd'],
      ['Ctrl U', 'killToStart'],
      ['Ctrl W', 'killWord'],
      ['Ctrl Y', 'yank'],
    ],
  },
  {
    group: 'navigate',
    items: [
      ['Ctrl P/N', 'history'],
      ['Ctrl R', 'reverseSearch'],
      ['Ctrl E', 'lineEnd'],
      ['Alt B/F', 'wordMove'],
    ],
  },
] as const satisfies ReadonlyArray<{
  group: ComposerShortcutGroup;
  items: ReadonlyArray<readonly [string, ComposerShortcutAction]>;
}>;

function ComposerShortcuts({
  className,
  heading,
  closeLabel,
  groupTitles,
  descriptions,
  ...props
}: ComposerShortcutsProps) {
  const {
    state,
    actions: { closeShortcuts },
  } = useComposerContext('Composer.Shortcuts');
  if (!state.shortcutsOpen || !isComposerDraftEmpty(state)) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-label={heading}
      className={cn(
        'border-border bg-popover border-t px-3 py-3 text-xs',
        className,
      )}
      {...props}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-foreground font-medium">{heading}</div>
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-sm px-2 py-1"
          onClick={closeShortcuts}
        >
          {closeLabel}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {SHORTCUT_GROUPS.map(({ group, items }) => (
          <div key={group} className="space-y-2">
            <div className="text-muted-foreground text-[11px]">
              {groupTitles[group]}
            </div>
            <div className="space-y-1">
              {items.map(([key, action]) => (
                <div
                  key={`${key}-${action}`}
                  className="flex items-center justify-between gap-2"
                >
                  <kbd className="border-border bg-muted text-foreground rounded border px-1.5 py-0.5 font-[inherit]">
                    {key}
                  </kbd>
                  <span className="text-muted-foreground text-right">
                    {descriptions[action]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ComposerFooter({
  className,
  draftHints,
  popupHints,
  reverseSearchHints,
  ...props
}: ComposerFooterProps) {
  const { activePopup, state } = useComposerContext('Composer.Footer');
  if (state.reverseSearch !== null) {
    return (
      <div
        className={cn(
          'border-border text-muted-foreground flex items-center gap-2 border-t px-3 py-2 text-[11px]',
          className,
        )}
        {...props}
      >
        <kbd className="border-border bg-muted text-foreground rounded border px-1.5 py-0.5 font-[inherit]">
          Ctrl R
        </kbd>
        <span>{reverseSearchHints.label}</span>
        <span className="text-foreground">{state.reverseSearch || '_'}</span>
        <span>Ctrl R {reverseSearchHints.previous}</span>
        <span>Ctrl S {reverseSearchHints.next}</span>
        <span>Enter {reverseSearchHints.accept}</span>
        <span>Esc {reverseSearchHints.cancel}</span>
      </div>
    );
  }

  const hints = activePopup
    ? [
        ['Enter', popupHints.insert],
        ['Tab', popupHints.insert],
        ['Esc', popupHints.dismiss],
      ]
    : [
        [
          'Enter',
          state.isTaskRunning || state.queueSubmissions
            ? draftHints.queue
            : draftHints.send,
        ],
        ['Shift Enter', draftHints.newline],
        ['Alt Enter', draftHints.newline],
        ['Ctrl J/M', draftHints.newline],
        ['Ctrl P/N', draftHints.history],
        ['Ctrl E', draftHints.lineEnd],
        ['Ctrl K', draftHints.killToEnd],
        ['Ctrl U', draftHints.killToStart],
        ['Ctrl W', draftHints.killWord],
        ['Alt B/F', draftHints.wordMove],
        ['Ctrl Y', draftHints.yank],
      ];

  return (
    <div
      className={cn(
        'border-border text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-[11px]',
        className,
      )}
      {...props}
    >
      {hints.map(([key, label]) => (
        <span
          key={`${key}-${label}`}
          className="inline-flex items-center gap-1"
        >
          <kbd className="border-border bg-muted text-foreground rounded border px-1.5 py-0.5 font-[inherit]">
            {key}
          </kbd>
          {label}
        </span>
      ))}
    </div>
  );
}

function ComposerAttachFiles({
  multiple = true,
  disabled,
  inputLabel,
  ...props
}: ComposerAttachFilesProps) {
  const {
    actions,
    disabled: rootDisabled,
    acceptedMediaTypes = ['image/*', 'video/*', 'audio/*'],
  } = useComposerContext('Composer.AttachFiles');
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <ComposerTiptapActionTrigger
        action={() => inputRef.current?.click()}
        disabled={disabled}
        {...props}
      />
      <input
        ref={inputRef}
        type="file"
        accept={acceptedMediaTypes.join(',')}
        multiple={multiple}
        aria-label={inputLabel}
        hidden
        disabled={rootDisabled || disabled}
        onChange={(event) => {
          const input = event.currentTarget;
          if (input.files) {
            actions.attachImageFiles(input.files);
          }
          input.value = '';
        }}
      />
    </>
  );
}

function ComposerAddRemoteImage({
  url,
  ...props
}: ComposerAddRemoteImageProps) {
  const { actions } = useComposerContext('Composer.AddRemoteImage');
  return (
    <ComposerTiptapActionTrigger
      action={() => actions.addRemoteImage(url)}
      {...props}
    />
  );
}

function ComposerInsertPaste({ content, ...props }: ComposerInsertPasteProps) {
  const { actions } = useComposerContext('Composer.InsertPaste');
  return (
    <ComposerTiptapActionTrigger
      action={() => actions.insertPaste(content)}
      {...props}
    />
  );
}

function ComposerInsertRichLink({
  href,
  label,
  metadata,
  ...props
}: ComposerInsertRichLinkProps) {
  const { actions } = useComposerContext('Composer.InsertRichLink');
  return (
    <ComposerTiptapActionTrigger
      action={() => actions.insertRichLink(href, label, metadata)}
      {...props}
    />
  );
}

function ComposerSubmit(props: ComposerSubmitProps) {
  const { actions } = useComposerContext('Composer.Submit');
  return <ComposerTiptapActionTrigger action={actions.submit} {...props} />;
}

function ComposerReset(props: ComposerResetProps) {
  const { actions } = useComposerContext('Composer.Reset');
  return <ComposerTiptapActionTrigger action={actions.reset} {...props} />;
}

function ComposerTiptapActionTrigger({
  action,
  onClick,
  disabled,
  ...props
}: ComposerActionTriggerProps & { action: () => void }) {
  const { disabled: rootDisabled } = useComposerContext(
    'Composer.ActionTrigger',
  );
  return (
    <Button
      {...props}
      disabled={rootDisabled || disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          action();
        }
      }}
    />
  );
}

function isInsertNewlineShortcut(
  event: Pick<
    ReactKeyboardEvent<HTMLElement>,
    'altKey' | 'ctrlKey' | 'key' | 'metaKey'
  >,
) {
  if (event.metaKey) {
    return false;
  }
  if (event.key === 'Enter') {
    return event.altKey && !event.ctrlKey;
  }
  const key = event.key.toLowerCase();
  return event.ctrlKey && !event.altKey && (key === 'j' || key === 'm');
}

function isDeleteBackwardWordShortcut(
  event: Pick<
    ReactKeyboardEvent<HTMLElement>,
    'altKey' | 'ctrlKey' | 'key' | 'metaKey'
  >,
) {
  if (event.metaKey) {
    return false;
  }
  if (event.key === 'Backspace') {
    return event.ctrlKey || event.altKey;
  }
  const key = event.key.toLowerCase();
  return (
    (event.ctrlKey && !event.altKey && key === 'w') ||
    (event.ctrlKey && event.altKey && key === 'h')
  );
}

function wordMovementShortcutDirection(
  event: Pick<
    ReactKeyboardEvent<HTMLElement>,
    'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
  >,
): -1 | 1 | null {
  if (event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key === 'ArrowLeft' && (event.altKey || event.ctrlKey)) {
    return -1;
  }
  if (event.key === 'ArrowRight' && (event.altKey || event.ctrlKey)) {
    return 1;
  }
  if (!event.altKey || event.ctrlKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === 'b') {
    return -1;
  }
  if (key === 'f') {
    return 1;
  }
  return null;
}

function historyNavigationDirection(
  event: Pick<
    ReactKeyboardEvent<HTMLElement>,
    'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
  >,
): -1 | 1 | null {
  if (event.key === 'ArrowUp') {
    return -1;
  }
  if (event.key === 'ArrowDown') {
    return 1;
  }
  if (event.metaKey || event.altKey || event.shiftKey || !event.ctrlKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === 'p') {
    return -1;
  }
  if (key === 'n') {
    return 1;
  }
  return null;
}

function clearWholeEditorSelection(editor: Editor) {
  const { doc, selection } = editor.state;
  if (
    selection.empty ||
    selection.from > 1 ||
    selection.to < doc.content.size - 1
  ) {
    return false;
  }
  editor.commands.setContent(emptyDoc(), { emitUpdate: true });
  editor.commands.focus('start');
  editor.commands.setTextSelection(1);
  return true;
}

export const Composer = {
  Root: ComposerRoot,
  Trigger: ComposerTrigger,
  Command: ComposerCommand,
  Mention: ComposerMention,
  Content: ComposerContent,
  Toolbar: ComposerToolbar,
  RemoteImages: ComposerRemoteImages,
  Attachments: ComposerAttachments,
  Editor: ComposerEditor,
  Error: ComposerError,
  Popup: ComposerPopup,
  Shortcuts: ComposerShortcuts,
  Footer: ComposerFooter,
  AttachFiles: ComposerAttachFiles,
  AddRemoteImage: ComposerAddRemoteImage,
  InsertPaste: ComposerInsertPaste,
  InsertRichLink: ComposerInsertRichLink,
  Dictate: ComposerDictate,
  CancelDictation: ComposerCancelDictation,
  Submit: ComposerSubmit,
  Reset: ComposerReset,
} as const;
