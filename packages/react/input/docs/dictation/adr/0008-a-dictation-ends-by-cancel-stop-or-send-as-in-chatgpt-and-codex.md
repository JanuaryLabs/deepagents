# A dictation ends by cancel, stop or send, as in ChatGPT and Codex

Status: ruled by Ezz on 2026-11-20 ("we need to follow chatgpt/codex app"; shipped).

## Context

The copies end a dictation one way: the second click stops the recording, and the text goes into the composer. A send during the transcription sends the draft without the words, and the words then land in the next draft: at once in text2sql, whose composers are never disabled, and after the post in blackboard, whose composer is disabled while it posts (`apps/web/src/routes/ChatBot/ChatComposer.tsx:64`) and holds the transcript until then.

The ChatGPT desktop app 26.1111.21308 (the Codex Electron app) ends a dictation three ways. Its controls call one function with `"abort"`, `"insert"` or `"send"` (`webview/assets/async/636082.*.js`):

| End      | Its labels                                                                                           | What it does                                                                |
| -------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `abort`  | "Cancel dictation"; "Cancel transcription" while transcribing; "Starting dictation; click to cancel" | drops the clip, or the transcription in flight                              |
| `insert` | "Stop dictation"; Esc "stops dictation and keeps the text"                                           | transcribes and puts the text in the composer                               |
| `send`   | "Transcribe and send"; "Finish dictation and send"; "Send dictated message"                          | stops the recording, transcribes the audio, and sends the resulting message |

Once an end is pending, the stop control is disabled. The send stays enabled while an `insert` is pending and is disabled while a `send` is pending. Its analytics name the same ends (`CHATGPT_DICTATION_END_ACTION_SEND_PROMPT`, `…_INSERT_TRANSCRIPT`, `…_CANCEL`) and two cancel reasons (`…_CANCELLED_RECORDING`, `…_CANCELLED_TRANSCRIPTION`).

## Decision

- `Composer.Dictate` starts a dictation, and in `recording` it stops it with the end `insert`.
- `Composer.CancelDictation` ends it with `abort` in `starting`, `recording` and `finishing`.
- The composer's submit (`actions.submit`, which `Composer.Submit` calls, `Composer.tsx:2216-2218`) ends an active dictation with `send`: it stops the recording, waits for the text, inserts it (ADR 0006), and then submits the draft. A submit during `finishing` with the end `insert` changes the end to `send`. A submit during the end `send` does nothing. A submit during `starting` cancels the start and submits the draft as it is, because nothing is recorded yet.
- When the transcription fails during the end `send`, the draft is not sent, and the state is `failed`.

## Consequences

- No send can overtake a transcription, so the words always join the message that the user meant.
- Cancel is now part of the first release, not later.
- When the host disables the composer during a dictation (not through its submit), the dictation ends with `abort`, so no text appears in a composer that the host disabled (ruled by Ezz on 2026-11-20; ChatGPT's code was not read for this case).
- Later, from the same app: "Retry transcription" (the clip is kept after a failure), press-and-hold (`CHATGPT_DICTATION_START_GESTURE_PRESS_AND_HOLD`), and sending the recording itself to a model that takes audio (Codex's `isDictationRecording` attachments).
