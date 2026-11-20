# Dictation is a capability of Composer.Root, and the host passes the transport there

Status: ruled by Ezz on 2026-11-20 (shipped). It replaces the first ruling of the same day, which kept the transport and the state in `Composer.Dictate`.

## Context

The first ruling counted the readers of the dictation state in the two copies: only the voice button read it. In text2sql, `transcribeAction.isPending` goes only to `VoiceRecordButton` (for example `apps/frontend/src/app/routes/ChatBot/ChatBot.tsx:752-758`), and in blackboard only `ChatVoiceButton` reads it. So the state stayed in the part.

Then Ezz set the bar: "we need to follow chatgpt/codex app". The ChatGPT desktop app 26.1111.21308 (an Electron app whose `package.json` is `openai-codex-electron`, so its code is the Codex app's too) has more readers:

- The send button. While a dictation records or transcribes, its label is "Transcribe and send", and its tooltip "Send dictated message" is described as "the button that stops recording, transcribes the audio, and sends the resulting message" (`webview/assets/async/636082.*.js`). The other composer of the app names the same action `finish-and-send` ("Finish dictation and send", `484572.*.js`).
- The queue. Codex's `canEnqueue` refuses while an attachment `isDictationRecording`.
- A command. `composer.toggleDictation` starts and stops a dictation from the keyboard, and Esc "stops dictation and keeps the text". Neither is a button.

assistant-ui configures dictation on its runtime for the same reason: its composer parts all read one dictation state.

## Considered options

- **Keep the state in `Composer.Dictate`, and disable the send while dictating.** It differs from ChatGPT and Codex: the user would wait, then press send again.
- **A `Composer.Dictation` part inside the root, around the controls.** A send button outside it could not read it.
- **A `dictation` prop on `Composer.Root`, and the state in the composer.** This option was selected.

## Decision

`<Composer.Root dictation={{ transcribe }}>` gives the composer the transport. The composer owns one dictation at a time. `Composer.Dictate`, `Composer.CancelDictation`, the composer's submit and `useComposerDictation` all read it.

The state is not a field of `ComposerState`. The composer's own actions and the host's props change `ComposerState`. Browser events change a recording, and a copy of a recording's state in `ComposerState` would need a sync and would be stale between the event and the sync, as `isTaskRunning` is for one render (`Composer.tsx:428-438`). The composer reads the recording through `useSyncExternalStore` instead (ADR 0004).

## Consequences

- `Composer.Dictate`, `Composer.CancelDictation` and `useComposerDictation` throw when the root has no `dictation`, as every part throws outside `Composer.Root` (`useComposerContext`, `ComposerContext.ts:66-72`).
- A host that does not offer dictation does not pass `dictation` and does not render the parts.
- Datahub's `InputBusyBoundary` (`packages/genai/src/lib/chat/agent.tsx:170`), which hides other controls while recording, needs only `useComposerDictation`.
