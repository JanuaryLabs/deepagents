# Dictation lives in the deepagents composer, not in zukhruf

Status: ruled by Ezz on 2026-11-20 (shipped).

## Context

Two copies of `@genui/voice` exist: text2sql `packages/genui/voice` and blackboard `packages/voice`. Backlog #4920 first named zukhruf's UI layer (`std:ui`) as the home, because the code names no product. Every place that renders it is the composer of an agent chat: ten in text2sql and one in blackboard. deepagents already holds that composer (`@deepagents/react-input`, which #3158 moves both apps onto) and the chat kit's look (`@deepagents/react-genai`, with `ChatComposer`).

## Considered options

- **A zukhruf `std:ui` package.** It holds UI with no chat concept: `shadcn` and `diagram`. Dictation would still need the composer to insert its text, so the host would wire the two together at each site, as both copies do today.
- **A new `@deepagents/react-dictation` package.** It gives a hook that knows no composer. Every consumer is a composer, so each would again write the insertion and the disabled handling.
- **A part of `Composer` in `@deepagents/react-input/browser`, with the chat kit's look in `@deepagents/react-genai`.** This option was selected.

## Consequences

- The composer owns the dictation next to the cursor, the insertion, the submit and the disabled state that it needs (ADR 0002).
- The two copies move only after #3158 moves their apps to `@deepagents/react-input`.
- A plain form field (Meddit) needs a hook outside the composer. That hook is later, when Meddit needs it.
