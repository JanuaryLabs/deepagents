# @deepagents/react-genai

React components that render AI SDK chat flows, trajectories, tools, citations, dynamic UI and interactive responses. A host is the app that renders these components. The host gives the transport, the tools and the clock.

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

`@deepagents/react-genai/styles.css` imports the stylesheet of `@deepagents/react-input` and names the built components of both packages with `@source`, so Tailwind generates the classes they use. The host writes no `@source` for either package.

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

## One copy of @zukhruf/ui

The host and this package must use the same copy of `@zukhruf/ui`. Each copy has its own React context. A `ClockProvider` of one copy does not reach a `TheButton` of the other copy, and the button throws `No clock set, use ClockProvider to set one`. For this reason `@zukhruf/ui` is a peer dependency. npm refuses an install when the version of the host is out of the range.

## Move from 7.5.2

Version 7.5.2 lists `@zukhruf/ui` as a dependency, with the range `^0.8.10`. An install with no lockfile gets a version of `@zukhruf/ui` that has the clock. Then `AssistantSnapshot` throws `No clock set, use ClockProvider to set one` at render.

Do these steps:

1. Add `@zukhruf/ui` to the dependencies of the host.
2. Put a `ClockProvider` above the components of this package, at the root of the host.
