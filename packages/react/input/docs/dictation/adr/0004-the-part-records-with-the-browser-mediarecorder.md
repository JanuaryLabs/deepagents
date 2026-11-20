# The part records with the browser's MediaRecorder

Status: ruled by Ezz on 2026-11-20 (design for review).

## Context

Both copies record through `react-media-recorder` 1.7.2. It brings 25 packages beside React (`extendable-media-recorder` and a WAV encoder among them). It builds the clip with `Object.assign({ type: chunk.type }, blobPropertyBag)`, and both copies pass `{ type: 'audio/webm' }`, so the clip is labeled `audio/webm` whatever the browser recorded. blackboard's route reads that label to pick the audio format.

The copies drive it from an effect. A `VoiceRecorderController` turns command ids into `startRecording` and `stopRecording` calls, and a `suppressStopRef` keeps React Strict Mode's second mount from dropping every clip.

## Considered options

- **Keep `react-media-recorder`.**
- **The browser's `MediaRecorder`, in a small `Recording` class that React reads with `useSyncExternalStore`.** This option was selected.

## Decision

The click handler makes the `Recording`. Strict Mode mounts components twice, not click handlers, so a second recorder is never made, and the command ids and `suppressStopRef` go. The clip's type is `recorder.mimeType`, the type that was recorded.

## Consequences

- `react-media-recorder` leaves the dependencies.
- The `Recording` stops its tracks when it ends, so the browser's microphone indicator goes off.
- The part targets the browsers that `@deepagents/react-input` supports (backlog #4861 declares its baseline). A browser without `MediaRecorder` gives `unavailable`, `unsupported`.
