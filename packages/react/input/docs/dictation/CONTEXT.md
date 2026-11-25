# Dictation glossary

> These words belong to dictation, in a plain field and in the composer; see [README.md](./README.md).

**Dictation.** The user speaks, and the text goes into a field or the composer. Here it is batch: one recording, then one transcription. ChatGPT, Codex and assistant-ui use the same word.

**Dictation session.** One dictation attempt, from a start to its end. The `DictationSession` class owns the `MediaStream`, the `MediaRecorder`, the transcription of the clip, its failure, and the one `AbortController` that drops them all. A new start makes a new session, so a stale result cannot reach it. Hooks read it through `useSyncExternalStore` (ADR 0010).

**Dictation.Root.** The provider that runs `useDictation` for a plain field and gives its `{ state, start, stop, cancel }` to `Dictation.Toggle`, `Dictation.Cancel` and `useDictationContext`. `Composer.Root` with `dictation` is the composer's own root (ADR 0009).

**Recording.** The part of a dictation session that captures one clip from the microphone, from a start to an end.

**Clip.** The `Blob` that a recording gives. Its type is the `mimeType` that the browser recorded.

**Transport.** The host's `transcribe(audio, { signal })`, given to `useDictation` and `Dictation.Root` as `transcribe`, and to `Composer.Root` as `dictation.transcribe`. It sends the clip where the host chooses and gives `{ text }`. Dictation never knows the endpoint or the model.

**Transcription.** One call of the transport, from the clip to the text.

**End.** How a dictation finishes: `abort` (the clip or the transcription is dropped), `insert` (the text goes to `onTranscript`, in the composer at the cursor) or `send` (composer only: the text goes in, then the draft is submitted). The names are ChatGPT's and Codex's.

**Finishing.** The status from the end of a recording to the end of its transcription. In the composer it carries the end that will follow.

**Dictation state.** The `DictationState` union of one dictation control, one dictation at a time. `useDictation` and `useDictationContext` read it. The composer's `ComposerDictationState` is the same union whose `finishing` carries the end; `useComposerDictation` reads it. The parts put the status on their element as `data-status`.

**Unavailable.** Dictation cannot start in this browser: no `MediaRecorder` (`unsupported`), or the microphone permission is `denied` (`blocked`). A host that does not offer dictation at all passes no `dictation`; that is not unavailable.

**Insertion.** The transcribed text goes in at the cursor, with a space before it when the character before the cursor is not whitespace: the composer does it in its editor, and `insertTranscript` in a plain textarea or input.
