# Dictation in the composer

> **Design for review.** No code exists yet. This folder is the API on paper of `Composer.Dictate` in `@deepagents/react-input/browser` and of `ChatComposer.Dictate` in `@deepagents/react-genai`. Each decision has an ADR in [`adr/`](./adr). The words have one meaning each; see [CONTEXT.md](./CONTEXT.md). Backlog #4920 holds the history and the rulings.

The user presses a button, speaks, and presses it again. The composer records the clip, the host transcribes it, and the composer puts the text at the cursor.

Two copies of this code exist today: text2sql `packages/genui/voice` and blackboard `packages/voice` (its ledger: `packages/voice/docs/copied-from-text2sql.md`). Both are `@genui/voice` 0.1.0. They move here after the two apps use `@deepagents/react-input` (backlog #3158).

## Dictate into a composer

```tsx
import { Composer } from '@deepagents/react-input/browser';

<Composer.Root onSubmit={send}>
  <Composer.Editor />
  <Composer.Toolbar>
    <Composer.Dictate
      transcribe={(audio, { signal }) =>
        api.transcribe({ audio, spaceId, signal })
      }
      render={(props, dictation) => (
        <button {...props} aria-label={labelFor(dictation)}>
          {iconFor(dictation)}
        </button>
      )}
    />
  </Composer.Toolbar>
</Composer.Root>;
```

`Composer.Dictate` has no words and no icons. The host maps the [dictation state](#the-dictation-state) to its own. When the host does not offer dictation (the space has no transcription model), it does not render the part.

## Dictate into an agent chat

```tsx
import { ChatComposer } from '@deepagents/react-genai';

<ChatComposer.Toolbar>
  <ChatComposer.Dictate
    transcribe={(audio, { signal }) =>
      api.transcribe({ audio, spaceId, signal })
    }
  />
</ChatComposer.Toolbar>;
```

`ChatComposer.Dictate` is `Composer.Dictate` with the chat kit's look, as `ChatComposer.AttachFiles` is for `Composer.AttachFiles`: a `ChatActionButton`, lucide icons and English labels. It refuses a new recording while `useAgentStatus()` is `streaming` or `submitted`. An app that wants other words composes `Composer.Dictate` itself.

## Block a new recording

```tsx
<Composer.Dictate transcribe={transcribe} disabled={agentBusy} />
```

`disabled` refuses a start and never a stop: a recording in progress can always end. A disabled `Composer.Root` refuses a start too.

## Signatures

```ts
// @deepagents/react-input/browser
type ComposerDictateProps = Omit<
  ComposerActionTriggerProps,
  'render' | 'onClick'
> & {
  transcribe: (
    audio: Blob,
    options: { signal: AbortSignal },
  ) => Promise<{ text: string }>;
  disabled?: boolean;
  render?:
    | React.ReactElement
    | ((
        props: React.HTMLAttributes<HTMLElement>,
        state: DictationState,
      ) => React.ReactElement);
};

type DictationState =
  | { status: 'unavailable'; reason: 'unsupported' | 'blocked' }
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'stopping' }
  | { status: 'transcribing' }
  | { status: 'failed'; error: DictationError };

class DictationError extends Error {
  readonly code:
    | 'permission-denied'
    | 'no-microphone'
    | 'microphone-in-use'
    | 'interrupted'
    | 'transcription-failed';
}

// @deepagents/react-genai
type ChatComposerDictateProps = Pick<ComposerDictateProps, 'transcribe'>;
```

The rendered element also carries the state as attributes: `data-status` (`unavailable`, `idle`, …), `aria-pressed` while recording, and `disabled` when a click can do nothing.

## The dictation state

| Status         | Means                                                                                               | A click                |
| -------------- | --------------------------------------------------------------------------------------------------- | ---------------------- |
| `unavailable`  | `unsupported`: the browser has no `MediaRecorder`. `blocked`: the microphone permission is `denied` | does nothing           |
| `idle`         | ready                                                                                               | starts a recording     |
| `starting`     | the browser is opening the microphone                                                               | does nothing           |
| `recording`    | the clip is being recorded                                                                          | stops it               |
| `stopping`     | the recorder is closing the clip                                                                    | does nothing           |
| `transcribing` | the host's `transcribe` is pending                                                                  | does nothing           |
| `failed`       | the last recording or request failed; `error.code` says how                                         | starts a new recording |

## What each call does underneath

| Call                          | Underneath                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The part mounts               | It checks for `MediaRecorder` and queries the `microphone` permission once, and it follows the permission's `change` event. No microphone opens.                                                                                                                                 |
| A click in `idle` or `failed` | `navigator.mediaDevices.getUserMedia({ audio: true })`, then `new MediaRecorder(stream).start()`. The state goes `starting`, then `recording`. The `Recording` is made in the click handler, not in an effect.                                                                   |
| A click in `recording`        | `recorder.stop()`. The state is `stopping` until the recorder's `stop` event. The clip is `new Blob(chunks, { type: recorder.mimeType })`, the type the browser really recorded. The tracks stop, so the browser's microphone indicator goes off.                                |
| The clip is ready             | The part calls `transcribe(clip, { signal })` inside a transition. The state is `transcribing`.                                                                                                                                                                                  |
| `transcribe` gives `{ text }` | The text is trimmed. An empty text ends at `idle`. Otherwise the composer inserts it at the cursor, with a space before it when the character before the cursor is not whitespace. When the composer is disabled, the text waits and goes in when the composer is enabled again. |
| `transcribe` rejects          | An `AbortError` from the part's own signal ends at `idle`. Any other rejection ends at `failed` with `transcription-failed`, and the rejection is the error's `cause`.                                                                                                           |
| The part unmounts             | The recorder stops without a transcription, the tracks stop, and the signal aborts.                                                                                                                                                                                              |

## Errors

`DictationError` is the one error class. Each code leads the user to the same next step, "show it and let them try again", so one class with a `code` is enough.

| `code`                 | Comes from                                                          |
| ---------------------- | ------------------------------------------------------------------- |
| `permission-denied`    | `getUserMedia` rejects with `NotAllowedError`                       |
| `no-microphone`        | `getUserMedia` rejects with `NotFoundError`                         |
| `microphone-in-use`    | `getUserMedia` rejects with `NotReadableError`                      |
| `interrupted`          | the recorder fires `error`, or the track ends before the user stops |
| `transcription-failed` | `transcribe` rejects with anything but the part's own abort         |

Any other `getUserMedia` rejection (a `TypeError` for bad constraints, a `SecurityError` outside a secure context) is a programming error and propagates.

## React APIs it uses

| API                                               | Replaces in the copies                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `useSyncExternalStore` over the `Recording` class | `VoiceRecorderController`: its command ids and the `suppressStopRef` that kept React Strict Mode from dropping the clip                   |
| `useActionState`                                  | The `isTranscribing` prop that each host kept in step with its request, and the separate error state                                      |
| `useEffectEvent`                                  | The latest-value refs: `transcribeRef` and `onTranscriptionRef` in the hook, `startRecordingRef` and `stopRecordingRef` in the controller |
| `ref` as a prop                                   | `forwardRef`                                                                                                                              |

## Moving the two copies

| `@genui/voice`                     | Here                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| `VoiceRecordButton`                | `Composer.Dictate`, or `ChatComposer.Dictate` for the chat kit's look |
| `useVoiceTranscription`            | none: the state lives in the part                                     |
| `enabled`                          | the host renders the part or does not                                 |
| `isTranscribing`                   | none: the part owns its request                                       |
| `onTranscription`                  | none: the composer inserts the text                                   |
| `renderButton({ icon, label, … })` | `render(props, state)`; the host picks the icon and the label         |
| `disabled` (blackboard)            | `disabled`                                                            |
| `transcribe(audio)`                | `transcribe(audio, { signal })`                                       |

## The same concept in other systems

| System                                                                         | Where dictation lives                                                                 | Transport                                                                                               | State                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| assistant-ui (`@assistant-ui/react` 0.15.37, `@assistant-ui/core` 0.3.37)      | Composer parts: `ComposerPrimitive.Dictate`, `.StopDictation`, `.DictationTranscript` | A `DictationAdapter` on the runtime: `listen()` gives a session with `stop`, `cancel` and speech events | `starting \| running \| ended{stopped \| cancelled \| error}` |
| CopilotKit (`@copilotkit/react-ui` 1.89.0)                                     | `usePushToTalk` in the chat                                                           | A URL, `transcribeAudioUrl`                                                                             | `pushToTalkState`                                             |
| AI Elements (`PromptInputSpeechButton`, copied into `@deepagents/react-genai`) | One button                                                                            | The browser's `SpeechRecognition`                                                                       | Booleans                                                      |

assistant-ui puts the adapter on its runtime because its composer reads every capability from a runtime. This composer has no runtime, and `Composer.AttachFiles` keeps its settings on the part ([ADR 0002](./adr/0002-composer-dictate-takes-the-transport-and-keeps-its-state.md)).

## Why not a package from npm

Node has no recorder: a search of the exports of every built-in module of Node 26.13 found none. The browser has `MediaRecorder`. The `@stdlib` scope has no audio package. The searches: "react voice recorder hook", "react dictation", "react speech to text transcribe hook", "whisper react hook" and "media recorder react".

| Package                      | Latest            | Weekly downloads | Why it does not do the job                                                                                                                                                                                                                              |
| ---------------------------- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@chengsokdara/use-whisper`  | 0.2.0, 2023-03-18 | 992              | It takes `onTranscribe(blob)`, but it does not install here: it needs `lamejs` from GitHub, and this npm configuration refuses git dependencies (`EALLOWGIT`). It has no error and no permission state, and it brings ffmpeg and axios.                 |
| `react-speech-recognition`   | 4.0.1, 2025-04-29 | 286,883          | The browser recognizes the speech. The host cannot pick the model, and the hosts pick it for each space.                                                                                                                                                |
| `react-audio-voice-recorder` | 2.2.0, 2023-09-19 | 43,225           | It only records, and it brings ffmpeg.                                                                                                                                                                                                                  |
| `react-media-recorder`       | 1.7.2, 2025-08-03 | 122,848          | It only records. Both copies use it today. It brings 25 packages beside React, and it labels the clip with the type that the caller passes, not the type that was recorded ([ADR 0004](./adr/0004-the-part-records-with-the-browser-mediarecorder.md)). |

## Who uses what

| Consumer                                                                              | Today               | After #3158 and this design                   |
| ------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------- |
| text2sql `apps/frontend`: ChatBot, Dashboards, SpaceDetailChatbot, Embed/EmbedChatbot | `VoiceRecordButton` | `ChatComposer.Dictate` or `Composer.Dictate`  |
| text2sql `apps/desktop/frontend`: ChatBot, Dashboards, SpaceDetailChatbot             | `VoiceRecordButton` | the same                                      |
| text2sql `apps/v2/frontend`: `ComposerVoiceButton`                                    | `VoiceRecordButton` | the same                                      |
| text2sql `packages/features/workspace`: ReportsView                                   | `VoiceRecordButton` | the same                                      |
| text2sql `packages/sdk/react`: LimerenceChat and its re-export                        | `VoiceRecordButton` | the same; backlog #4922 for its private peers |
| blackboard `apps/web`: ChatComposer                                                   | `VoiceRecordButton` | `Composer.Dictate`                            |

## Later and never

Later, each when a consumer needs it: a cancel that drops the clip, a maximum duration, the elapsed time, a state that other parts read (datahub's `InputBusyBoundary` hides other controls while recording), and a hook for a plain form field (Meddit's "Anything else relevant?").

Never: words or icons in `@deepagents/react-input`, and a part that picks the endpoint or the model.
