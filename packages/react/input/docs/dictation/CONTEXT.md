# Dictation glossary

> **Design for review.** These words belong to the design in [README.md](./README.md).

**Dictation.** The user speaks, and the text goes into the composer. Here it is batch: one recording, then one transcription. ChatGPT, Codex and assistant-ui use the same word.

**Recording.** One clip from the microphone, from a start to an end. The `Recording` class owns the `MediaStream` and the `MediaRecorder` of one recording, and the composer reads it through `useSyncExternalStore`.

**Clip.** The `Blob` that a recording gives. Its type is the `mimeType` that the browser recorded.

**Transport.** The host's `transcribe(audio, { signal })`, given to `Composer.Root` as `dictation.transcribe`. It sends the clip where the host chooses and gives `{ text }`. The composer never knows the endpoint or the model.

**Transcription.** One call of the transport, from the clip to the text.

**End.** How a dictation finishes: `abort` (the clip or the transcription is dropped), `insert` (the text goes in at the cursor) or `send` (the text goes in, then the draft is submitted). The names are ChatGPT's and Codex's.

**Finishing.** The status from the end of a recording to the end of its transcription. It carries the end that will follow.

**Dictation state.** The `DictationState` union that the composer holds, one dictation at a time. `useComposerDictation` reads it, and the parts put it on their element as `data-status`.

**Unavailable.** Dictation cannot start in this browser: no `MediaRecorder` (`unsupported`), or the microphone permission is `denied` (`blocked`). A host that does not offer dictation at all passes no `dictation`; that is not unavailable.

**Insertion.** The composer puts the transcribed text at the cursor, with a space before it when the character before the cursor is not whitespace.
