# Dictation glossary

> **Design for review.** These words belong to the design in [README.md](./README.md).

**Dictation.** The user speaks, and the text goes into the composer. Here it is batch: one recording, then one transcription. assistant-ui uses the same word for its composer parts.

**Recording.** One clip from the microphone, from a start click to a stop click. The `Recording` class owns the `MediaStream` and the `MediaRecorder` of one recording, and React reads it through `useSyncExternalStore`.

**Clip.** The `Blob` that a recording gives. Its type is the `mimeType` that the browser recorded.

**Transport.** The host's `transcribe(audio, { signal })` function. It sends the clip where the host chooses and gives `{ text }`. The part never knows the endpoint or the model.

**Transcription.** One call of the transport, from the clip to the text. It is pending while the state is `transcribing`.

**Dictation state.** The `DictationState` union that the part gives to its render function and puts on its element as `data-status`. It is local to the part.

**Unavailable.** Dictation cannot start in this browser: no `MediaRecorder` (`unsupported`), or the microphone permission is `denied` (`blocked`). A host that does not offer dictation at all does not render the part; that is not unavailable.

**Insertion.** The composer puts the transcribed text at the cursor, with a space before it when the character before the cursor is not whitespace. A text that arrives while the composer is disabled waits for it.

**Start and stop.** A click in `idle` or `failed` starts a recording; a click in `recording` stops it. `disabled` refuses a start and never a stop.
