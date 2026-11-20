# Composer.Dictate takes the transport and keeps its state

Status: ruled by Ezz on 2026-11-20 (design for review).

## Context

assistant-ui configures dictation on its runtime: `ComposerPrimitive.Dictate` "requires a DictationAdapter to be configured in the runtime" (its own type declarations, 0.15.37). Its composer reads each capability from that runtime, so any part can see the dictation state.

This composer has no runtime. `Composer.AttachFiles` keeps its settings (`accept`, `multiple`) on the part.

Only the voice button reads the dictation state at every place that renders it. In text2sql, `transcribeAction.isPending` goes only to `VoiceRecordButton` (for example `apps/frontend/src/app/routes/ChatBot/ChatBot.tsx:752-758`). In blackboard, only `ChatVoiceButton` reads it. The one other reader is datahub's `InputBusyBoundary` (`packages/genai/src/lib/chat/agent.tsx:170`), and datahub is not a consumer.

## Considered options

- **A `dictation` prop on `Composer.Root`.** Any part could read the state. But `<Composer.Dictate />` under a root without the prop would type check and then fail at run time.
- **A required `transcribe` prop on `Composer.Dictate`, with the state local to the part.** This option was selected.

## Decision

The part is the lowest component that every reader of the state is in, so the state lives there. `transcribe` is required by the part's type, so a dictation without a transport cannot be written.

The data goes one way: the part reads the composer (cursor, insertion, disabled), and nothing reads the part.

## Consequences

- The state does not go into `ComposerState`. Each field there changes through the composer's own actions or a host prop. The recording changes through browser events, and a copy of it would need a sync and would be stale in between, as `isTaskRunning` is for one render (`Composer.tsx:428-438`).
- A state that other parts read (datahub's busy boundary) is later. It would come as a read of the part's state, not as a move of the transport.
