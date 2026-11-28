# @deepagents/react-genai

React components that render AI SDK chat flows, trajectories, tools, citations and interactive responses. A host is the app that renders these components. The host gives the transport, the tools and the clock.

## Install

```sh
npm i @deepagents/react-genai @zukhruf/ui @zukhruf/shadcn
```

The peer dependencies are `@zukhruf/shadcn`, `@zukhruf/ui`, `react` 19 and `react-dom` 19. Install `@zukhruf/shadcn` and `@zukhruf/ui` yourself. npm does not install them for you when `legacy-peer-deps` is set.

## Stylesheets

Import the stylesheets in the Tailwind CSS v4 file of the host, after Tailwind. Use plain `@import` statements, without `layer()`:

```css
@import 'tailwindcss';
@import '@zukhruf/shadcn/styles.css';
@import '@zukhruf/ui/styles.css';
@import '@deepagents/react-genai/styles.css';
```

`@deepagents/react-genai/styles.css` imports the stylesheet of `@deepagents/react-input` and names the built components of both packages and of Streamdown, which renders their Markdown, with `@source`, so Tailwind generates the classes they use. The host writes no `@source` for either package.

Import `TheButton` directly from `@zukhruf/ui`. This package does not export it.

## The clock

A component of this package that waits on a timer gets its clock from `useClock` of `@zukhruf/ui`, which throws at its first render when no `ClockProvider` is above it. These components wait: `AssistantSnapshot` (its `TheButton` and its copied label), `CodeBlockCopyButton`, `TipLine`, the copy buttons of a message, the spinner of a running tool, and `ChatComposer` (its `Composer` of `@deepagents/react-input` reads the clock for the time of a submission). They render inside the tree of the host, so this package gives no clock. The tree has one clock, and the host gives it.

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
    <AssistantSnapshot message={message} renderContent={renderContent} />
  </ClockProvider>,
);
```

## Words and languages

Every word the chat draws comes from one typed catalog, `GenaiMessages`. The package ships English (`en`). A host gives its own words on `GenaiMessagesProvider`, above the chat:

```tsx
import {
  type GenaiMessages,
  GenaiMessagesProvider,
} from '@deepagents/react-genai';

const ar: Partial<GenaiMessages> = {
  'message.copy': 'انسخ الرسالة',
  'composer.send': 'أرسل الطلب',
  'steps.tools': ({ count, status }, { plural }) =>
    status === 'complete'
      ? plural(count, {
          zero: 'لم تعمل أي أداة',
          one: 'عملت أداة واحدة',
          two: 'عملت أداتان',
          few: 'عملت # أدوات',
          many: 'عملت # أداة',
          other: 'عملت # أداة',
        })
      : plural(count, {
          one: 'عملت أداة واحدة وتوقفت',
          two: 'عملت أداتان وتوقفتا',
          few: 'عملت # أدوات وتوقفت',
          other: 'عملت # أداة وتوقفت',
        }),
  markdown: { copyTable: 'انسخ الجدول', downloadTable: 'نزّل الجدول' },
};

<GenaiMessagesProvider locale="ar" messages={ar}>
  <App />
</GenaiMessagesProvider>;
```

- A message is a string, or a function of its typed arguments and `{ plural, format, bytes }`. `plural(count, forms)` picks the form that `Intl.PluralRules` of the locale gives, needs `other`, and writes the count, formatted by `Intl.NumberFormat` of the locale, in place of `#`. `bytes(value)` writes a size in the largest decimal unit it fills (`5 MB`, `512 kB`), cut to one decimal so it never says more than the limit. A count sentence is one message, never pieces joined in code.
- A key the catalog leaves out keeps the English word.
- `markdown` holds streamdown's words (`StreamdownTranslations` of `streamdown`) for every `Response`. A `translations` prop on a `Response` wins over it, key by key.
- `dir` is the text direction of the locale (`Intl.Locale`) unless the host gives it. The provider hands it to Base UI's `DirectionProvider`, so popups and menus follow it. Text blocks keep `dir="auto"`, so an English answer in an Arabic chat still reads left to right.
- A message can call the host's own i18n library.

Providers nest. An inner provider changes only the keys it gives, the `markdown` keys too:

```tsx
<GenaiMessagesProvider locale="ar" messages={ar}>
  <GenaiMessagesProvider locale="ar" messages={{ 'chat.greeting': 'مرحبًا' }}>
    <Chat />
  </GenaiMessagesProvider>
</GenaiMessagesProvider>
```

The parts of `@deepagents/react-input` that `ChatComposer` renders, such as the editor and the attachment strip, ship no words of their own: `ChatComposer` fills them from the same catalog. An attachment is named by `composer.attachment({ media, number })` wherever the user sees it: its token in the editor, its preview, `composer.removeAttachment({ label })` and `composer.attachmentMissing({ label })`. The editor draws a pasted block as `composer.pastedText({ chars })`. Only the drawing changes: the prompt the model reads keeps the `[Image #N]` and `[Pasted Content N chars]` tokens, and a paste still expands to its text. When a submission fails, the alert shows `composer.uploadTooLarge` for an upload refused with 413, `composer.uploadUnsupported` for 415, `composer.uploadFailed` for any other refused upload, and `composer.sendFailed` for anything else; the server's own detail never reaches the page.

`ChatComposer.Provider` refuses what the server would: `maxExpandedTextChars` refuses a send whose prompt, its pasted content expanded, is longer, with `composer.promptTooLong({ chars, maxChars })`, and `maxUploadBytes` refuses a picked, pasted or dropped file of more bytes, with `composer.fileTooLarge({ name, maxBytes })`, and uploads nothing. Pass the runtime's discovery, `capabilities.uploads.maxBytes`, as `maxUploadBytes`, beside its `mediaTypes` as `acceptedMediaTypes`.

## Scrolling

`ChatBot` is built on the Message Scroller of `@zukhruf/shadcn`. When a user message arrives, the view moves it to the top and keeps 64px of the previous message in view, and the answer grows below it. The view does not follow the stream. Pass `autoScroll` to follow it while the reader is at the end. `scrollPreviousItemPeek` and `scrollMargin` (room under a sticky header) are the props of the Message Scroller, passed through. The scrolling region is named `chat.messagesRegion` of the catalog.

Under `ChatBot`, the `List` of `CompactMessages` is the content of the scroller, so put each `Item` directly in it. A user `Item` starts a turn.

`ChatBot.ScrollButton` scrolls to the end. It shows only when something is below the view, and floats 16px above the place where you render it. Put it first inside a sticky composer, or last in the chat. Its label is `chat.scrollToBottom` of the catalog.

```tsx
<ChatBot className="h-dvh">
  <Chat />
  <div className="bg-background sticky bottom-0 mt-auto">
    <ChatBot.ScrollButton />
    <Composer />
  </div>
</ChatBot>
```

## Stop

`ChatComposer.Stop` is the composer's Stop button; render it while the answer runs. Stop freezes the answer at once and asks the server to cancel the turn with the transport's `cancel(sessionId)`. A question asked meanwhile is sent once the cancel answers. When the server refuses the cancel, the turn is still running, so the chat keeps watching it: it reconnects to the turn's stream with the AI SDK's `resumeStream`, which the transport's `reconnectToStream` reads from `GET /session/:id/stream`, and the rest of the answer keeps arriving. A question asked meanwhile is sent once that turn ends. Stop shows `composer.stopFailed` as an error toast until the resumed stream ends, when the server's turn has really ended. A cancel lost at the network shows nothing and does not reconnect: the server may have cancelled the turn, and the stream's request would most likely fail as the cancel did. `ChatComposer.Error` shows only the composer's own failures, such as a failed send.

The toast renders in the host's `<Toaster>` from `@zukhruf/shadcn`, the Base UI toast the host's own toasts use, so they share one stack. Stop raises it through the kit's `toast` manager, the one `<Toaster>` renders by default, so the chat mounts none: the host wraps its app in one `<Toaster>`, once, and gives it no `toastManager` of its own. Each chat shows at most one such toast.

```tsx
import { Toaster } from '@zukhruf/shadcn';

createRoot(container).render(
  <ClockProvider clock={globalThis}>
    <Toaster>
      <App />
    </Toaster>
  </ClockProvider>,
);
```

```tsx
<ChatComposer.Toolbar>
  {status === 'submitted' || status === 'streaming' ? (
    <ChatComposer.Stop className="ml-auto" />
  ) : (
    <Composer.Submit render={<SubmitButton type="button" variant="send" />} />
  )}
</ChatComposer.Toolbar>
```

`useAgent().stop()` does the same, resuming a turn whose cancel the server refused, and returns a promise: it resolves once the server has cancelled the turn and rejects when the cancel fails. A refused cancel rejects with the AI SDK's `APICallError`, and a network failure with its own error. A host with its own Stop button must catch that rejection, and shows its own words for it: `ChatComposer.Stop`'s toast comes only from `ChatComposer.Stop`.

Only Stop cancels the turn. Leaving or unmounting a chat whose answer is streaming stops the stream on the page, and the answer finishes on the server: the history shows it when the user comes back. A transport given to `AgentProvider` therefore has `cancel` beside `uploadFile`.

## Start a chat from another page

An entry page, such as a home ask box, can start a new chat with a question. It makes the chat id, writes a prefill with `writePrefill` and goes to the chat page. The `AgentProvider` of that chat id sends the prefill as its first message.

A prefill takes both texts of react-input's submission: `prompt` is what the model reads, with an `[Image #N]` marker for each attachment, and `persistedPrompt` is the user's words, which the user bubble draws.

The prefill is in `sessionStorage`, so a reload keeps it. The provider sends it under one message id on every attempt, and clears it when the transport accepts the turn, when the user stops it, or when a newer question in the chat is accepted.

A `File` cannot go into `sessionStorage`. To attach files, upload them first under the new chat id with the transport's `uploadFile`, and give the receipts as `uploads`. The first message then carries them in `metadata.uploads`, as a submit with files does. A retry sends the same receipts and does not upload the files again.

```tsx
const chatId = crypto.randomUUID();
const uploads = await Promise.all(
  files.map((file) => transport.uploadFile(chatId, file)),
);
writePrefill({
  prompt: submission.prompt,
  persistedPrompt: submission.persistedPrompt,
  targetChatId: chatId,
  uploads,
});
navigate(`/chats/${chatId}`);
```

If an upload fails, nothing is written. Show the error on the entry page and keep the user there. A refused upload rejects with the AI SDK's `APICallError`, as a refused send does: `statusCode` is the server's status and `responseBody` its text, so map the status to your words rather than showing `message`.

An entry page that sends from react-input's `Composer.Root` gets the words `ChatComposer` shows from `useSubmitErrorMessage()`, under a `GenaiMessagesProvider` and with no `AgentProvider`: `composer.uploadTooLarge` for a 413, `composer.uploadUnsupported` for a 415, `composer.uploadFailed` for another refused upload and `composer.sendFailed` for any other error.

```tsx
<Composer.Root submitErrorMessage={useSubmitErrorMessage()} onSubmit={ask} {...words}>
```

## One copy of @zukhruf/ui

The host and this package must use the same copy of `@zukhruf/ui`. Each copy has its own React context. A `ClockProvider` of one copy does not reach a `TheButton` of the other copy, and the button throws `No clock set, use ClockProvider to set one`. For this reason `@zukhruf/ui` is a peer dependency. npm refuses an install when the version of the host is out of the range.

## Move from 7.5.2

Version 7.5.2 lists `@zukhruf/ui` as a dependency, with the range `^0.8.10`. An install with no lockfile gets a version of `@zukhruf/ui` that has the clock. Then `AssistantSnapshot` throws `No clock set, use ClockProvider to set one` at render.

Do these steps:

1. Add `@zukhruf/ui` to the dependencies of the host.
2. Put a `ClockProvider` above the components of this package, at the root of the host.
