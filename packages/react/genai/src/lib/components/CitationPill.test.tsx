import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, test } from 'vitest';

import { CitationPill } from './CitationPill.tsx';

const source = {
  url: 'https://pubmed.ncbi.nlm.nih.gov/36892077/',
  title: 'Apixaban dosing in chronic kidney disease',
};

test('a tap on a citation opens its detail: the title, the site and a link to the source (#5929)', async () => {
  const user = userEvent.setup();
  try {
    render(<CitationPill source={source} index={1} />);

    await user.click(screen.getByRole('button', { name: 'Source 1' }));

    expect({
      title: screen.getByText(source.title).textContent,
      site: screen.getByText('pubmed.ncbi.nlm.nih.gov').textContent,
      link: screen
        .getByRole('link', { name: 'Open the source' })
        .getAttribute('href'),
    }).toEqual({
      title: source.title,
      site: 'pubmed.ncbi.nlm.nih.gov',
      link: source.url,
    });
  } finally {
    cleanup();
  }
});

test('a keyboard user reaches a citation with Tab and opens its detail with Enter (#5929)', async () => {
  const user = userEvent.setup();
  try {
    render(<CitationPill source={source} index={2} />);

    await user.tab();
    const pill = screen.getByRole('button', { name: 'Source 2' });
    const focused = document.activeElement === pill;
    await user.keyboard('{Enter}');

    expect({
      focused,
      link: screen
        .getByRole('link', { name: 'Open the source' })
        .getAttribute('href'),
    }).toEqual({ focused: true, link: source.url });
  } finally {
    cleanup();
  }
});

test('a host’s own detail, such as a correction notice, shows in the citation’s detail (#5929)', async () => {
  const user = userEvent.setup();
  try {
    render(
      <CitationPill source={source} index={3}>
        <p>Correction published 2024-02-01.</p>
      </CitationPill>,
    );

    await user.click(screen.getByRole('button', { name: 'Source 3' }));

    expect(
      screen.getByText('Correction published 2024-02-01.'),
    ).toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('a mouse user sees a citation’s detail on hover (#5929)', async () => {
  const user = userEvent.setup();
  try {
    render(<CitationPill source={source} index={4} />);

    await user.hover(screen.getByRole('button', { name: 'Source 4' }));

    expect(
      await screen.findByRole('link', { name: 'Open the source' }),
    ).toHaveAttribute('href', source.url);
  } finally {
    cleanup();
  }
});
