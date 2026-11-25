# Copied: the space rule of an inserted transcript

Strike 2 of the Rule of Three (deepagents #5658). Mirror every fix in both copies, and name both files in the commit. Extract at a third copy, not before.

| Source                                                        | Copy                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `src/lib/Composer.tsx`, `insertTranscript` in `Composer.Root` | `src/lib/dictation/insertTranscript.ts`, `insertTranscript` |

The rule (ADR 0006): the text goes in at the cursor, with a space before it when the character before the cursor is not whitespace; no space after it.

## What changed in the copy, and why

| Change                                                                                           | Why                                                                                                  |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| It reads `field.value` and `field.selectionStart` instead of the editor's text and cursor        | A plain field has no editor                                                                          |
| It writes with `setRangeText(text, selectionStart, selectionEnd, 'end')` instead of `insertText` | The browser's own insertion at the cursor; the cursor lands after the text                           |
| It dispatches a bubbling `input` event                                                           | `setRangeText` fires none, and React's `onChange` and the host's listeners need one                  |
| It trims the text and inserts nothing for an empty one                                           | In the composer, its `onTranscript` trims before it calls the editor's copy                          |
| It throws a `TypeError` when the field has no cursor (`selectionStart` is `null`)                | An `<input type="email">` or `number` has no selection, so there is no "character before the cursor" |
