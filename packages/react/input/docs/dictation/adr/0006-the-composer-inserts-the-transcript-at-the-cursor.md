# The composer inserts the transcript at the cursor

Status: ruled by Ezz on 2026-11-20 (shipped).

## Context

The copies disagree on where the text goes:

- text2sql v2 (`apps/v2/frontend/src/app/components/ComposerVoiceButton.tsx`) puts a space before the text when the draft is not empty: ``actions.insertText(state.text.trim() ? ` ${text}` : text)``.
- blackboard (`apps/web/src/routes/ChatBot/ChatComposer.tsx`) puts a space before it when the character before the cursor is not whitespace.
- assistant-ui puts a space when the whole text does not end with a space (`@assistant-ui/core` 0.3.37, `runtime/base/dictation-session.js:106`), because it sets the whole text, not an insertion at the cursor.

## Decision

The space comes before the text when the character before the cursor is not whitespace (blackboard's rule). This composer inserts at the cursor, so the character before the cursor is the one that touches the text. No space goes after the text: no copy and no leader adds one, and this is the design's own judgment.

## Consequences

- One rule replaces the two that the hosts wrote.
- A send during a dictation inserts the text first and then submits the draft (ADR 0008), so no transcript arrives after its send. The first draft of this ADR held a transcript that came back while the composer was disabled; ADR 0008 removes that case.
