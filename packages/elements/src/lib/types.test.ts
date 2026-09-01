import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertNoReservedAttributes,
  findDuplicateName,
} from '@deepagents/elements';

describe('assertNoReservedAttributes', () => {
  it('passes an element with only domain attributes', () => {
    assertNoReservedAttributes({
      name: 'open-invoice',
      allowedAttributes: ['invoice-id', 'param'],
    });
  });

  it('throws naming every reserved attribute the element declares', () => {
    assert.throws(
      () =>
        assertNoReservedAttributes({
          name: 'sneaky',
          allowedAttributes: ['safe', 'id', 'name'],
        }),
      (error: Error) => {
        assert.match(error.message, /<sneaky>/);
        assert.match(error.message, /id, name/);
        return true;
      },
    );
  });

  it('passes an element with no attributes', () => {
    assertNoReservedAttributes({ name: 'plain', allowedAttributes: [] });
  });
});

describe('findDuplicateName', () => {
  it('returns undefined for unique names', () => {
    assert.equal(
      findDuplicateName([{ name: 'one' }, { name: 'two' }]),
      undefined,
    );
  });

  it('returns the first duplicated name', () => {
    assert.equal(
      findDuplicateName([{ name: 'one' }, { name: 'two' }, { name: 'one' }]),
      'one',
    );
  });
});
