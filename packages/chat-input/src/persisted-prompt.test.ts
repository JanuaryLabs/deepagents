import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  serializePersistedPromptLink,
  serializeSkillPromptLink,
  tokenizePersistedPrompt,
} from '@deepagents/chat-input';

describe('persisted prompt links', () => {
  it('round-trips escaped labels and destinations', () => {
    const source = serializePersistedPromptLink(
      'Revenue [Q2]',
      'https://example.com/report_(final)',
    );

    assert.equal(
      source,
      '[Revenue \\[Q2\\]](https://example.com/report_\\(final\\))',
    );
    assert.deepEqual(tokenizePersistedPrompt(source), [
      {
        kind: 'link',
        label: 'Revenue [Q2]',
        href: 'https://example.com/report_(final)',
        source,
        start: 0,
        end: source.length,
      },
    ]);
  });

  it('finds multiple links without treating malformed markup as a link', () => {
    const source =
      'Read [the report](https://example.com) with [missing](destination and [valid](https://openai.com).';

    assert.deepEqual(
      tokenizePersistedPrompt(source).filter((token) => token.kind === 'link'),
      [
        {
          kind: 'link',
          label: 'the report',
          href: 'https://example.com',
          source: '[the report](https://example.com)',
          start: 5,
          end: 38,
        },
        {
          kind: 'link',
          label: 'valid',
          href: 'https://openai.com',
          source: '[valid](https://openai.com)',
          start: 70,
          end: 97,
        },
      ],
    );
  });
});

describe('persisted skill links', () => {
  it('uses the selected skill label and stable skill id', () => {
    const source = serializeSkillPromptLink('Revenue Analysis', 'skill-123');

    assert.equal(source, '[$Revenue Analysis](skill://skill-123)');
    assert.deepEqual(tokenizePersistedPrompt(source), [
      {
        kind: 'skill-link',
        label: '$Revenue Analysis',
        name: 'Revenue Analysis',
        skillId: 'skill-123',
        href: 'skill://skill-123',
        source,
        start: 0,
        end: source.length,
      },
    ]);
  });

  it('does not activate ordinary links or skill URIs without a skill sigil', () => {
    const tokens = tokenizePersistedPrompt(
      '[Revenue](skill://skill-123) [$docs](https://example.com)',
    );

    assert.equal(
      tokens.some((token) => token.kind === 'skill-link'),
      false,
    );
  });

  it('gives code precedence and preserves the exact source partition', () => {
    const source =
      'Use `[$ignored](skill://ignored)` with [$report](skill://report), $review, and ```md\n[$also-ignored](skill://also-ignored)\n```.';
    const tokens = tokenizePersistedPrompt(source);

    assert.equal(tokens.map((token) => token.source).join(''), source);
    assert.deepEqual(
      tokens
        .filter((token) => token.kind === 'skill-link')
        .map((token) => token.skillId),
      ['report'],
    );
    assert.deepEqual(
      tokens
        .filter((token) => token.kind === 'standalone-skill')
        .map((token) => token.name),
      ['review'],
    );
  });
});
