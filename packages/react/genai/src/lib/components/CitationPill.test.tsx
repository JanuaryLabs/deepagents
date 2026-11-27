import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, test } from 'vitest';

import { GenaiMessagesProvider } from '../i18n/index.ts';
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

test('in a right-to-left page a citation’s title and site take their own direction (#5946)', async () => {
  const user = userEvent.setup();
  try {
    render(
      <div dir="rtl">
        <CitationPill source={source} index={5} />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Source 5' }));

    expect(
      [source.title, 'pubmed.ncbi.nlm.nih.gov'].map((text) =>
        screen.getByText(text).closest('[dir]')?.getAttribute('dir'),
      ),
    ).toEqual(['auto', 'auto']);
  } finally {
    cleanup();
  }
});

test('a host gives a citation’s labels in its own language (#5946, #6047)', async () => {
  const user = userEvent.setup();
  try {
    render(
      <GenaiMessagesProvider
        locale="ar"
        messages={{
          'citation.source': ({ index }) => `المصدر ${index}`,
          'citation.open': 'افتح المصدر',
        }}
      >
        <CitationPill source={source} index={6} />
      </GenaiMessagesProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'المصدر 6' }));

    expect(
      screen.getByRole('link', { name: 'افتح المصدر' }).getAttribute('href'),
    ).toBe(source.url);
  } finally {
    cleanup();
  }
});

test('a long source title stays whole for a screen reader and on hover, though the card shows one line (#6018)', async () => {
  const user = userEvent.setup();
  const title =
    'SERTRALINE (SERTRALINE HYDROCHLORIDE) TABLET, FILM COATED [READYMEDS] — PRECAUTIONS — Drug Interactions — Serotonergic Drugs:';
  try {
    render(
      <CitationPill
        source={{ url: 'https://dailymed.nlm.nih.gov/dailymed/', title }}
        index={7}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Source 7' }));

    expect({
      screenReader: screen.queryByRole('dialog', { name: title }) !== null,
      hover: screen.getByTitle(title).textContent,
      siteHover: screen.getByTitle('dailymed.nlm.nih.gov').textContent,
    }).toEqual({
      screenReader: true,
      hover: title,
      siteHover: 'dailymed.nlm.nih.gov',
    });
  } finally {
    cleanup();
  }
});

test('a citation with a description shows it under the title in place of the site, whole on hover (#6087)', async () => {
  const user = userEvent.setup();
  const description =
    'SERTRALINE (SERTRALINE HYDROCHLORIDE) TABLET, FILM COATED [READYMEDS]';
  try {
    render(
      <CitationPill
        source={{
          url: 'https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=1',
          title: 'Serotonergic Drugs:',
          description,
        }}
        index={8}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Source 8' }));

    expect({
      title: screen.getByTitle('Serotonergic Drugs:').textContent,
      description: screen.getByTitle(description).textContent,
      direction: screen.getByTitle(description).getAttribute('dir'),
      site: screen.queryByText('dailymed.nlm.nih.gov'),
    }).toEqual({
      title: 'Serotonergic Drugs:',
      description,
      direction: 'auto',
      site: null,
    });
  } finally {
    cleanup();
  }
});

test('a citation with no description shows the site under the title (#6087)', async () => {
  const user = userEvent.setup();
  try {
    render(<CitationPill source={source} index={9} />);

    await user.click(screen.getByRole('button', { name: 'Source 9' }));

    expect(screen.getByTitle('pubmed.ncbi.nlm.nih.gov').textContent).toBe(
      'pubmed.ncbi.nlm.nih.gov',
    );
  } finally {
    cleanup();
  }
});
