import assert from 'node:assert';
import { describe, it } from 'vitest';

import {
  formatCompactNumber,
  formatCurrency,
  formatNullableNumber,
  formatNumber,
  formatPercent,
} from '@deepagents/react-formatters';

describe('formatNumber', () => {
  it('formats with en-US grouping by default', () => {
    assert.strictEqual(formatNumber(1234567), '1,234,567');
  });

  it('honors locale override', () => {
    assert.strictEqual(formatNumber(1234.5, { locale: 'de-DE' }), '1.234,5');
  });

  it('passes through Intl options like maximumFractionDigits', () => {
    assert.strictEqual(
      formatNumber(1.23456, { maximumFractionDigits: 2 }),
      '1.23',
    );
  });

  it('returns em-dash for null by default', () => {
    assert.strictEqual(formatNumber(null), '—');
  });

  it('returns em-dash for undefined by default', () => {
    assert.strictEqual(formatNumber(undefined), '—');
  });

  it('honors whenNullish override', () => {
    assert.strictEqual(formatNumber(null, { whenNullish: 'N/A' }), 'N/A');
  });

  it('returns whenNullish for NaN', () => {
    assert.strictEqual(formatNumber(Number.NaN), '—');
  });

  it('honors whenNullish override for NaN', () => {
    assert.strictEqual(formatNumber(Number.NaN, { whenNullish: 'N/A' }), 'N/A');
  });
});

describe('formatNullableNumber', () => {
  it('formats numbers like formatNumber', () => {
    assert.strictEqual(formatNullableNumber(1234), '1,234');
  });

  it('returns em-dash fallback for null', () => {
    assert.strictEqual(formatNullableNumber(null), '—');
  });

  it('returns em-dash fallback for NaN', () => {
    assert.strictEqual(formatNullableNumber(Number.NaN), '—');
  });

  it('honors whenNullish override', () => {
    assert.strictEqual(
      formatNullableNumber(null, { whenNullish: 'N/A' }),
      'N/A',
    );
  });
});

describe('formatCompactNumber', () => {
  it('uses compact notation for large values', () => {
    assert.strictEqual(formatCompactNumber(1500), '1.5K');
  });

  it('uses compact notation for millions', () => {
    assert.strictEqual(formatCompactNumber(2_500_000), '2.5M');
  });

  it('returns em-dash for null', () => {
    assert.strictEqual(formatCompactNumber(null), '—');
  });
});

describe('formatCurrency', () => {
  it('formats USD by default', () => {
    assert.strictEqual(formatCurrency(1234.5), '$1,234.50');
  });

  it('honors custom currency code', () => {
    assert.strictEqual(formatCurrency(99, { currency: 'EUR' }), '€99.00');
  });

  it('returns em-dash for null', () => {
    assert.strictEqual(formatCurrency(null), '—');
  });
});

describe('formatPercent', () => {
  it('treats input as a value in 0-100 range', () => {
    assert.strictEqual(formatPercent(45.2), '45.2%');
  });

  it('formats 100 as 100.0%', () => {
    assert.strictEqual(formatPercent(100), '100.0%');
  });

  it('returns em-dash for null', () => {
    assert.strictEqual(formatPercent(null), '—');
  });

  it('returns em-dash for NaN', () => {
    assert.strictEqual(formatPercent(Number.NaN), '—');
  });
});
