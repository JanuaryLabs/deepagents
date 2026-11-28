import { Popover } from '@base-ui/react/popover';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Sheet, SheetContent, SheetTitle } from '@zukhruf/shadcn';
import { type RefObject, createRef, useState } from 'react';
import { expect, test } from 'vitest';

import { CitationPill } from '@deepagents/react-genai';

const source = { url: 'https://example.org/a', title: 'Apixaban dosing' };

function Host({ pill }: { pill: RefObject<HTMLButtonElement | null> }) {
  const [panel, setPanel] = useState(false);
  return (
    <>
      <p>
        Answer
        <CitationPill source={source} index={1} ref={pill}>
          <Popover.Close
            render={
              <button type="button" onClick={() => setPanel(true)}>
                Show source
              </button>
            }
          />
        </CitationPill>
      </p>
      <Sheet open={panel} onOpenChange={setPanel}>
        <SheetContent finalFocus={pill}>
          <SheetTitle>Sources</SheetTitle>
        </SheetContent>
      </Sheet>
    </>
  );
}

test('a host panel opened from a citation card that opened on hover returns focus to the citation when it closes (#6323)', async () => {
  const user = userEvent.setup({ skipHover: true });
  try {
    const ref = createRef<HTMLButtonElement>();
    render(<Host pill={ref} />);
    const pill = screen.getByRole('button', { name: 'Source 1' });

    await user.hover(pill);
    await user.click(
      await screen.findByRole('button', { name: 'Show source' }),
    );
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(pill));
    expect(ref.current).toBe(pill);
  } finally {
    cleanup();
  }
});
