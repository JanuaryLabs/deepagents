import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  formatAxisDate,
  formatISODate,
  isISODateString,
} from '@deepagents/react-formatters';

describe('isISODateString', () => {
  it('accepts date-only ISO', () => {
    assert.strictEqual(isISODateString('2026-05-16'), true);
  });

  it('accepts full datetime ISO with Z', () => {
    assert.strictEqual(isISODateString('2026-05-16T12:30:45.000Z'), true);
  });

  it('accepts datetime ISO with offset', () => {
    assert.strictEqual(isISODateString('2026-05-16T12:30:45+02:00'), true);
  });

  it('rejects non-ISO strings', () => {
    assert.strictEqual(isISODateString('May 16, 2026'), false);
  });

  it('rejects non-string values', () => {
    assert.strictEqual(isISODateString(20260516), false);
    assert.strictEqual(isISODateString(null), false);
  });
});

describe('formatISODate', () => {
  it('formats a date-only value without a time component', () => {
    assert.strictEqual(formatISODate('2026-05-16'), 'May 16, 2026');
  });

  it('formats a midnight UTC value as date-only', () => {
    assert.strictEqual(
      formatISODate('2026-05-16T00:00:00.000Z'),
      'May 16, 2026',
    );
  });

  it('returns the input verbatim for invalid dates', () => {
    assert.strictEqual(formatISODate('not-a-date'), 'not-a-date');
  });
});

describe('formatAxisDate', () => {
  it('formats day granularity as "MMM d"', () => {
    assert.strictEqual(formatAxisDate('2026-05-16', 'day'), 'May 16');
  });

  it('formats month granularity as "MMM yyyy"', () => {
    assert.strictEqual(formatAxisDate('2026-05-16', 'month'), 'May 2026');
  });

  it('defaults to month granularity', () => {
    assert.strictEqual(formatAxisDate('2026-05-16'), 'May 2026');
  });
});
