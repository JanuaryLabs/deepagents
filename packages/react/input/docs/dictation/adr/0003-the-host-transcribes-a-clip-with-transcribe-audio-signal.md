# The host transcribes a clip with transcribe(audio, { signal })

Status: ruled by Ezz on 2026-11-20 (design for review).

## Context

The hosts choose where the clip goes and which model hears it: text2sql picks the space's transcription model, its v2 app a fixed model, and blackboard OpenRouter. Each of the five server routes (three in text2sql, one in datahub, one in blackboard) takes the audio and answers `{ text }`. The AI SDK's `transcribe()` gives a result with `text`.

Both copies call `transcribe(audio)` with no signal. When the composer unmounts during a request, the request goes on, and the copies then call `onTranscription` for a composer that is gone.

## Considered options

- **A URL that the part uploads to**, as CopilotKit's `transcribeAudioUrl`. The part would then own the request's format, its headers and its errors, and the hosts send `spaceId` and their own auth.
- **assistant-ui's session**: `listen()` gives a session with `stop`, `cancel` and speech events. It also fits the browser's live recognition, but no consumer streams.
- **`transcribe(audio, { signal }) => Promise<{ text }>`.** This option was selected.

## Consequences

- The part aborts the signal when it unmounts. An abort from its own signal ends at `idle`, not at `failed`.
- The hosts keep their typed clients: `(audio, { signal }) => api.transcribe({ audio, spaceId, signal })`.
- A streaming transport is later. It would be a second prop shape, so that a batch host never sees its events.
