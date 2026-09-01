import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineElements } from '@deepagents/elements';

describe('defineElements', () => {
  it('returns the validated registry with host fields intact', () => {
    const component = () => null;

    const elements = defineElements([
      {
        name: 'followup',
        allowedAttributes: ['question'],
        description: 'Suggest a follow-up question',
        component,
      },
    ]);

    assert.equal(elements.length, 1);
    assert.equal(elements[0].name, 'followup');
    assert.equal(elements[0].component, component);
  });

  it('throws on an invalid element name', () => {
    assert.throws(
      () => defineElements([{ name: 'BadName', allowedAttributes: [] }]),
      /Interactive element <BadName> is invalid/,
    );
  });

  it('throws on a reserved attribute', () => {
    assert.throws(
      () => defineElements([{ name: 'sneaky', allowedAttributes: ['id'] }]),
      /Interactive element <sneaky> is invalid/,
    );
  });

  it('throws on duplicate element names', () => {
    assert.throws(
      () =>
        defineElements([
          { name: 'twin', allowedAttributes: ['a'] },
          { name: 'twin', allowedAttributes: ['b'] },
        ]),
      /Duplicate element name <twin>/,
    );
  });

  it('accepts an empty registry', () => {
    assert.deepEqual(defineElements([]), []);
  });
});
