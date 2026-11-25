/**
 * Puts a transcript at the cursor of a plain field, as the composer does in
 * its editor (ADR 0006). The bubbling `input` event lets React see the new
 * value, whether the field is controlled or not.
 *
 * The space rule is copied from `insertTranscript` in `Composer.tsx` (strike
 * 2; ledger: docs/dictation/copied-space-rule.md). Mirror every fix in both.
 */
export function insertTranscript(
  field: HTMLTextAreaElement | HTMLInputElement,
  text: string,
): void {
  const transcript = text.trim();
  if (!transcript) {
    return;
  }
  const { selectionStart, selectionEnd } = field;
  if (selectionStart === null || selectionEnd === null) {
    throw new TypeError(
      `insertTranscript needs a field with a cursor; <input type="${field.type}"> has none.`,
    );
  }
  const beforeCursor = field.value.slice(0, selectionStart);
  field.setRangeText(
    beforeCursor && !/\s$/.test(beforeCursor) ? ` ${transcript}` : transcript,
    selectionStart,
    selectionEnd,
    'end',
  );
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
