import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContextFragment } from '@deepagents/context';
import { elementsFragment } from '@deepagents/elements/context';

describe('elementsFragment', () => {
  it('wraps descriptors into structured element child fragments', () => {
    const fragment = elementsFragment([
      {
        name: 'followup',
        allowedAttributes: ['question'],
        description: 'Suggest a follow-up question',
      },
      { name: 'kpi', allowedAttributes: ['title', 'value'] },
    ]);

    assert.equal(fragment.name, 'elements');
    const children = fragment.data as ContextFragment[];
    assert.equal(children.length, 3);
    assert.equal(children[0].name, 'instructions');
    assert.match(String(children[0].data), /Never invent elements/);
    assert.deepEqual(children[1], {
      name: 'element',
      data: {
        name: 'followup',
        description: 'Suggest a follow-up question',
        'allowed-attributes': 'question',
      },
    });
    assert.deepEqual(children[2], {
      name: 'element',
      data: {
        name: 'kpi',
        'allowed-attributes': 'title, value',
      },
    });
  });

  it('exposes the descriptor snapshot on metadata without rendering it', () => {
    const descriptors = [{ name: 'followup', allowedAttributes: ['question'] }];

    const fragment = elementsFragment(descriptors);

    assert.deepEqual(fragment.metadata, {
      elements: [
        {
          name: 'followup',
          allowedAttributes: ['question'],
          description: undefined,
        },
      ],
    });
  });

  it('produces an empty fragment for an empty catalog', () => {
    const fragment = elementsFragment([]);

    assert.deepEqual(fragment, {
      name: 'elements',
      data: [],
      metadata: { elements: [] },
    });
  });

  it('is deterministic for identical input', () => {
    const descriptors = [
      { name: 'kpi', allowedAttributes: ['title'], description: 'A metric' },
    ];

    assert.deepEqual(
      elementsFragment(descriptors),
      elementsFragment(descriptors),
    );
  });
});
