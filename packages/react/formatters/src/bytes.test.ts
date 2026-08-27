import assert from 'node:assert';
import { describe, it } from 'node:test';

import { formatBytes, formatFileSize } from '@deepagents/react-formatters';

describe('formatBytes (decimal basis)', () => {
  it('formats under 1000 as raw B with a unit space', () => {
    assert.strictEqual(formatBytes(512), '512 B');
  });

  it('formats 1500 as 1.5 KB', () => {
    assert.strictEqual(formatBytes(1500), '1.5 KB');
  });

  it('formats 2,500,000 as 2.5 MB', () => {
    assert.strictEqual(formatBytes(2_500_000), '2.5 MB');
  });

  it('formats 3,000,000,000 as 3.0 GB', () => {
    assert.strictEqual(formatBytes(3_000_000_000), '3.0 GB');
  });

  it('returns em-dash for null', () => {
    assert.strictEqual(formatBytes(null), '—');
  });
});

describe('formatFileSize (binary basis)', () => {
  it('formats under 1024 as raw B', () => {
    assert.strictEqual(formatFileSize(512), '512 B');
  });

  it('formats 2048 as 2.0 KB', () => {
    assert.strictEqual(formatFileSize(2048), '2.0 KB');
  });

  it('formats 1,048,576 as 1.0 MB', () => {
    assert.strictEqual(formatFileSize(1_048_576), '1.0 MB');
  });

  it('returns em-dash for null', () => {
    assert.strictEqual(formatFileSize(null), '—');
  });

  it('returns em-dash for undefined', () => {
    assert.strictEqual(formatFileSize(undefined), '—');
  });
});
