import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isValidAdapterName, validateAdapterNames } from '@deepagents/text2sql';

describe('isValidAdapterName: accepts SQL-identifier-shaped names', () => {
  it('plain alpha', () => {
    assert.equal(isValidAdapterName('users'), true);
  });

  it('leading underscore', () => {
    assert.equal(isValidAdapterName('_internal'), true);
  });

  it('trailing digits', () => {
    assert.equal(isValidAdapterName('db1'), true);
  });

  it('single char', () => {
    assert.equal(isValidAdapterName('a'), true);
    assert.equal(isValidAdapterName('_'), true);
  });

  it('mixed case with underscores', () => {
    assert.equal(isValidAdapterName('Reporting_DB_v2'), true);
  });
});

describe('isValidAdapterName: rejects invalid names', () => {
  it('empty string', () => {
    assert.equal(isValidAdapterName(''), false);
  });

  it('null and undefined', () => {
    assert.equal(isValidAdapterName(null), false);
    assert.equal(isValidAdapterName(undefined), false);
  });

  it('leading digit', () => {
    assert.equal(isValidAdapterName('1bad'), false);
    assert.equal(isValidAdapterName('9'), false);
  });

  it('hyphen', () => {
    assert.equal(isValidAdapterName('bad-name'), false);
  });

  it('dot', () => {
    assert.equal(isValidAdapterName('schema.table'), false);
  });

  it('whitespace', () => {
    assert.equal(isValidAdapterName('bad name'), false);
    assert.equal(isValidAdapterName(' bad'), false);
    assert.equal(isValidAdapterName('bad '), false);
  });

  it('shell metacharacters', () => {
    assert.equal(isValidAdapterName('db;rm'), false);
    assert.equal(isValidAdapterName('db|cat'), false);
    assert.equal(isValidAdapterName('db$x'), false);
  });

  it('non-ASCII letters', () => {
    assert.equal(isValidAdapterName('café'), false);
    assert.equal(isValidAdapterName('日本'), false);
  });
});

describe('validateAdapterNames: throws on first invalid name', () => {
  it('passes silently for an all-valid iterable', () => {
    assert.doesNotThrow(() => validateAdapterNames(['a', 'b_2', '_c']));
  });

  it('throws naming the bad key and the pattern', () => {
    assert.throws(
      () => validateAdapterNames(['ok', '1bad', 'also_ok']),
      (err: Error) => {
        assert.match(err.message, /Invalid adapter name "1bad"/);
        assert.match(err.message, /\[A-Za-z_\]\[A-Za-z0-9_\]/);
        return true;
      },
    );
  });

  it('accepts any iterable (Set, generator)', () => {
    assert.doesNotThrow(() => validateAdapterNames(new Set(['a', 'b', 'c'])));
    function* gen() {
      yield 'gen_a';
      yield 'gen_b';
    }
    assert.doesNotThrow(() => validateAdapterNames(gen()));
  });

  it('rejects the reserved "database" name (the schema label tag)', () => {
    assert.throws(
      () => validateAdapterNames(['ok', 'database']),
      (err: Error) => {
        assert.match(err.message, /Adapter name "database" is reserved/);
        return true;
      },
    );
  });
});
