import { describe, expect, it, vi } from 'vitest';

import { formatUsageBreakdown } from './usage.ts';

describe('formatUsageBreakdown', () => {
  it('groups the total tokens in en-US like the other values when the ambient locale is de-DE', () => {
    const toLocaleString = Number.prototype.toLocaleString;
    const spy = vi
      .spyOn(Number.prototype, 'toLocaleString')
      .mockImplementation(function (this: number, locales, options) {
        return toLocaleString.call(this, locales ?? 'de-DE', options);
      });
    try {
      expect(
        formatUsageBreakdown({
          inputTokens: 1_200_000,
          outputTokens: 34_567,
          reasoningTokens: null,
          totalTokens: 1_234_567,
          cachedInputTokens: null,
        }),
      ).toBe('↑ 1.2M ↓ 34.6K · 1,234,567 tokens');
    } finally {
      spy.mockRestore();
    }
  });
});
