# Dictation is its own primitive, and the composer is one consumer

Status: ruled by Ezz on 2026-11-25 (deepagents #5658). It supersedes [ADR 0002](./0002-dictation-is-a-capability-of-composer-root-and-the-host-passes-the-transport-there.md), which made dictation a capability of `Composer.Root` only.

## Context

Meddit's New patient form has a plain textarea, "Anything else relevant?" (Meddit #4936). Its doctors dictate there. The field is not a composer: it has no editor, no submit and no draft. ADR 0002 put the dictation state, the recording and the transcription inside `Composer.Root`, so the only way to dictate was to render a whole composer.

The README's "Later" list already named "a hook for a plain form field (Meddit)". assistant-ui keeps dictation as an adapter beside its composer, and the composer reads it.

## Considered options

- **A `Composer.Root` without an editor for the plain field.** The field would carry the composer's submit, draft and keyboard rules that it does not use.
- **Meddit copies the recording and the transcription.** A third copy of what ADR 0001 brought into one place.
- **`useDictation` and `Dictation.Root`, `Dictation.Toggle` and `Dictation.Cancel` in `@deepagents/react-input/browser`, with the composer on top.** This option was selected.

## Decision

- `useDictation({ transcribe, onTranscript, disabled })` gives `{ state, start, stop, cancel }`. Its `DictationState` has no end: `finishing` is the transcription, and the text goes to `onTranscript`.
- `Dictation.Root` runs `useDictation` and provides it. `Dictation.Toggle` starts a dictation and stops it while it records. `Dictation.Cancel` ends it with `abort`. `useDictationContext` reads the root, and each throws outside it.
- `insertTranscript(field, text)` puts the text at the cursor of a textarea or input with `setRangeText(…, 'end')` and a bubbling `input` event, so React sees the new value. It keeps the space rule of ADR 0006.
- `Composer.Root`'s public API stays: `dictation={{ transcribe }}`, `useComposerDictation`, `Composer.Dictate` and `Composer.CancelDictation`. The composer runs the same sessions, its `onTranscript` inserts into the editor and submits the draft when the end is `send` (ADR 0008), and `ComposerDictationState` is `DictationState` whose `finishing` carries the end. `Composer.Dictate` and `Composer.CancelDictation` are the same buttons as `Dictation.Toggle` and `Dictation.Cancel`, with the composer root's `disabled`.

## Consequences

- A plain field dictates with no composer. Meddit's field is the first consumer.
- `DictationState` is now the union without the end. A consumer that reads `state.end` from `useComposerDictation` types it as `ComposerDictationState` (blackboard's `sendMode`, `apps/web/src/routes/ChatBot/ChatComposer.tsx:359`, when it moves past 7.9.0).
- The space rule has two copies, the editor's and the field's: strike 2, ledger [copied-space-rule.md](../copied-space-rule.md).
- `send` stays a composer end: a plain field has no draft to submit.
