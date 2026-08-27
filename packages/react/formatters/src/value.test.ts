import assert from 'node:assert';
import { describe, it } from 'node:test';

import { formatByType, formatCellValue } from '@deepagents/react-formatters';

describe('formatCellValue', () => {
  it('returns NULL placeholder for null', () => {
    assert.strictEqual(formatCellValue(null), 'NULL');
  });

  it('returns NULL placeholder for undefined', () => {
    assert.strictEqual(formatCellValue(undefined), 'NULL');
  });

  it('formats ISO date strings via formatISODate', () => {
    assert.strictEqual(formatCellValue('2026-05-16'), 'May 16, 2026');
  });

  it('JSON-stringifies non-date objects', () => {
    assert.strictEqual(formatCellValue({ a: 1 }), '{"a":1}');
  });

  it('coerces other primitives to string', () => {
    assert.strictEqual(formatCellValue(42), '42');
    assert.strictEqual(formatCellValue(false), 'false');
  });
});

describe('formatByType', () => {
  it('returns N/A for null regardless of type', () => {
    assert.strictEqual(formatByType(null, 'number'), 'N/A');
    assert.strictEqual(formatByType(undefined, 'currency'), 'N/A');
  });

  it('formats numeric type with locale grouping', () => {
    assert.strictEqual(formatByType(1234, 'number'), '1,234');
  });

  it('formats currency type as USD', () => {
    assert.strictEqual(formatByType(99, 'currency'), '$99.00');
  });

  it('formats boolean type as ✓ / ✗', () => {
    assert.strictEqual(formatByType(true, 'boolean'), '✓');
    assert.strictEqual(formatByType(false, 'boolean'), '✗');
  });

  it('formats ISO date strings via formatISODate', () => {
    assert.strictEqual(formatByType('2026-05-16', 'date'), 'May 16, 2026');
  });

  it('returns N/A for invalid date inputs', () => {
    assert.strictEqual(formatByType('not-a-date', 'date'), 'N/A');
    assert.strictEqual(formatByType({}, 'date'), 'N/A');
    assert.strictEqual(formatByType(true, 'date'), 'N/A');
  });

  it('returns text/url/email as String(value)', () => {
    assert.strictEqual(formatByType('hello', 'text'), 'hello');
    assert.strictEqual(formatByType('a@b.com', 'email'), 'a@b.com');
    assert.strictEqual(formatByType('https://x', 'url'), 'https://x');
  });
});
