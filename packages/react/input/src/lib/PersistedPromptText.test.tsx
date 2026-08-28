import { fireEvent, render, screen } from '@testing-library/react';
import { PersistedPromptText } from '@deepagents/react-input/browser';
import { describe, expect, it, vi } from 'vitest';

describe('PersistedPromptText', () => {
  it('renders only the supported prompt markup', () => {
    const { container } = render(
      <PersistedPromptText
        text={`Use \`sum()\` and [$report](skill://report) with [docs](https://example.com), [unsafe](javascript:alert(1)), $review, and $[data set].
\`\`\`sql
select 1
\`\`\``}
      />,
    );

    expect(screen.getByText('sum()').tagName).toBe('CODE');
    expect(screen.getByText('select 1').tagName).toBe('CODE');
    expect(
      screen.getByText('report').closest('[data-skill-id]'),
    ).toHaveAttribute('data-skill-id', 'report');
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull();
    expect(container).toHaveTextContent('[unsafe](javascript:alert(1))');
    expect(
      screen.getByText('review').closest('[data-skill-name]'),
    ).toHaveAttribute('data-skill-name', 'review');
    expect(
      screen.getByText('data set').closest('[data-skill-name]'),
    ).toHaveAttribute('data-skill-name', 'data set');
  });

  it('copies the canonical source for rendered references and code', () => {
    const source =
      'Use [$report](skill://report), $review, and `sum()` for this.';
    const { container } = render(<PersistedPromptText text={source} />);
    const root = container.firstElementChild;
    if (!root) throw new Error('Expected prompt root');

    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    if (!selection) throw new Error('Expected document selection');
    selection.removeAllRanges();
    selection.addRange(range);

    const setData = vi.fn();
    fireEvent.copy(root, { clipboardData: { setData } });

    expect(setData).toHaveBeenCalledWith('text/plain', source);
  });
});
