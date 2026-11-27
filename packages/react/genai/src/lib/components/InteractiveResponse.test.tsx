import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';

import { Response } from '../elements/Response.tsx';
import { InteractiveResponse } from './InteractiveResponse.tsx';

function ParamProbe(props: Record<string, unknown>) {
  return (
    <div data-testid="probe">
      {JSON.stringify({ param: props.param, label: props.label })}
    </div>
  );
}

test('rejects an element that declares a sanitizer-clobbered attribute', () => {
  const clobberedElement = {
    name: 'bad-element',
    component: ParamProbe,
    allowedAttributes: ['name', 'label'],
  };

  try {
    expect(() =>
      render(
        <InteractiveResponse elements={[clobberedElement]}>
          {'<bad-element name="state"></bad-element>'}
        </InteractiveResponse>,
      ),
    ).toThrow(/name|reserved/i);
  } finally {
    cleanup();
  }
});

test.each([
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const)(
  'top-level custom elements stay wrapped in a bare div with no attributes in %s mode (#5988)',
  (_case, mode) => {
    // Bare wrappers are part of the public rendering contract. A class or extra
    // layer would prevent consumers from making this structural wrapper
    // layout-transparent.
    const paramElement = {
      name: 'param-probe',
      component: ParamProbe,
      allowedAttributes: ['param', 'label'],
    };

    try {
      render(
        <InteractiveResponse elements={[paramElement]} mode={mode}>
          {'<param-probe param="state"></param-probe>'}
        </InteractiveResponse>,
      );

      const wrapper = screen.getByTestId('probe').parentElement;
      expect({
        tag: wrapper?.tagName,
        attributes: wrapper?.getAttributeNames(),
      }).toEqual({ tag: 'DIV', attributes: [] });
    } finally {
      cleanup();
    }
  },
);

test('the param attribute reaches the element verbatim through the sanitize pipeline', () => {
  const paramElement = {
    name: 'param-probe',
    component: ParamProbe,
    allowedAttributes: ['param', 'label'],
  };

  try {
    render(
      <InteractiveResponse elements={[paramElement]}>
        {'<param-probe param="state" label="State"></param-probe>'}
      </InteractiveResponse>,
    );

    expect(JSON.parse(screen.getByTestId('probe').textContent ?? '{}')).toEqual(
      { param: 'state', label: 'State' },
    );
  } finally {
    cleanup();
  }
});

function CiteProbe(props: Record<string, unknown>) {
  return (
    <sup
      data-testid="cite"
      data-passage={String(props.passage)}
      data-children={props.children === undefined ? 'none' : 'some'}
    >
      [{String(props.passage)}]
    </sup>
  );
}

const passageCite = {
  name: 'passage-cite',
  component: CiteProbe,
  allowedAttributes: ['passage'],
};

test('text after a self-closing element in a sentence stays in the sentence, and a later element stays its sibling', () => {
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {
          'Claim A <passage-cite passage="pubmed:1" /> then claim B <passage-cite passage="pubmed:2" />.'
        }
      </InteractiveResponse>,
    );

    const cites = screen.getAllByTestId('cite');
    expect({
      text: container.textContent,
      cites: cites.length,
      secondNestedInFirst: cites[0]?.contains(cites[1] ?? null),
      inParagraph: cites.map((cite) => cite.closest('p') !== null),
    }).toEqual({
      text: 'Claim A [pubmed:1] then claim B [pubmed:2].',
      cites: 2,
      secondNestedInFirst: false,
      inParagraph: [true, true],
    });
  } finally {
    cleanup();
  }
});

test('a self-closing element in a sentence renders its component with its attribute and no children', () => {
  try {
    render(
      <InteractiveResponse elements={[passageCite]}>
        {
          'Aspirin lowers the risk <passage-cite passage="pubmed:1" /> in adults.'
        }
      </InteractiveResponse>,
    );

    const cite = screen.getByTestId('cite');
    expect({
      passage: cite.dataset.passage,
      children: cite.dataset.children,
    }).toEqual({ passage: 'pubmed:1', children: 'none' });
  } finally {
    cleanup();
  }
});

// The tag names from the render root down to `node`, so a test can compare a
// sentence with elements against the same sentence without them.
function tagPath(node: Element | null, root: Element): string[] {
  const tags: string[] = [];
  for (let at = node; at && at !== root; at = at.parentElement)
    tags.unshift(at.tagName);
  return tags;
}

function plainSentencePath(text: string): string[] {
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {text}
      </InteractiveResponse>,
    );
    return tagPath(container.querySelector('p'), container);
  } finally {
    cleanup();
  }
}

test('a sentence with one self-closing element renders as one <p> holding the element, laid out like the plain sentence', () => {
  const plain = plainSentencePath('Aspirin lowers the risk in adults.');
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {
          'Aspirin lowers the risk <passage-cite passage="pubmed:1" /> in adults.'
        }
      </InteractiveResponse>,
    );

    const paragraphs = container.querySelectorAll('p');
    const wrapper = screen.getByTestId('cite').parentElement;
    expect({
      paragraphs: paragraphs.length,
      path: tagPath(paragraphs[0] ?? null, container),
      holdsCite: paragraphs[0]?.contains(screen.getByTestId('cite')),
      text: paragraphs[0]?.textContent,
      // A bare span, like the bare div of a block element: a tag such as <i>
      // or a class would restyle every citation.
      wrapper: {
        tag: wrapper?.tagName,
        attributes: wrapper?.attributes.length,
      },
    }).toEqual({
      paragraphs: 1,
      path: plain,
      holdsCite: true,
      text: 'Aspirin lowers the risk [pubmed:1] in adults.',
      wrapper: { tag: 'SPAN', attributes: 0 },
    });
  } finally {
    cleanup();
  }
});

test.each([
  ['no space', ''],
  ['one space', ' '],
])(
  'two self-closing elements side by side with %s stay in the sentence’s one <p>',
  (_case, separator) => {
    const plain = plainSentencePath('Aspirin lowers the risk in adults.');
    try {
      const { container } = render(
        <InteractiveResponse elements={[passageCite]}>
          {`Aspirin lowers the risk <passage-cite passage="pubmed:1" />${separator}<passage-cite passage="pubmed:2" /> in adults.`}
        </InteractiveResponse>,
      );

      const paragraphs = container.querySelectorAll('p');
      expect({
        paragraphs: paragraphs.length,
        path: tagPath(paragraphs[0] ?? null, container),
        citesInside: screen
          .getAllByTestId('cite')
          .map((cite) => paragraphs[0]?.contains(cite)),
        text: paragraphs[0]?.textContent,
      }).toEqual({
        paragraphs: 1,
        path: plain,
        citesInside: [true, true],
        text: `Aspirin lowers the risk [pubmed:1]${separator}[pubmed:2] in adults.`,
      });
    } finally {
      cleanup();
    }
  },
);

test('while the chat streams the sentence with its slide-up animation, each prefix holds its element in one <p>', () => {
  // elementsStreamTransform holds a tag back until it is complete, so every
  // prefix the chat renders ends at a whole tag or after it.
  const prefixes = [
    'Aspirin lowers the risk <passage-cite passage="pubmed:1" />',
    'Aspirin lowers the risk <passage-cite passage="pubmed:1" /> in',
    'Aspirin lowers the risk <passage-cite passage="pubmed:1" /> in adults.',
  ];
  try {
    const { container, rerender } = render(<div />);
    const seen = prefixes.map((prefix) => {
      rerender(
        <InteractiveResponse
          elements={[passageCite]}
          animated={{ animation: 'slideUp' }}
          isAnimating
        >
          {prefix}
        </InteractiveResponse>,
      );
      const paragraphs = container.querySelectorAll('p');
      return {
        paragraphs: paragraphs.length,
        holdsCite: paragraphs[0]?.contains(screen.getByTestId('cite')),
        text: paragraphs[0]?.textContent,
      };
    });

    expect(seen).toEqual([
      {
        paragraphs: 1,
        holdsCite: true,
        text: 'Aspirin lowers the risk [pubmed:1]',
      },
      {
        paragraphs: 1,
        holdsCite: true,
        text: 'Aspirin lowers the risk [pubmed:1] in',
      },
      {
        paragraphs: 1,
        holdsCite: true,
        text: 'Aspirin lowers the risk [pubmed:1] in adults.',
      },
    ]);
  } finally {
    cleanup();
  }
});

test('an element that opens a sentence stays in that sentence’s one <p>', () => {
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {'<passage-cite passage="pubmed:1" /> shows the effect in adults.'}
      </InteractiveResponse>,
    );

    const paragraphs = container.querySelectorAll('p');
    expect({
      paragraphs: paragraphs.length,
      holdsCite: paragraphs[0]?.contains(screen.getByTestId('cite')),
      text: paragraphs[0]?.textContent,
    }).toEqual({
      paragraphs: 1,
      holdsCite: true,
      text: '[pubmed:1] shows the effect in adults.',
    });
  } finally {
    cleanup();
  }
});

test('an element alone on the line after a sentence stays a block, outside the sentence’s <p>', () => {
  try {
    render(
      <InteractiveResponse elements={[passageCite]}>
        {
          'Aspirin lowers the risk <passage-cite passage="pubmed:1" />\n<passage-cite passage="pubmed:2" />'
        }
      </InteractiveResponse>,
    );

    expect(
      screen
        .getAllByTestId('cite')
        .map((cite) => cite.closest('p')?.textContent ?? null),
    ).toEqual(['Aspirin lowers the risk [pubmed:1]', null]);
  } finally {
    cleanup();
  }
});

test.each([
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const)(
  'an element alone on a line between two lines of text keeps the text after it in %s mode',
  (_case, mode) => {
    try {
      render(
        <InteractiveResponse elements={[passageCite]} mode={mode}>
          {
            'Aspirin lowers the risk.\n<passage-cite passage="pubmed:1" />\nIt works in adults.'
          }
        </InteractiveResponse>,
      );

      const cite = screen.getByTestId('cite');
      const after = screen.queryByText('It works in adults.');
      expect({
        children: cite.dataset.children,
        after: after?.tagName,
        afterInsideCite: cite.contains(after),
      }).toEqual({ children: 'none', after: 'P', afterInsideCite: false });
    } finally {
      cleanup();
    }
  },
);

test.each([
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const)(
  'a self-closing element on a line of its own between paragraphs keeps the paragraph after it in %s mode (#5988)',
  (_case, mode) => {
    try {
      render(
        <InteractiveResponse elements={[passageCite]} mode={mode}>
          {
            'Aspirin lowers the risk.\n\n<passage-cite passage="pubmed:1" />\n\nIt works in adults.'
          }
        </InteractiveResponse>,
      );

      const cite = screen.getByTestId('cite');
      const after = screen.queryByText('It works in adults.');
      expect({
        children: cite.dataset.children,
        after: after?.tagName,
        afterInsideCite: cite.contains(after),
      }).toEqual({ children: 'none', after: 'P', afterInsideCite: false });
    } finally {
      cleanup();
    }
  },
);

test.each([
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const)(
  'self-closing elements on lines of their own stay blocks, outside any paragraph, in %s mode',
  (_case, mode) => {
    try {
      render(
        <InteractiveResponse elements={[passageCite]} mode={mode}>
          {
            '<passage-cite passage="pubmed:1" />\n<passage-cite passage="pubmed:2" />'
          }
        </InteractiveResponse>,
      );

      const cites = screen.getAllByTestId('cite');
      expect({
        paragraphs: cites.map((cite) => cite.closest('p')),
        nested: cites[0]?.contains(cites[1] ?? null),
      }).toEqual({ paragraphs: [null, null], nested: false });
    } finally {
      cleanup();
    }
  },
);

function BoxProbe(props: Record<string, unknown> & { children?: ReactNode }) {
  return <section data-testid="box">{props.children}</section>;
}

test.each([
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const)(
  'a paired element on the lines between two lines of text renders the markdown inside it and keeps the text after it a paragraph in %s mode (#5988)',
  (_case, mode) => {
    try {
      render(
        <InteractiveResponse
          elements={[
            { name: 'box-probe', component: BoxProbe, allowedAttributes: [] },
          ]}
          mode={mode}
        >
          {
            'Before the box.\n<box-probe>\n**Bold** body\n</box-probe>\nAfter the box.'
          }
        </InteractiveResponse>,
      );

      const box = screen.getByTestId('box');
      const after = screen.queryByText('After the box.');
      expect({
        bold: box.querySelector('[data-streamdown="strong"], strong')
          ?.textContent,
        body: box.textContent?.trim(),
        before: screen.queryByText('Before the box.')?.tagName,
        after: after?.tagName,
        afterInsideBox: box.contains(after),
      }).toEqual({
        bold: 'Bold',
        body: 'Bold body',
        before: 'P',
        after: 'P',
        afterInsideBox: false,
      });
    } finally {
      cleanup();
    }
  },
);

// The first cited paragraph of a real Meddit answer (#5911): three bold spans
// and a citation in one paragraph.
const medditAnswerParagraph =
  '**1. Dose by indication and the three reduction criteria.** For atrial fibrillation the dose is 5 mg twice daily, reduced to 2.5 mg twice daily if **two or more** of: age ≥80 years, weight ≤60 kg, serum creatinine ≥1.5 mg/dL. Creatinine clearance by itself is not a reduction criterion in the US label — so a frail older patient with CrCl 28 mL/min does not automatically get 2.5 mg, but an 82-year-old, 55-kg woman with SCr 1.6 does. For VTE treatment: 10 mg twice daily for 7 days, then 5 mg twice daily, with the same two-of-three reduction to 2.5 mg twice daily (VTE prophylaxis after hip/knee replacement is 2.5 mg twice daily with no renal adjustment). Use **Cockcroft-Gault CrCl, not eGFR** — eGFR-based dosing misclassified 4.6% of apixaban users with CKD, and underdosing was associated with worse cardiovascular/neurologic outcomes <passage-cite passage="pubmed:36892077" />.';

test.each([
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const)(
  'a real answer paragraph with bold and a citation renders as one <p> in %s mode',
  (_case, mode) => {
    try {
      const { container } = render(
        <InteractiveResponse elements={[passageCite]} mode={mode}>
          {medditAnswerParagraph}
        </InteractiveResponse>,
      );

      const paragraphs = container.querySelectorAll('p');
      expect({
        paragraphs: paragraphs.length,
        boldInside: paragraphs[0]?.querySelectorAll(
          'strong, [data-streamdown="strong"]',
        ).length,
        citeInside: paragraphs[0]?.contains(screen.getByTestId('cite')),
        divs: container.querySelectorAll('p div, div > [data-testid="cite"]')
          .length,
      }).toEqual({ paragraphs: 1, boldInside: 3, citeInside: true, divs: 0 });
    } finally {
      cleanup();
    }
  },
);

test.each([
  ['a bold word', 'A **bold** claim holds.', 'A bold claim holds.'],
  [
    'only bold',
    '**The whole sentence is bold.**',
    'The whole sentence is bold.',
  ],
])('a sentence with %s stays a <p>', (_case, markdown, text) => {
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {markdown}
      </InteractiveResponse>,
    );

    const paragraphs = container.querySelectorAll('p');
    expect({
      paragraphs: paragraphs.length,
      text: paragraphs[0]?.textContent,
    }).toEqual({ paragraphs: 1, text });
  } finally {
    cleanup();
  }
});

test('italic, a link and inline code beside a citation stay in the sentence’s one <p>', () => {
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {
          'An *italic* word, a [label](https://example.org) and `dose` <passage-cite passage="pubmed:1" /> hold.'
        }
      </InteractiveResponse>,
    );

    const paragraphs = container.querySelectorAll('p');
    expect({
      paragraphs: paragraphs.length,
      // streamdown draws a link as a <button data-streamdown="link">.
      holds: ['em', '[data-streamdown="link"]', 'code'].map(
        (selector) => paragraphs[0]?.querySelector(selector) !== null,
      ),
      citeInside: paragraphs[0]?.contains(screen.getByTestId('cite')),
    }).toEqual({ paragraphs: 1, holds: [true, true, true], citeInside: true });
  } finally {
    cleanup();
  }
});

test('a paragraph that is only an image keeps no wrapper: the image sits where a <p> would', () => {
  const plain = plainSentencePath('Aspirin lowers the risk in adults.');
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {'![the trial chart](https://example.org/chart.png)'}
      </InteractiveResponse>,
    );

    expect(
      tagPath(
        container.querySelector('[data-streamdown="image-wrapper"]'),
        container,
      ),
    ).toEqual([...plain.slice(0, -1), 'DIV']);
  } finally {
    cleanup();
  }
});

test('an image in a sentence, which streamdown draws in block wrappers, keeps the paragraph a <div>', () => {
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {'See ![the trial chart](https://example.org/chart.png) for the curve.'}
      </InteractiveResponse>,
    );

    expect({
      paragraphs: container.querySelectorAll('p').length,
      blockInsideParagraph: container.querySelector('p div') !== null,
      image: container.querySelector('img[alt="the trial chart"]') !== null,
    }).toEqual({ paragraphs: 0, blockInsideParagraph: false, image: true });
  } finally {
    cleanup();
  }
});

test('escaped quotes in a generic attribute survive the rendering pipeline', () => {
  const paramElement = {
    name: 'param-probe',
    component: ParamProbe,
    allowedAttributes: ['param', 'label'],
  };

  try {
    render(
      <InteractiveResponse elements={[paramElement]}>
        {
          '<param-probe label="Revenue by \\"region\\"" param="state"></param-probe>'
        }
      </InteractiveResponse>,
    );

    expect(JSON.parse(screen.getByTestId('probe').textContent ?? '{}')).toEqual(
      { param: 'state', label: 'Revenue by "region"' },
    );
  } finally {
    cleanup();
  }
});

function LabelProbe(props: Record<string, unknown>) {
  return <sup data-testid="label-probe" data-label={String(props.label)} />;
}

test.each([
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const)(
  'attribute values holding *, as SQL and bold do, reach the element unchanged and add no emphasis in %s mode',
  (_case, mode) => {
    const values = [
      'SELECT COUNT(*) AS value FROM orders',
      'SELECT COUNT(*) AS a, SUM(*) AS b FROM t',
      '**Deliverability is solid** at 98%.',
    ];
    const inSentence = values
      .map((value) => `<label-probe label="${value}" />`)
      .join(' and ');
    const blocks = values
      .map((value) => `<label-probe label="${value}"></label-probe>`)
      .join('\n\n');

    try {
      const { container } = render(
        <InteractiveResponse
          elements={[
            {
              name: 'label-probe',
              component: LabelProbe,
              allowedAttributes: ['label'],
            },
          ]}
          mode={mode}
        >
          {`Totals ${inSentence} here.\n\n${blocks}\n\nDone.`}
        </InteractiveResponse>,
      );

      const probes = screen.getAllByTestId('label-probe');
      expect({
        labels: probes.map((probe) => probe.dataset.label),
        sentence: probes[0]?.closest('p')?.textContent,
        emphasis: container.querySelectorAll(
          'em, strong, [data-streamdown="strong"]',
        ).length,
        last: [...container.querySelectorAll('p')].at(-1)?.textContent,
      }).toEqual({
        labels: [...values, ...values],
        sentence: 'Totals  and  and  here.',
        emphasis: 0,
        last: 'Done.',
      });
    } finally {
      cleanup();
    }
  },
);

test.each([
  ['static', 'static'],
  ['the chat’s streaming', undefined],
] as const)(
  'in a right-to-left page each answer block takes its own text direction in %s mode (#5919)',
  (_case, mode) => {
    try {
      const { container } = render(
        <div dir="rtl">
          <InteractiveResponse elements={[passageCite]} mode={mode}>
            {`${medditAnswerParagraph}\n\nالجرعة القياسية هي ٥ ملغ مرتين يوميا.\n\n- An English item\n- Another English item`}
          </InteractiveResponse>
        </div>,
      );

      // A block's direction is its own dir, or its nearest ancestor's: streaming
      // mode puts dir on a display:contents wrapper around each block.
      expect(
        [...container.querySelectorAll('p, li')].map((block) =>
          block.closest('[dir]')?.getAttribute('dir'),
        ),
      ).toEqual(['ltr', 'rtl', 'ltr', 'ltr']);
    } finally {
      cleanup();
    }
  },
);

test('reasoning and error text, which render through Response, take their own text direction in a right-to-left page (#5919)', () => {
  try {
    const { container } = render(
      <div dir="rtl">
        <Response mode="static">
          {
            'The model weighed renal function first.\n\nثم راجع التداخلات الدوائية.'
          }
        </Response>
      </div>,
    );

    expect(
      [...container.querySelectorAll('p')].map((block) =>
        block.closest('[dir]')?.getAttribute('dir'),
      ),
    ).toEqual(['ltr', 'rtl']);
  } finally {
    cleanup();
  }
});

test('in a right-to-left page an English sentence holding an image keeps its own direction (#5919)', () => {
  try {
    const { container } = render(
      <div dir="rtl">
        <InteractiveResponse elements={[passageCite]} mode="static">
          {
            'See ![the trial chart](https://example.org/chart.png) for the curve.'
          }
        </InteractiveResponse>
      </div>,
    );

    expect(
      container
        .querySelector('img[alt="the trial chart"]')
        ?.closest('[dir]')
        ?.getAttribute('dir'),
    ).toBe('ltr');
  } finally {
    cleanup();
  }
});

function QuoteCiteProbe(props: Record<string, unknown>) {
  return (
    <sup
      data-testid="quote-cite"
      data-passage={String(props.passage)}
      data-quote={String(props.quote)}
    >
      [{String(props.passage)}]
    </sup>
  );
}

const quotedPassageCite = {
  name: 'passage-cite',
  component: QuoteCiteProbe,
  allowedAttributes: ['passage', 'quote'],
};

test.each([
  [
    'curly double quotes',
    '<passage-cite passage=”pubmed:1” quote=”eGFR below 30” />',
  ],
  [
    'opening and closing curly double quotes',
    '<passage-cite passage=“pubmed:1” quote=“eGFR below 30” />',
  ],
  [
    'curly single quotes',
    '<passage-cite passage=‘pubmed:1’ quote=‘eGFR below 30’ />',
  ],
])(
  'a declared element written with %s renders as the element, not as raw text (#5945)',
  (_case, tag) => {
    try {
      const { container } = render(
        <InteractiveResponse elements={[quotedPassageCite]}>
          {`Apixaban needs no change ${tag} in mild impairment.`}
        </InteractiveResponse>,
      );

      const cite = screen.getByTestId('quote-cite');
      expect({
        passage: cite.dataset.passage,
        quote: cite.dataset.quote,
        rawTagShown: container.textContent?.includes('passage-cite'),
        inSentence: cite.closest('p')?.textContent,
      }).toEqual({
        passage: 'pubmed:1',
        quote: 'eGFR below 30',
        rawTagShown: false,
        inSentence: 'Apixaban needs no change [pubmed:1] in mild impairment.',
      });
    } finally {
      cleanup();
    }
  },
);

test('a tag that is not a declared element keeps the curly quotes the model wrote (#5945)', () => {
  try {
    const { container } = render(
      <InteractiveResponse elements={[quotedPassageCite]}>
        {'Write `<img alt=”a scan”>` to show the image.'}
      </InteractiveResponse>,
    );

    expect(container.querySelector('code')?.textContent).toBe(
      '<img alt=”a scan”>',
    );
  } finally {
    cleanup();
  }
});
