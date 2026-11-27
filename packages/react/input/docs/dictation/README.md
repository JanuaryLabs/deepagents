# Dictation

> Dictation in `@deepagents/react-input/browser`: `useDictation` and `Dictation` for any field, `Composer.Root`'s `dictation` for the composer, and `ChatComposer.Dictate` in `@deepagents/react-genai`. Dictation is its own primitive, and the composer is one consumer ([ADR 0009](./adr/0009-dictation-is-its-own-primitive-and-the-composer-is-one-consumer.md)). Each decision has an ADR in [`adr/`](./adr). The words have one meaning each; see [CONTEXT.md](./CONTEXT.md). Backlog #4920 holds the history and the rulings, and #5658 the plain field.
>
> **Tests.** `src/lib/ComposerDictation.test.tsx` and `src/lib/Dictation.test.tsx` cover what happy-dom runs for real: no `MediaRecorder` gives `unavailable`, a host's `start()` then does nothing, the parts throw outside their root, and `insertTranscript` on a real textarea. Everything that needs a microphone (the three ends, the composer's space rule, the errors of `getUserMedia`, the permission) has no test: Ezz ruled on 2026-11-20 against vitest browser mode and against a hand-written `MediaRecorder`. A React-controlled field's `onChange` has no test either: happy-dom 20.11.2 (and 21.0.4) writes `setRangeText` through the `value` setter, which React's value tracker watches, so React sees no change there; a browser writes the value natively, and React's `onChange` fires. That was checked once by hand on 2026-11-25 in Chromium (Playwright's chromium-1255): `setRangeText` and a bubbling `input` event on Meddit's controlled complaint input moved its React state (the matching chip turned pressed).

The user starts a dictation and speaks. A dictation into a plain field ends by cancel or stop. A dictation into the composer ends one of three ways, as in the ChatGPT and Codex desktop apps:

- **Cancel**: the clip, or the transcription in flight, is dropped.
- **Stop**: the host transcribes the clip, and the composer puts the text at the cursor.
- **Send**: the composer stops the recording, waits for the text, puts it in, and submits the draft ("Transcribe and send" in ChatGPT).

Two copies of the first two steps exist today: text2sql `packages/genui/voice` and blackboard `packages/voice` (its ledger: `packages/voice/docs/copied-from-text2sql.md`). Both are `@genui/voice` 0.1.0. They move here after the two apps use `@deepagents/react-input` (backlog #3158).

## Dictate into a plain field

```tsx
import { Dictation, insertTranscript } from '@deepagents/react-input/browser';

function Notes() {
  const [notes, setNotes] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <Dictation.Root
      transcribe={(audio, { signal }) => api.transcribe({ audio, signal })}
      onTranscript={(text) => {
        if (field.current) insertTranscript(field.current, text);
      }}
    >
      <textarea
        ref={field}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      <Dictation.Toggle
        render={(props, dictation) => (
          <button {...props} aria-label={labelFor(dictation)}>
            {iconFor(dictation)}
          </button>
        )}
      />
      <Dictation.Cancel render={<button aria-label="Cancel dictation" />} />
    </Dictation.Root>
  );
}
```

`insertTranscript` puts the text at the cursor with `setRangeText(…, 'end')`, with a space before it when the character before the cursor is not whitespace, and dispatches a bubbling `input` event, so a controlled field's `onChange` and an uncontrolled field's listeners both see the new value. It trims the text, and an empty text inserts nothing. A host that keeps its text elsewhere passes its own `onTranscript`.

Without the parts, `useDictation` gives the same `{ state, start, stop, cancel }`:

```tsx
const { state, start, stop, cancel } = useDictation({
  transcribe,
  onTranscript: (text) => {
    if (field.current) insertTranscript(field.current, text);
  },
});
```

## Dictate into a composer

```tsx
import { Composer } from '@deepagents/react-input/browser';

<Composer.Root
  onSubmit={send}
  dictation={{
    transcribe: (audio, { signal }) =>
      api.transcribe({ audio, spaceId, signal }),
  }}
>
  <Composer.Editor />
  <Composer.Toolbar>
    <Composer.Dictate
      render={(props, dictation) => (
        <button {...props} aria-label={labelFor(dictation)}>
          {iconFor(dictation)}
        </button>
      )}
    />
    <Composer.CancelDictation
      render={<button aria-label="Cancel dictation" />}
    />
    <Composer.Submit render={<SendButton />} />
  </Composer.Toolbar>
</Composer.Root>;
```

The react-input parts have no words and no icons. The host maps the [dictation state](#the-dictation-state) to its own. A host that does not offer dictation (the space has no transcription model) passes no `dictation` and renders neither part.

## Send while dictating

Nothing extra. While a dictation is active, the composer's submit ends it with `send` (`Composer.Submit` calls `actions.submit`, `Composer.tsx:2216-2218`; the Enter key must reach the same path): the words join the message, and then the message goes. A send button that wants to say so reads the state:

```tsx
function SendButton(props: React.ComponentProps<'button'>) {
  const { state } = useComposerDictation('SendButton');
  const dictating =
    state.status === 'recording' || state.status === 'finishing';
  return (
    <button {...props}>{dictating ? 'Transcribe and send' : 'Send'}</button>
  );
}
```

## Dictate into an agent chat

```tsx
import { ChatComposer } from '@deepagents/react-genai';

<ChatComposer.Provider dictation={{ transcribe }}>
  …
  <ChatComposer.Toolbar>
    <ChatComposer.Dictate />
  </ChatComposer.Toolbar>
</ChatComposer.Provider>;
```

`ChatComposer.Dictate` renders `Composer.Dictate` and, while a dictation is active, `Composer.CancelDictation`, with the chat kit's `ChatActionButton` and lucide icons, as `ChatComposer.AttachFiles` does for `Composer.AttachFiles`. It takes no props. Its labels are the `dictation.*` keys of react-genai's `GenaiMessagesProvider`, English unless the host gives its own. It refuses a new dictation while `useAgentStatus()` is `streaming` or `submitted`.

## Start and stop from the keyboard

```tsx
const { state, start, stop, cancel } =
  useComposerDictation('DictationShortcut');
```

Codex binds `composer.toggleDictation` to a key, and Esc stops a dictation and keeps the text. A host binds its own keys to `start`, `stop` and `cancel`.

## Signatures

```ts
// @deepagents/react-input/browser
function useDictation(options: DictationOptions): DictationApi;

type DictationOptions = {
  transcribe: (
    audio: Blob,
    options: { signal: AbortSignal },
  ) => Promise<{ text: string }>;
  onTranscript: (text: string) => void;
  disabled?: boolean; // true refuses a start and ends an active dictation with abort
};

type DictationApi = {
  state: DictationState;
  start(): void;
  stop(): void;
  cancel(): void;
};

type DictationState =
  | { status: 'unavailable'; reason: 'unsupported' | 'blocked' }
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'finishing' }
  | { status: 'failed'; error: DictationError };

const Dictation: {
  Root(
    props: DictationOptions & { children: React.ReactNode },
  ): React.ReactNode;
  Toggle(props: DictationToggleProps): React.ReactNode;
  Cancel(props: DictationCancelProps): React.ReactNode;
};
function useDictationContext(componentName: string): DictationApi;

function insertTranscript(
  field: HTMLTextAreaElement | HTMLInputElement,
  text: string,
): void;

type ComposerRootProps = {
  // … the props of today
  dictation?: ComposerDictation;
};

type ComposerDictation = {
  transcribe: (
    audio: Blob,
    options: { signal: AbortSignal },
  ) => Promise<{ text: string }>;
};

type ComposerDictationState =
  | Exclude<DictationState, { status: 'finishing' }>
  | { status: 'finishing'; end: 'insert' | 'send' };

class DictationError extends Error {
  readonly code:
    | 'permission-denied'
    | 'no-microphone'
    | 'microphone-in-use'
    | 'interrupted'
    | 'transcription-failed';
}

function useComposerDictation(componentName?: string): {
  state: ComposerDictationState;
  start(): void;
  stop(): void;
  cancel(): void;
};

type ComposerDictateProps = Omit<
  ComposerActionTriggerProps,
  'render' | 'onClick'
> & {
  disabled?: boolean;
  render?:
    | React.ReactElement
    | ((
        props: React.HTMLAttributes<HTMLElement>,
        state: ComposerDictationState,
      ) => React.ReactElement);
};
type ComposerCancelDictationProps = ComposerDictateProps;
// DictationToggleProps and DictationCancelProps: the same, with DictationState

// @deepagents/react-genai: ChatComposer.Dictate takes no props.
```

`Dictation.Toggle`, `Dictation.Cancel` and `useDictationContext` throw outside `Dictation.Root`. `Composer.Dictate`, `Composer.CancelDictation` and `useComposerDictation` throw when the root has no `dictation`, as every part throws outside `Composer.Root`. `Composer.Dictate` and `Composer.CancelDictation` are `Dictation.Toggle` and `Dictation.Cancel` (one implementation, `src/lib/dictation/DictationButtons.tsx`) with the composer's state, its root's `disabled`, and `data-end`. The parts are Base UI `Button`s like the other action triggers, and they carry the state as attributes: `data-status` (`unavailable`, `idle`, …), `data-end` while the composer finishes, `aria-pressed` while recording, and `disabled` when a click can do nothing.

## The dictation state

In a plain field:

| Status        | Means                                                                               | `Dictation.Toggle` | `Dictation.Cancel` |
| ------------- | ----------------------------------------------------------------------------------- | ------------------ | ------------------ |
| `unavailable` | `unsupported`: no `MediaRecorder`. `blocked`: the microphone permission is `denied` | disabled           | disabled           |
| `idle`        | ready                                                                               | starts             | disabled           |
| `starting`    | the browser opens the microphone                                                    | disabled           | ends with `abort`  |
| `recording`   | the clip is being recorded                                                          | ends with `insert` | ends with `abort`  |
| `finishing`   | the clip closes and the host transcribes it; `onTranscript` gets the text           | disabled           | ends with `abort`  |
| `failed`      | the last dictation failed; `error.code` says how                                    | starts again       | disabled           |

`disabled` on `Dictation.Toggle` or `Dictation.Root` refuses a start and never an end; `disabled` on the root also ends an active dictation with `abort`.

In the composer:

| Status                | Means                                                                               | `Composer.Dictate` | `Composer.CancelDictation`         | Submit                                                           |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------ | ---------------------------------- | ---------------------------------------------------------------- |
| `unavailable`         | `unsupported`: no `MediaRecorder`. `blocked`: the microphone permission is `denied` | disabled           | disabled                           | submits the draft                                                |
| `idle`                | ready                                                                               | starts             | disabled                           | submits the draft                                                |
| `starting`            | the browser opens the microphone                                                    | disabled           | ends with `abort`                  | cancels the start and submits the draft: nothing is recorded yet |
| `recording`           | the clip is being recorded                                                          | ends with `insert` | ends with `abort`                  | ends with `send`                                                 |
| `finishing`, `insert` | the clip closes and the host transcribes it                                         | disabled           | ends with `abort`                  | changes the end to `send`                                        |
| `finishing`, `send`   | the same, and the draft goes when the text is in                                    | disabled           | ends with `abort`; nothing is sent | disabled                                                         |
| `failed`              | the last dictation failed; `error.code` says how                                    | starts again       | disabled                           | submits the draft                                                |

`disabled` on `Composer.Dictate` refuses a start and never an end. A disabled `Composer.Root` refuses a start too.

## What each call does underneath

| Call                                                                  | Underneath                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A root (`Dictation.Root`, or `Composer.Root` with `dictation`) mounts | It checks for `MediaRecorder` and queries the `microphone` permission once, and it follows the permission's `change` event. No microphone opens.                                                                                                                                                                                                                                     |
| `start()` (a click or a command)                                      | A new `DictationSession` with the `transcribe` of that render ([ADR 0010](./adr/0010-one-dictationsession-per-dictation-owns-the-recording-the-transcription-and-its-abort.md)): `navigator.mediaDevices.getUserMedia({ audio: true })`, then `new MediaRecorder(stream).start()`. The state goes `starting`, then `recording`. Only event handlers call `start()`, never an effect. |
| An end of `insert` or `send`                                          | `recorder.stop()`. The state is `finishing` (in the composer, with that end). On the recorder's `stop` event, the clip is `new Blob(chunks, { type: recorder.mimeType })`, the tracks stop, and the session calls `transcribe(clip, { signal })` with its own signal.                                                                                                                |
| `transcribe` gives `{ text }`                                         | The session gives the text to the host's latest `onTranscript`. The composer's `onTranscript` trims it; a non-empty text goes in at the cursor, with a space before it when the character before the cursor is not whitespace, and with the end `send` the composer then submits the draft. The state goes `idle`.                                                                   |
| `transcribe` rejects                                                  | An `AbortError` from the session's own signal ends at `idle`. Any other rejection ends at `failed` with `transcription-failed`, its `cause` the rejection. With the end `send`, the draft is not sent.                                                                                                                                                                               |
| An end of `abort`                                                     | The session's one `AbortController` aborts. In `starting` or `recording`, the recorder stops and the clip is dropped. In `finishing`, the transcription's signal aborts, and nothing goes in or is sent. The state goes `idle`.                                                                                                                                                      |
| The host disables the root during a dictation                         | The dictation ends with `abort` (ADR 0008).                                                                                                                                                                                                                                                                                                                                          |
| The root unmounts                                                     | As `abort`.                                                                                                                                                                                                                                                                                                                                                                          |

## The space rule

The space rule has two copies: `insertTranscript` in `src/lib/Composer.tsx` (the editor) and `src/lib/dictation/insertTranscript.ts` (a plain field). That is strike 2 of the Rule of Three; the ledger is [copied-space-rule.md](./copied-space-rule.md). Mirror every fix in both files.

## Errors

`DictationError` is the one error class. Each code leads the user to the same next step, "show it and let them try again", so one class with a `code` is enough.

| `code`                 | Comes from                                                      |
| ---------------------- | --------------------------------------------------------------- |
| `permission-denied`    | `getUserMedia` rejects with `NotAllowedError`                   |
| `no-microphone`        | `getUserMedia` rejects with `NotFoundError`                     |
| `microphone-in-use`    | `getUserMedia` rejects with `NotReadableError`                  |
| `interrupted`          | the recorder fires `error`, or the track ends before an end     |
| `transcription-failed` | `transcribe` rejects with anything but the composer's own abort |

Any other `getUserMedia` rejection (a `TypeError` for bad constraints, a `SecurityError` outside a secure context) is a programming error and propagates.

## React APIs it uses

| API                                                                                  | Replaces in the copies                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSyncExternalStore` over the `DictationSession` class                             | `VoiceRecorderController`: its command ids and the `suppressStopRef` that kept React Strict Mode from dropping the clip; and the `isTranscribing` prop that each host kept in step with its request, with the separate error state (the session owns the transcription and its failure, ADR 0010) |
| `useEffectEvent`, called from the session's transcript subscription in a `useEffect` | The latest-value refs of the copies (and of the first composer) for `onTranscription`: the transcript reaches the host's newest `onTranscript`                                                                                                                                                    |
| The click handler makes the session                                                  | The `startRecordingRef` and `stopRecordingRef` of the controller                                                                                                                                                                                                                                  |
| `ref` as a prop                                                                      | `forwardRef`                                                                                                                                                                                                                                                                                      |

## Moving the two copies

| `@genui/voice`                                                 | Here                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `VoiceRecordButton`                                            | `Composer.Dictate` and `Composer.CancelDictation`, or `ChatComposer.Dictate` for the chat kit's look                 |
| `useVoiceTranscription`                                        | `useComposerDictation`                                                                                               |
| `transcribe(audio)`                                            | `Composer.Root`'s `dictation.transcribe(audio, { signal })`                                                          |
| `enabled`                                                      | the host passes `dictation` or not                                                                                   |
| `isTranscribing`                                               | none: the dictation session owns its request                                                                         |
| `onTranscription`                                              | none in the composer, which inserts the text; `onTranscript` of `useDictation` or `Dictation.Root` for a plain field |
| `renderButton({ icon, label, … })`                             | `render(props, state)`; the host picks the icon and the label                                                        |
| `disabled` (blackboard)                                        | `disabled` on `Composer.Dictate`                                                                                     |
| a send during a transcription sent the draft without the words | the send waits for the words                                                                                         |

## The same concept in other systems

| System                                                                                            | Where dictation lives                                                                                                    | Ends                      | Transport                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| ChatGPT and Codex desktop app 26.1111.21308 (`openai-codex-electron`)                             | The composer: the dictation controls, the send button ("Transcribe and send") and the `composer.toggleDictation` command | `abort`, `insert`, `send` | the app's own service                                                                                   |
| assistant-ui (`@assistant-ui/react` 0.15.37, `@assistant-ui/core` 0.3.37)                         | Composer parts: `ComposerPrimitive.Dictate`, `.StopDictation`, `.DictationTranscript`                                    | stop, cancel              | a `DictationAdapter` on the runtime: `listen()` gives a session with `stop`, `cancel` and speech events |
| CopilotKit (`@copilotkit/react-ui` 1.89.0)                                                        | `usePushToTalk` in the chat                                                                                              | push to talk              | a URL, `transcribeAudioUrl`                                                                             |
| AI Elements (`PromptInputSpeechButton`; `@deepagents/react-genai` dropped its unused copy, #4953) | One button                                                                                                               | toggle                    | the browser's `SpeechRecognition`                                                                       |

## Why not a package from npm

Node has no recorder: a search of the exports of every built-in module of Node 26.13 found none. The browser has `MediaRecorder`. The `@stdlib` scope has no audio package. The searches: "react voice recorder hook", "react dictation", "react speech to text transcribe hook", "whisper react hook" and "media recorder react".

| Package                      | Latest            | Weekly downloads | Why it does not do the job                                                                                                                                                                                                                                  |
| ---------------------------- | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@chengsokdara/use-whisper`  | 0.2.0, 2023-03-18 | 992              | It takes `onTranscribe(blob)`, but it does not install here: it needs `lamejs` from GitHub, and this npm configuration refuses git dependencies (`EALLOWGIT`). It has no error and no permission state, and it brings ffmpeg and axios.                     |
| `react-speech-recognition`   | 4.0.1, 2025-04-29 | 286,883          | The browser recognizes the speech. The host cannot pick the model, and the hosts pick it for each space.                                                                                                                                                    |
| `react-audio-voice-recorder` | 2.2.0, 2023-09-19 | 43,225           | It only records, and it brings ffmpeg.                                                                                                                                                                                                                      |
| `react-media-recorder`       | 1.7.2, 2025-08-03 | 122,848          | It only records. Both copies use it today. It brings 25 packages beside React, and it labels the clip with the type that the caller passes, not the type that was recorded ([ADR 0004](./adr/0004-the-composer-records-with-the-browser-mediarecorder.md)). |

## Who uses what

| Consumer                                                                                                                    | Uses                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Meddit `apps/web`: the New patient form's "What has been done so far?" field (Meddit #4936, 0374fb8 and 05d6d66)            | `Dictation.Root`, `Dictation.Toggle`, `Dictation.Cancel` and `insertTranscript` on a plain textarea (deepagents #5658), inside @zukhruf/shadcn's `InputGroup`. That group dims itself whenever it holds a `:disabled` element (`has-disabled`, from shadcn's base-nova), so the parts take Base UI's `focusableWhenDisabled` while the field is usable and the native `disabled` only while the field itself is disabled |
| blackboard `apps/web`: ChatComposer                                                                                         | `Composer.Root` `dictation`, `Composer.Dictate` and `Composer.CancelDictation`, with its own look; its send button says "Transcribe and send" while dictating (blackboard 780f88e, 6ada991)                                                                                                                                                                                                                              |
| text2sql: 10 sites (ChatBot, Dashboards, SpaceDetailChatbot, EmbedChatbot, ComposerVoiceButton, ReportsView, LimerenceChat) | its own `@genui/voice` copy: text2sql is no longer actively developed (Ezz, 2026-11-20), so it does not move                                                                                                                                                                                                                                                                                                             |

## Later and never

Later, each when a consumer needs it, most from the same ChatGPT and Codex app: "Retry transcription" (the clip is kept after a failure), press-and-hold, a maximum duration, the elapsed time, and sending the recording itself to a model that takes audio (Codex's `isDictationRecording` attachments).

Never: words or icons in `@deepagents/react-input`, and a composer that picks the endpoint or the model.
