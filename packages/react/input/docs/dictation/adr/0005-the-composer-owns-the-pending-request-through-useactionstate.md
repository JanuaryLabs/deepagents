# The composer owns the pending request through useActionState

Status: the ownership was ruled by Ezz on 2026-11-20; `useActionState` is this design's choice (design for review).

## Context

Each host passes `isTranscribing`, the `isPending` of its own request, although the copy calls `transcribe` and holds that promise. blackboard keeps the prop in step by hand with `setTranscribing` in a `try`/`finally` (`apps/web/src/routes/ChatBot/ChatComposer.tsx:233-241`). Two sources of one fact can disagree.

The copies keep the latest `transcribe` and `onTranscription` in refs, so that a clip recorded after the props change uses the new ones.

## Decision

- The composer runs the request as the action of `useActionState`. Its `isPending` is the `finishing` status, and the state that the action gives is the failure. The `isTranscribing` prop goes.
- The composer calls the action in a transition, because the recorder's `stop` event is not one.
- `useEffectEvent` reads the latest `dictation.transcribe`, in place of the refs.

## Consequences

- A host passes only the transport.
- The action's `AbortController` aborts on a cancel and when the composer unmounts (ADR 0003).
