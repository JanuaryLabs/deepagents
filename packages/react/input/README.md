# @deepagents/react-input

A headless chat composer for React: `Composer` and its parts, from `@deepagents/react-input/browser`. A host is the app that renders the composer. The host gives the look and the clock. `@deepagents/react-genai` gives the composer the look of its chat kit as `ChatComposer`.

## Install

```sh
npm i @deepagents/react-input @zukhruf/ui
```

The peer dependencies are `@zukhruf/ui` and `react` 19. Install `@zukhruf/ui` yourself. npm does not install it for you when `legacy-peer-deps` is set.

## Stylesheet

Import the stylesheet in the Tailwind CSS v4 file of the host, after Tailwind. Use a plain `@import` statement, without `layer()`:

```css
@import 'tailwindcss';
@import '@deepagents/react-input/styles.css';
```

The stylesheet names the built components of this package with `@source`, so Tailwind generates the classes they use. The host writes no `@source` for this package.

A host of `@deepagents/react-genai` imports `@deepagents/react-genai/styles.css` instead, which imports this stylesheet.

## The clock

`Composer` reads the time of a submission from `useClock` of `@zukhruf/ui`, which throws at its first render when no `ClockProvider` is above it. The composer renders inside the tree of the host, so this package gives no clock. The tree has one clock, and the host gives it.

The root of the host gives `globalThis`:

```tsx
import { ClockProvider } from '@zukhruf/ui';
import { createRoot } from 'react-dom/client';

createRoot(container).render(
  <ClockProvider clock={globalThis}>
    <App />
  </ClockProvider>,
);
```

A test gives `createClock()` of `@sinonjs/fake-timers`:

```tsx
import { createClock } from '@sinonjs/fake-timers';
import { ClockProvider } from '@zukhruf/ui';

const clock = createClock();

render(
  <ClockProvider clock={clock}>
    <Composer.Root
      editorAriaLabel="Message"
      submitFailedMessage="Could not send the message"
      onSubmit={onSubmit}
    >
      <Composer.Content>
        <Composer.Editor placeholder="Ask anything" />
      </Composer.Content>
    </Composer.Root>
  </ClockProvider>,
);
```

The host and this package must use the same copy of `@zukhruf/ui`. Each copy has its own React context, and a `ClockProvider` of one copy does not reach a `Composer` of the other. For this reason `@zukhruf/ui` is a peer dependency.

## Words

The parts ship no words ([ADR 0007](./docs/dictation/adr/0007-react-input-ships-no-words-or-icons-and-react-genai-ships-chatcomposer-dictate.md)). Each part that shows or announces text takes it as a required prop: `Composer.Root`'s `editorAriaLabel`, `submitFailedMessage`, `submitErrorMessage`, `unsupportedFileMessage`, `unknownCommandMessage`, `attachmentLabel`, `pastedTextLabel` and `missingAttachmentMessage` (and `expandedTextLimit`'s `message`, beside its `maxChars`), `Composer.Editor`'s `placeholder`, `Composer.Attachments`' `aria-label`, `removeLabel` and `removeIcon`, `Composer.Popup`'s `listboxLabel`, `noMatchesLabel` and `argsLabel`, `Composer.AttachFiles`' `inputLabel`, `Composer.Shortcuts`' `heading`, `closeLabel`, `groupTitles` and `descriptions`, `Composer.Footer`'s `draftHints`, `popupHints` and `reverseSearchHints`, and `PersistedPromptText`'s `skillIcon`. `submitErrorMessage(error)` gives the words for an `Error` that `onSubmit` rejects with, such as a failed upload, so its raw message stays off the page; `submitFailedMessage` is for any other rejection. `attachmentLabel({ media, number })` names an attachment wherever the user sees it: its token in the editor, its preview in `Composer.Attachments`, its row in `Composer.RemoteImages`, its remove button through `removeLabel(label)` and the alert of `missingAttachmentMessage({ label })`. `pastedTextLabel({ chars })` draws a pasted block in the editor. Only the drawing uses these words: the token text stays the identity, so the prompt the model reads, a copy, the stored draft and the history carry `[Image #N]` and `[Pasted Content N chars]`, and a send expands a paste to its text. `ChatComposer` of `@deepagents/react-genai` fills the ones it renders from its message catalog; it renders no `Composer.Shortcuts` or `Composer.Footer`, so a host that uses those passes their words itself.

## Accepted files

`Composer.Root`'s `acceptedMediaTypes` is the one list of the files the composer takes. `Composer.AttachFiles` offers it as its picker's `accept`, and a picked, pasted or dropped file must have one of its types. An entry is an exact type such as `image/png` or a whole family such as `image/*`, and only `image/`, `video/` and `audio/` types can be named. Any other file is refused with `unsupportedFileMessage`, and no attachment is added. A chat host passes the media types its server takes, such as the `mediaTypes` that the uploads capability of Zukhruf's discovery lists:

```tsx
<Composer.Root acceptedMediaTypes={discovery.capabilities.uploads.mediaTypes} {...words}>
```

Without the list, the composer takes any image, video or audio file, and a pasted or dropped file of another type becomes an `@name` mention, as a coding agent reads a file by its path. The picker still refuses such a file.

A submission carries its attached files in `files`, in placeholder order (`[Image #1]` first), so a host uploads them without reading `items`:

```tsx
<Composer.Root onSubmit={(submission) => send(submission.prompt, submission.files)} {...words}>
```

## Features

[COMPOSER_FEATURE_MATRIX.md](./COMPOSER_FEATURE_MATRIX.md) lists what the composer does and the contract of each feature.
