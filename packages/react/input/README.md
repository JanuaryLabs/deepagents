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

The parts ship no words ([ADR 0007](./docs/dictation/adr/0007-react-input-ships-no-words-or-icons-and-react-genai-ships-chatcomposer-dictate.md)). Each part that shows or announces text takes it as a required prop: `Composer.Root`'s `editorAriaLabel` and `submitFailedMessage`, `Composer.Editor`'s `placeholder`, `Composer.Attachments`' `aria-label` and `removeLabel`, `Composer.Popup`'s `listboxLabel`, `noMatchesLabel` and `argsLabel`, `Composer.AttachFiles`' `inputLabel`, and `Composer.Shortcuts`' `heading`, `closeLabel`, `groupTitles` and `descriptions`. `ChatComposer` of `@deepagents/react-genai` fills them from its message catalog.

## Features

[COMPOSER_FEATURE_MATRIX.md](./COMPOSER_FEATURE_MATRIX.md) lists what the composer does and the contract of each feature.
