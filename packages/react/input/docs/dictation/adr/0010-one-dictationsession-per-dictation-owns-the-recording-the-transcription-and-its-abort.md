# One DictationSession per dictation owns the recording, the transcription and its abort

Status: ruled by Ezz on 2026-11-25 (deepagents #5658). It replaces [ADR 0005](./0005-the-composer-owns-the-pending-request-through-useactionstate.md).

## Context

The first composer split one dictation across four owners. A `Recording` class held the stream and the recorder. `useActionState` held the transcription and its failure. An `abortRef` held the transcription's `AbortController`. A `latestRef` held the newest `transcribe`, `insertTranscript` and `submitDraft`, and an `attempt` counter kept the failure of an old attempt from showing on a new one. `currentState()` merged the recording's snapshot, the action's `isPending` and its result into one state.

Each owner was there to answer one question: is this result still for the dictation on screen? A plain field (ADR 0009) would need the same four.

## Considered options

- **Keep the four, and move them into `useDictation`.**
- **One `DictationSession` object per attempt.** This option was selected.

## Decision

- `DictationSession.start(transcribe)` makes one session per attempt. The click handler calls it, with the `transcribe` of that render. The session owns the `MediaStream`, the `MediaRecorder`, the transcription call, its failure, and one `AbortController` that covers the recording's listeners and the transcription's `signal`.
- Its snapshot is `starting`, `recording`, `finishing`, `ended` or `failed`, read with `useSyncExternalStore`. `useDictation` maps it to `DictationState`, with `unavailable` from the browser and the microphone permission (`MicrophonePermission`, unchanged).
- The transcript reaches the host's newest `onTranscript` through `useEffectEvent`, called from the session's transcript subscription inside a `useEffect` (React's connection-event pattern). The effect's cleanup also cancels the session, so an unmount ends it with `abort`; a second effect cancels it when `disabled` turns true.
- The error codes and the `getUserMedia` error mapping stay as in ADR 0004 and the README.

## Consequences

- `latestRef`, `abortRef`, the `attempt` counter, `useActionState` and the merge in `currentState()` go. A new attempt is a new object, so a stale result cannot reach it: an aborted session ignores its own late result.
- `useDictationController` and `Recording` go; `useDictation` and the composer's `useComposerDictationController` read the same sessions.
- The composer keeps its end (`insert` or `send`) in its own state, and its `onTranscript` reads the newest one through the effect event. A submit is a discrete event, so React commits the new end before the transcription's result can arrive.
- A throw from the host's `onTranscript` still ends the session at `failed` with `transcription-failed`, as the composer's insert and submit did inside the action.
