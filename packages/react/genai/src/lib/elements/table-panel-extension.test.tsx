import { cleanup, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { expect, test } from 'vitest';

import { InteractiveResponse } from '../components/InteractiveResponse.tsx';
import { Response } from './Response.tsx';

const modes = [
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const;

const revenueTable =
  '::table{title="Revenue by region" description="Q3, in USD"}\n\n| Region | Revenue |\n| --- | --- |\n| EMEA | 120 |\n| APAC | 90 |\n';

function observePanels(container: HTMLElement) {
  return [...container.querySelectorAll('[data-slot="table-panel"]')].map(
    (panel) => ({
      title:
        panel.querySelector('[data-slot="table-panel-title"]')?.textContent ??
        null,
      description:
        panel.querySelector('[data-slot="table-panel-description"]')
          ?.textContent ?? null,
      rows: [...panel.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => cell.textContent),
      ),
    }),
  );
}

function observeHeader(container: HTMLElement) {
  const header = container.querySelector('[data-slot="table-panel-header"]');
  return {
    header: header !== null,
    copy: header?.querySelector('button[title="Copy table"]') != null,
    download: header?.querySelector('button[title="Download table"]') != null,
    extraAction: header?.querySelector('[data-testid="extra-action"]') != null,
  };
}

test.each(modes)(
  'a ::table directive before a table puts its title and description in the panel header, above the table rows, in %s mode',
  (_case, mode) => {
    try {
      const { container } = render(
        <Response mode={mode}>{revenueTable}</Response>,
      );

      expect(observePanels(container)).toEqual([
        {
          title: 'Revenue by region',
          description: 'Q3, in USD',
          rows: [
            ['EMEA', '120'],
            ['APAC', '90'],
          ],
        },
      ]);
    } finally {
      cleanup();
    }
  },
);

test.each(modes)(
  'a table with no directive renders in a panel with no title or description in %s mode',
  (_case, mode) => {
    try {
      const { container } = render(
        <Response mode={mode}>
          {'| Region | Revenue |\n| --- | --- |\n| EMEA | 120 |\n'}
        </Response>,
      );

      expect(observePanels(container)).toEqual([
        { title: null, description: null, rows: [['EMEA', '120']] },
      ]);
    } finally {
      cleanup();
    }
  },
);

test.each(modes)(
  'while the chat streams a ::table directive and its table, the final render holds one panel with its title in %s mode',
  (_case, mode) => {
    const cuts = [
      '::table{title="Revenue by region" description="Q3, in USD"}\n'.length,
      '::table{title="Revenue by region" description="Q3, in USD"}\n\n| Region | Revenue |\n'
        .length,
      '::table{title="Revenue by region" description="Q3, in USD"}\n\n| Region | Revenue |\n| --- | --- |\n| EMEA | 120 |\n'
        .length,
      revenueTable.length,
    ];
    try {
      const { container, rerender } = render(<div />);
      for (const cut of cuts) {
        rerender(
          <Response mode={mode} isAnimating={cut < revenueTable.length}>
            {revenueTable.slice(0, cut)}
          </Response>,
        );
      }

      expect(observePanels(container)).toEqual([
        {
          title: 'Revenue by region',
          description: 'Q3, in USD',
          rows: [
            ['EMEA', '120'],
            ['APAC', '90'],
          ],
        },
      ]);
    } finally {
      cleanup();
    }
  },
);

test.each(modes)(
  'in a right-to-left page a table panel takes the direction most of its title and cells are written in, in %s mode',
  (_case, mode) => {
    const arabicTitleEnglishTable =
      '::table{title="الإيرادات حسب المنطقة"}\n\n| Region | Revenue |\n| --- | --- |\n| EMEA | 120 |\n';
    const englishTitleArabicTable =
      '::table{title="Revenue by region"}\n\n| المنطقة | الإيرادات |\n| --- | --- |\n| أوروبا | ١٢٠ |\n';
    const englishTitleEnglishTable = revenueTable;

    const panelDirection = (markdown: string) => {
      try {
        const { container } = render(
          <div dir="rtl">
            <InteractiveResponse mode={mode}>{markdown}</InteractiveResponse>
          </div>,
        );
        // Static mode puts dir on the whole response, streaming mode on a
        // display:contents wrapper around the panel's block.
        return container
          .querySelector('[data-slot="table-panel"]')
          ?.closest('[dir]')
          ?.getAttribute('dir');
      } finally {
        cleanup();
      }
    };

    // streamdown's detectTextDirection counts strong characters over the
    // title and the cells: the Arabic cells outnumber the English title.
    expect({
      arabicTitleEnglishTable: panelDirection(arabicTitleEnglishTable),
      englishTitleArabicTable: panelDirection(englishTitleArabicTable),
      englishTitleEnglishTable: panelDirection(englishTitleEnglishTable),
    }).toEqual({
      arabicTitleEnglishTable: 'rtl',
      englishTitleArabicTable: 'rtl',
      englishTitleEnglishTable: 'ltr',
    });
  },
);

test.each(modes)(
  'controls choose the copy and download buttons in the panel header, and tableActions adds its node there, in %s mode',
  (_case, mode) => {
    const headerWith = (props: ComponentProps<typeof Response>) => {
      try {
        const { container } = render(
          <Response mode={mode} {...props}>
            {revenueTable}
          </Response>,
        );
        return observeHeader(container);
      } finally {
        cleanup();
      }
    };

    expect({
      default: headerWith({}),
      controlsOff: headerWith({ controls: false }),
      tableOff: headerWith({ controls: { table: false } }),
      downloadOff: headerWith({ controls: { table: { download: false } } }),
      copyOff: headerWith({ controls: { table: { copy: false } } }),
      tableActions: headerWith({
        tableActions: <button data-testid="extra-action">Chart</button>,
      }),
    }).toEqual({
      default: { header: true, copy: true, download: true, extraAction: false },
      controlsOff: {
        header: true,
        copy: false,
        download: false,
        extraAction: false,
      },
      tableOff: {
        header: true,
        copy: false,
        download: false,
        extraAction: false,
      },
      downloadOff: {
        header: true,
        copy: true,
        download: false,
        extraAction: false,
      },
      copyOff: {
        header: true,
        copy: false,
        download: true,
        extraAction: false,
      },
      tableActions: {
        header: true,
        copy: true,
        download: true,
        extraAction: true,
      },
    });
  },
);

test.each(modes)(
  'a table with no directive keeps a header for its copy and download buttons, and drops the header once controls are off, in %s mode',
  (_case, mode) => {
    const headerWith = (props: ComponentProps<typeof Response>) => {
      try {
        const { container } = render(
          <Response mode={mode} {...props}>
            {'| Region | Revenue |\n| --- | --- |\n| EMEA | 120 |\n'}
          </Response>,
        );
        return observeHeader(container);
      } finally {
        cleanup();
      }
    };

    expect({
      default: headerWith({}),
      controlsOff: headerWith({ controls: false }),
    }).toEqual({
      default: { header: true, copy: true, download: true, extraAction: false },
      controlsOff: {
        header: false,
        copy: false,
        download: false,
        extraAction: false,
      },
    });
  },
);
