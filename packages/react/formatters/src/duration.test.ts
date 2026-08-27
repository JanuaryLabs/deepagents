import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  formatDurationBetween,
  formatDurationFromSeconds,
} from '@deepagents/react-formatters';

describe('formatDurationBetween', () => {
  it('formats sub-minute spans in seconds', () => {
    const start = '2026-05-16T00:00:00.000Z';
    const end = '2026-05-16T00:00:42.000Z';
    assert.strictEqual(formatDurationBetween(start, end), '42.00 s');
  });

  it('formats sub-hour spans in minutes', () => {
    const start = '2026-05-16T00:00:00.000Z';
    const end = '2026-05-16T00:30:00.000Z';
    assert.strictEqual(formatDurationBetween(start, end), '30.00 min');
  });

  it('formats hour-plus spans in hours', () => {
    const start = '2026-05-16T00:00:00.000Z';
    const end = '2026-05-16T02:30:00.000Z';
    assert.strictEqual(formatDurationBetween(start, end), '2.50 h');
  });
});

describe('formatDurationFromSeconds', () => {
  it('formats hours and minutes when hour boundary crossed', () => {
    assert.strictEqual(formatDurationFromSeconds(3 * 3600 + 15 * 60), '3h 15m');
  });

  it('formats minutes and seconds when minute boundary crossed', () => {
    assert.strictEqual(formatDurationFromSeconds(90), '1m 30s');
  });

  it('formats seconds only when under a minute', () => {
    assert.strictEqual(formatDurationFromSeconds(45), '45s');
  });

  it('treats negative seconds as their absolute value', () => {
    assert.strictEqual(formatDurationFromSeconds(-90), '1m 30s');
  });
});
