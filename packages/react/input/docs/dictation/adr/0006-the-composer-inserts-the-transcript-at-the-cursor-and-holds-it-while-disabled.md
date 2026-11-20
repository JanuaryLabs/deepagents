# The composer inserts the transcript at the cursor and holds it while disabled

Status: proposed by this design; not ruled yet.

## Context

The copies disagree on where the text goes:

- text2sql v2 (`apps/v2/frontend/src/app/components/ComposerVoiceButton.tsx`) puts a space before the text when the draft is not empty: ``actions.insertText(state.text.trim() ? ` ${text}` : text)``.
- blackboard (`apps/web/src/routes/ChatBot/ChatComposer.tsx`) puts a space before it when the character before the cursor is not whitespace.
- assistant-ui puts a space when the whole text does not end with a space (`@assistant-ui/core` 0.3.37, `runtime/base/dictation-session.js:106`), because it sets the whole text, not an insertion at the cursor.

`insertText` drops the text while the composer is disabled (`Composer.tsx:693-697`). blackboard holds the transcript until the composer is enabled again. The text2sql sites do not, so a transcript that comes back during a send is lost.

## Proposal

- The space comes before the text when the character before the cursor is not whitespace (blackboard's rule). This composer inserts at the cursor, so the character before the cursor is the one that touches the text. No space goes after the text: no copy and no leader adds one, and this is the design's own judgment.
- A transcript that arrives while the composer is disabled waits in the part, and goes in when the composer is enabled again. When the part unmounts first, the transcript is dropped.

## To rule

- Whether the space rule is blackboard's or v2's.
- Whether a held transcript goes in on its own when the composer is enabled, or waits for the user.
