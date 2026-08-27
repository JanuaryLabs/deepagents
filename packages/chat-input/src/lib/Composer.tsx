import type { JSONContent } from '@tiptap/core';
import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import { Slot } from 'radix-ui';
import {
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type ComposerPreparedPayload,
  createComposerDraftSource,
  createDraftFromSource,
  createDraftFromState,
  expandedTextLimitError,
  findHistorySearchMatch,
  isComposerDraftEmpty,
  prepareComposerPayload,
  pushComposerHistory,
  selectedRemoteImageIndex,
  shouldNavigateHistory,
  unknownSlashCommand,
} from './ComposerCore.ts';
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
  ComposerDraftSource,
  ComposerDropTransfer,
  ComposerInitialDraft,
  ComposerItemEntry,
  ComposerPopupTrigger,
  ComposerRemoteImage,
  ComposerRichLinkMetadata,
  ComposerState,
  ComposerSubmission,
  ComposerSuggestion,
} from './ComposerTypes.ts';
import { cn } from './cn.ts';
import {
  type ComposerTiptapKillBuffer,
  activeEditorToken,
  atomNodeContent,
  characterCount,
  contentFromStateOrText,
  createComposerTiptapExtensions,
  deleteAtomAtSelectionEdge,
  deleteBackwardWord,
  editorCursorOffset,
  emptyDoc,
  handleComposerDropInView,
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
  renumberLocalImageAtoms,
  serializeTiptapContent,
  stableId,
  wrapIndex,
} from './tiptap/ComposerTiptapDomain.ts';

export type ComposerRootProps = {
  initialDraft?: ComposerInitialDraft;
  disabled?: boolean;
  isTaskRunning?: boolean;
  queueSubmissions?: boolean;
  hasInteracted?: boolean;
  maxExpandedTextChars?: number;
  editorAriaLabel?: string;
  className?: string;
  children?: ReactNode;
  validateSubmission?: (event: ComposerSubmission) => string | null;
  onSubmit?: (
    event: ComposerSubmission,
    context: ComposerSubmitContext,
  ) => void;
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

export type ComposerRemoteImagesProps = ComponentPropsWithoutRef<'div'>;

export type ComposerEditorProps = ComponentPropsWithoutRef<'div'> & {
  placeholder?: string;
};

export type ComposerErrorProps = ComponentPropsWithoutRef<'div'>;

export type ComposerPopupProps = ComponentPropsWithoutRef<'div'>;

export type ComposerShortcutsProps = ComponentPropsWithoutRef<'div'>;

export type ComposerFooterProps = ComponentPropsWithoutRef<'div'>;

type ComposerActionTriggerProps = ComponentPropsWithoutRef<'button'> & {
  asChild?: boolean;
};

export type ComposerAttachLocalImageProps = ComposerActionTriggerProps & {
  path?: string;
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

export type ComposerAcceptSuggestionOptions = {
  index?: number;
};

type ComposerKeyboardEvent = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
};

export type ComposerActions = {
  acceptSuggestion: (options?: ComposerAcceptSuggestionOptions) => void;
  toggleSlashMenu: () => void;
  insertText: (text: string) => void;
  attachLocalImage: (path?: string) => void;
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

type ComposerContextValue = {
  state: ComposerState;
  disabled: boolean;
  commandTriggers: string[];
  activePopup: ActivePopup | null;
  suggestions: ComposerSuggestion[];
  actions: ComposerActions;
  meta: ComposerEditorMeta;
};

const ComposerContext = createContext<ComposerContextValue | null>(null);

function useComposerContext(componentName: string) {
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

function ComposerRoot({
  initialDraft,
  disabled = false,
  isTaskRunning = false,
  queueSubmissions = false,
  hasInteracted = false,
  maxExpandedTextChars,
  editorAriaLabel = 'Rich prompt composer',
  className,
  children,
  validateSubmission,
  onSubmit,
  onStateChange,
}: ComposerRootProps) {
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

  const initialRemoteImagesRef = useRef(
    initialDraft?.remoteImages ??
      (initialDraft?.remoteImageUrls ?? []).map((url, index) => ({
        id: stableId('remote-image', url, index),
        url,
      })),
  );
  const initialContentRef = useRef(
    contentFromStateOrText({
      state: initialDraft,
      slashCommands,
      mentionCandidates,
      triggers,
    }),
  );
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
  const onStateChangeRef = useRef(onStateChange);
  const validateSubmissionRef = useRef(validateSubmission);
  const onSubmitRef = useRef(onSubmit);

  const refreshFromEditorRef = useRef<(editor: Editor) => void>(
    () => undefined,
  );
  const syncPopupFromEditorRef = useRef<(editor: Editor) => void>(
    () => undefined,
  );
  const handleNativeEditorKeyDownRef = useRef<
    (event: KeyboardEvent) => boolean
  >(() => false);

  const editorExtensions = useMemo(
    () =>
      createComposerTiptapExtensions({
        getMentionTrigger: () => mentionTriggersRef.current[0] ?? '@',
        getRemoteImageCount: () => remoteImagesRef.current.length,
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
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

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
    editor.view.dom.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    if (disabled) {
      setActivePopup(null);
    }
  }, [disabled, editor]);

  useEffect(() => {
    editor?.view.dom.setAttribute('aria-label', editorAriaLabel);
  }, [editor, editorAriaLabel]);

  useEffect(() => {
    onStateChangeRef.current?.(composer, preparedPayload);
  }, [composer, preparedPayload]);

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

  function attachLocalImage(path?: string) {
    if (disabled || !editor) {
      return;
    }
    const current = currentStateFromEditor();
    const number = current.remoteImages.length + current.localImages.length + 1;
    const placeholder = `[Image #${number}]`;
    const imagePath = path ?? `composer-input-${number}.png`;
    editor
      .chain()
      .focus()
      .insertContent([
        atomNodeContent({
          kind: 'image',
          label: placeholder,
          detail: imagePath,
          path: imagePath,
        }),
        { type: 'text', text: ' ' },
      ])
      .run();
  }

  function addRemoteImage(url: string) {
    if (disabled || !editor) {
      return;
    }
    const nextRemoteImages = [
      ...remoteImagesRef.current,
      {
        id: stableId('remote-image', url, Date.now()),
        url,
      },
    ];
    remoteImagesRef.current = nextRemoteImages;
    setRemoteImages(nextRemoteImages);
    replaceEditorContent(
      renumberLocalImageAtoms(editor.getJSON(), nextRemoteImages.length),
    );
  }

  function handleDrop(transfer: ComposerDropTransfer) {
    if (disabled || !editor) {
      return false;
    }
    return handleComposerDropInView(
      editor.view,
      transfer,
      remoteImagesRef.current.length,
      mentionTriggers[0] ?? '@',
    );
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
      renumberLocalImageAtoms(editor.getJSON(), nextRemoteImages.length),
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

  function submit() {
    if (disabled) {
      return;
    }
    const current = currentStateFromEditor();
    const shouldQueue = current.isTaskRunning || current.queueSubmissions;
    const unknownSlash = shouldQueue
      ? null
      : unknownSlashCommand(current.text, slashCommands, commandTriggers);
    if (unknownSlash) {
      setComposer((state) => ({
        ...state,
        error: `Unrecognized command: /${unknownSlash}`,
        shortcutsOpen: false,
      }));
      setActivePopup(null);
      return;
    }
    const prepared = prepareComposerPayload(
      current,
      slashCommands,
      commandTriggers,
    );
    if (!prepared) {
      return;
    }
    const lengthError = expandedTextLimitError(prepared, maxExpandedTextChars);
    if (lengthError) {
      setComposer((state) => ({
        ...state,
        error: lengthError,
        shortcutsOpen: false,
      }));
      setActivePopup(null);
      return;
    }
    const event: ComposerSubmission = {
      id: crypto.randomUUID(),
      at: new Date().toLocaleTimeString(),
      mode: shouldQueue ? 'queued' : prepared.mode,
      prompt: prepared.prompt,
      persistedPrompt: prepared.persistedPrompt,
      action: shouldQueue
        ? queuedAction(prepared, commandTriggers)
        : prepared.action,
      command: prepared.command,
      args: prepared.args,
      items: prepared.items,
    };
    if (rejectInvalidSubmission(event)) {
      return;
    }
    onSubmitRef.current?.(event, {
      editableSource: createComposerDraftSource(
        current,
        prepared.persistedPrompt,
      ),
    });
    const nextHistory = pushComposerHistory(current, prepared.historyPrompt);
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
      localImages: [],
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
      restoreHistoryDraft(pendingHistoryDraftRef.current, null);
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
    restoreHistoryDraft(draft, historyCursor);
  }

  function restoreHistoryDraft(
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

  function onEditorKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
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

  const contextValue: ComposerContextValue = {
    state: composer,
    disabled,
    commandTriggers,
    activePopup,
    suggestions,
    actions: {
      acceptSuggestion,
      toggleSlashMenu,
      insertText,
      attachLocalImage,
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
          {collectedRegistry.hasLayoutChildren ? null : (
            <ComposerDefaultLayout />
          )}
        </div>
      </section>
    </ComposerContext>
  );
}

function ComposerDefaultLayout() {
  return (
    <>
      <ComposerPopup />
      <ComposerContent>
        <ComposerRemoteImages />
        <ComposerEditor />
        <ComposerError />
      </ComposerContent>
      <ComposerShortcuts />
      <ComposerFooter />
    </>
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
            <span className="shrink-0">[Image #{index + 1}]</span>
            <span className="truncate text-xs opacity-70">{image.url}</span>
          </div>
        );
      })}
    </div>
  );
}

function ComposerEditor({
  className,
  onDrop,
  placeholder = 'Type a message or / for commands',
  ...props
}: ComposerEditorProps) {
  const { state, disabled, meta, actions } =
    useComposerContext('Composer.Editor');
  return (
    <div
      data-slot="composer-frame"
      className={className}
      aria-disabled={disabled}
      data-disabled={disabled ? '' : undefined}
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
      {state.text.length === 0 ? (
        <div data-slot="composer-placeholder">{placeholder}</div>
      ) : null}
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

function ComposerPopup({ className, ...props }: ComposerPopupProps) {
  const {
    activePopup,
    suggestions,
    commandTriggers,
    actions: { acceptSuggestion },
  } = useComposerContext('Composer.Popup');
  if (!activePopup) {
    return null;
  }

  return (
    <div
      className={cn(
        'border-border bg-popover absolute right-3 bottom-[calc(100%-0.5rem)] left-3 z-10 rounded-md border shadow-sm',
        className,
      )}
      {...props}
    >
      <div
        className="max-h-[260px] overflow-auto p-1"
        role="listbox"
        aria-label="Suggestions"
      >
        {suggestions.map((suggestion, index) =>
          !suggestion.atomic ? (
            <PopupRow
              key={`item:${suggestion.id}`}
              selected={index === activePopup.selectedIndex}
              title={`${suggestion.trigger}${suggestion.value}`}
              meta={suggestion.supportsArgs ? 'args' : 'item'}
              description={suggestion.detail}
              onMouseDown={() => acceptSuggestion({ index })}
            />
          ) : (
            <PopupRow
              key={`item:${suggestion.id}`}
              selected={index === activePopup.selectedIndex}
              title={itemToken(suggestion)}
              meta={suggestion.detail}
              description={suggestion.label}
              onMouseDown={() => acceptSuggestion({ index })}
            />
          ),
        )}
        {suggestions.length === 0 ? (
          <div className="text-muted-foreground px-2 py-3 text-xs">
            no matches
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PopupRow({
  selected,
  title,
  meta,
  description,
  onMouseDown,
}: {
  selected: boolean;
  title: string;
  meta: string;
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
        'grid w-full grid-cols-[minmax(140px,0.42fr)_72px_minmax(0,1fr)] items-center gap-3 rounded-sm px-2 py-2 text-left text-xs',
        selected
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground hover:bg-muted',
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown();
      }}
    >
      <span className="truncate font-medium">{title}</span>
      <span className="truncate opacity-70">{meta}</span>
      <span className="truncate opacity-70">{description}</span>
    </button>
  );
}

const SHORTCUT_GROUPS = [
  {
    title: 'Send',
    items: [
      ['Enter', 'send or queue'],
      ['Shift Enter', 'newline'],
      ['Alt Enter', 'newline'],
    ],
  },
  {
    title: 'Edit',
    items: [
      ['Ctrl K', 'kill to end'],
      ['Ctrl U', 'kill to start'],
      ['Ctrl W', 'kill word'],
      ['Ctrl Y', 'yank'],
    ],
  },
  {
    title: 'Navigate',
    items: [
      ['Ctrl P/N', 'history'],
      ['Ctrl R', 'reverse search'],
      ['Ctrl E', 'line end'],
      ['Alt B/F', 'word move'],
    ],
  },
] as const;

function ComposerShortcuts({ className, ...props }: ComposerShortcutsProps) {
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
      aria-label="Keyboard shortcuts"
      className={cn(
        'border-border bg-popover border-t px-3 py-3 text-xs',
        className,
      )}
      {...props}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-foreground font-medium">Keyboard shortcuts</div>
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-sm px-2 py-1"
          onClick={closeShortcuts}
        >
          close
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.title} className="space-y-2">
            <div className="text-muted-foreground text-[11px]">
              {group.title}
            </div>
            <div className="space-y-1">
              {group.items.map(([key, label]) => (
                <div
                  key={`${key}-${label}`}
                  className="flex items-center justify-between gap-2"
                >
                  <kbd className="border-border bg-muted text-foreground rounded border px-1.5 py-0.5 font-[inherit]">
                    {key}
                  </kbd>
                  <span className="text-muted-foreground text-right">
                    {label}
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

function ComposerFooter({ className, ...props }: ComposerFooterProps) {
  const { activePopup, state, commandTriggers } =
    useComposerContext('Composer.Footer');
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
        <span>reverse-i-search:</span>
        <span className="text-foreground">{state.reverseSearch || '_'}</span>
        <span>Ctrl R previous</span>
        <span>Ctrl S next</span>
        <span>Enter accept</span>
        <span>Esc cancel</span>
      </div>
    );
  }

  const hints =
    activePopup !== null && commandTriggers.includes(activePopup.trigger)
      ? [
          ['Enter', 'insert'],
          ['Tab', 'insert'],
          ['Esc', 'dismiss'],
        ]
      : activePopup
        ? [
            ['Enter', 'insert'],
            ['Tab', 'insert'],
            ['Esc', 'dismiss'],
          ]
        : [
            [
              'Enter',
              state.isTaskRunning || state.queueSubmissions ? 'queue' : 'send',
            ],
            ['Shift Enter', 'newline'],
            ['Alt Enter', 'newline'],
            ['Ctrl J/M', 'newline'],
            ['Ctrl P/N', 'history'],
            ['Ctrl E', 'line end'],
            ['Ctrl K', 'kill'],
            ['Ctrl U', 'kill back'],
            ['Ctrl W', 'word kill'],
            ['Alt B/F', 'word move'],
            ['Ctrl Y', 'yank'],
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

function ComposerAttachLocalImage({
  asChild = false,
  path,
  onClick,
  ...props
}: ComposerAttachLocalImageProps) {
  const { actions } = useComposerContext('Composer.AttachLocalImage');
  return (
    <ComposerTiptapActionTrigger
      asChild={asChild}
      onClick={onClick}
      action={() => actions.attachLocalImage(path)}
      {...props}
    />
  );
}

function ComposerAddRemoteImage({
  asChild = false,
  url,
  onClick,
  ...props
}: ComposerAddRemoteImageProps) {
  const { actions } = useComposerContext('Composer.AddRemoteImage');
  return (
    <ComposerTiptapActionTrigger
      asChild={asChild}
      onClick={onClick}
      action={() => actions.addRemoteImage(url)}
      {...props}
    />
  );
}

function ComposerInsertPaste({
  asChild = false,
  content,
  onClick,
  ...props
}: ComposerInsertPasteProps) {
  const { actions } = useComposerContext('Composer.InsertPaste');
  return (
    <ComposerTiptapActionTrigger
      asChild={asChild}
      onClick={onClick}
      action={() => actions.insertPaste(content)}
      {...props}
    />
  );
}

function ComposerInsertRichLink({
  asChild = false,
  href,
  label,
  metadata,
  onClick,
  ...props
}: ComposerInsertRichLinkProps) {
  const { actions } = useComposerContext('Composer.InsertRichLink');
  return (
    <ComposerTiptapActionTrigger
      asChild={asChild}
      onClick={onClick}
      action={() => actions.insertRichLink(href, label, metadata)}
      {...props}
    />
  );
}

function ComposerSubmit({
  asChild = false,
  onClick,
  ...props
}: ComposerSubmitProps) {
  const { actions } = useComposerContext('Composer.Submit');
  return (
    <ComposerTiptapActionTrigger
      asChild={asChild}
      onClick={onClick}
      action={actions.submit}
      {...props}
    />
  );
}

function ComposerReset({
  asChild = false,
  onClick,
  ...props
}: ComposerResetProps) {
  const { actions } = useComposerContext('Composer.Reset');
  return (
    <ComposerTiptapActionTrigger
      asChild={asChild}
      onClick={onClick}
      action={actions.reset}
      {...props}
    />
  );
}

function ComposerTiptapActionTrigger({
  asChild,
  action,
  onClick,
  disabled,
  type = 'button',
  ...props
}: ComposerActionTriggerProps & { action: () => void }) {
  const { disabled: rootDisabled } = useComposerContext(
    'Composer.ActionTrigger',
  );
  const Comp = asChild ? Slot.Root : 'button';
  const actionDisabled = rootDisabled || Boolean(disabled);
  return (
    <Comp
      {...props}
      aria-disabled={asChild && actionDisabled ? true : props['aria-disabled']}
      data-disabled={actionDisabled ? '' : undefined}
      disabled={asChild ? undefined : actionDisabled}
      type={asChild ? undefined : type}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (actionDisabled) {
          event.preventDefault();
          return;
        }
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
  Editor: ComposerEditor,
  Error: ComposerError,
  Popup: ComposerPopup,
  Shortcuts: ComposerShortcuts,
  Footer: ComposerFooter,
  AttachLocalImage: ComposerAttachLocalImage,
  AddRemoteImage: ComposerAddRemoteImage,
  InsertPaste: ComposerInsertPaste,
  InsertRichLink: ComposerInsertRichLink,
  Submit: ComposerSubmit,
  Reset: ComposerReset,
} as const;
