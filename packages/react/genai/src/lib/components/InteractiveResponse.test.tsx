import { cleanup, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

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

test('top-level custom elements stay wrapped in a bare class-less div', () => {
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
      <InteractiveResponse elements={[paramElement]}>
        {'<param-probe param="state"></param-probe>'}
      </InteractiveResponse>,
    );

    const wrapper = screen.getByTestId('probe').parentElement;
    expect(wrapper?.tagName).toBe('DIV');
    expect(wrapper?.hasAttribute('class')).toBe(false);
  } finally {
    cleanup();
  }
});

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

test('an element alone on a line between two lines of text keeps the text after it', () => {
  try {
    const { container } = render(
      <InteractiveResponse elements={[passageCite]}>
        {
          'Aspirin lowers the risk.\n<passage-cite passage="pubmed:1" />\nIt works in adults.'
        }
      </InteractiveResponse>,
    );

    expect({
      text: container.textContent,
      afterInsideCite: screen
        .getByTestId('cite')
        .contains(screen.getByText('It works in adults.')),
    }).toEqual({
      text: 'Aspirin lowers the risk.\n[pubmed:1]It works in adults.',
      afterInsideCite: false,
    });
  } finally {
    cleanup();
  }
});

test('self-closing elements on lines of their own stay blocks, outside any paragraph', () => {
  try {
    render(
      <InteractiveResponse elements={[passageCite]}>
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
