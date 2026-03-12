import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type SerializedFragment,
  assistantText,
  fromFragment,
  hint,
  policy,
  principle,
  term,
  toFragment,
} from '@deepagents/context';

describe('serialized fragment conversion', () => {
  const roundTripCases: SerializedFragment[] = [
    { type: 'term', name: 'MRR', definition: 'monthly recurring revenue' },
    { type: 'hint', text: 'Always exclude test accounts' },
    {
      type: 'guardrail',
      rule: 'Never expose PII',
      reason: 'privacy',
      action: 'aggregate instead',
    },
    {
      type: 'explain',
      concept: 'churn',
      explanation: 'customers leaving over time',
      therefore: 'measure it monthly',
    },
    {
      type: 'example',
      question: 'top customers',
      answer: 'SELECT * FROM customers LIMIT 10',
      note: 'illustrative only',
    },
    {
      type: 'clarification',
      when: 'user says revenue',
      ask: 'gross or net revenue?',
      reason: 'both metrics exist',
    },
    {
      type: 'workflow',
      task: 'Revenue analysis',
      steps: ['sum invoices', 'subtract credits'],
      triggers: ['revenue', 'sales'],
      notes: 'Use posted invoices only',
    },
    {
      type: 'quirk',
      issue: 'IDs lose leading zeros',
      workaround: 'LPAD before compare',
    },
    {
      type: 'styleGuide',
      prefer: 'Use explicit aliases',
      never: 'SELECT *',
      always: 'Use LIMIT',
    },
    {
      type: 'analogy',
      concepts: ['logo churn', 'revenue churn'],
      relationship: 'customers lost vs revenue lost',
      insight: 'customer count and revenue impact differ',
      therefore: 'report both',
      pitfall: 'do not conflate them',
    },
    {
      type: 'glossary',
      entries: {
        revenue: 'SUM(orders.total_amount)',
        netRevenue: 'SUM(orders.total_amount) - SUM(refunds.amount)',
      },
    },
    { type: 'role', content: 'Be precise and concise.' },
    {
      type: 'principle',
      title: 'Risk assessment',
      description: 'Evaluate consequences before acting',
      policies: [
        'Prefer low-risk actions first',
        {
          type: 'policy',
          rule: 'Validate assumptions before destructive actions',
          reason: 'avoid accidental damage',
          policies: [
            {
              type: 'policy',
              rule: 'Ask for confirmation when intent is ambiguous',
            },
          ],
        },
      ],
    },
    {
      type: 'policy',
      rule: 'Validate SQL syntax',
      before: 'executing queries',
      reason: 'catch errors early',
      policies: ['Check references exist'],
    },
    { type: 'identity', name: 'Mo', role: 'Engineer' },
    {
      type: 'persona',
      name: 'Freya',
      role: 'Data assistant',
      objective: 'Answer accurately',
      tone: 'concise',
    },
    { type: 'alias', term: 'the big table', meaning: 'orders table' },
    { type: 'preference', aspect: 'date format', value: 'YYYY-MM-DD' },
    {
      type: 'correction',
      subject: 'status column',
      clarification: '1 means active',
    },
  ];

  for (const testCase of roundTripCases) {
    it(`round-trips ${testCase.type}`, () => {
      const fragment = toFragment(testCase);

      assert.strictEqual(fragment.name, testCase.type);
      assert.deepStrictEqual(fromFragment(fragment), testCase);
    });
  }

  it('round-trips nested principle and policy fragments', () => {
    const fragment = principle({
      title: 'Execution order',
      description: 'Preserve prerequisites',
      policies: [
        policy({
          rule: 'Validate schema first',
          policies: [policy({ rule: 'Check table names' })],
        }),
      ],
    });

    assert.deepStrictEqual(fromFragment(fragment), {
      type: 'principle',
      title: 'Execution order',
      description: 'Preserve prerequisites',
      policies: [
        {
          type: 'policy',
          rule: 'Validate schema first',
          policies: [{ type: 'policy', rule: 'Check table names' }],
        },
      ],
    });
  });

  it('decodes non-message codecs to the fragment data shape', () => {
    const simple = hint('Always exclude test accounts');
    assert.strictEqual(simple.codec?.decode(), simple.data);

    const objectLike = term('MRR', 'monthly recurring revenue');
    assert.deepStrictEqual(objectLike.codec?.decode(), objectLike.data);

    const nested = principle({
      title: 'Execution order',
      description: 'Preserve prerequisites',
      policies: [policy({ rule: 'Validate schema first' })],
    });
    assert.deepStrictEqual(nested.codec?.decode(), nested.data);
  });

  it('throws on unknown serialized fragment types', () => {
    assert.throws(
      () => toFragment({ type: 'unknown' } as never),
      /Unsupported serialized fragment type: unknown/,
    );
  });

  it('throws on unknown fragment names', () => {
    assert.throws(
      () => fromFragment({ name: 'unknown', data: 'x' }),
      /Unsupported fragment name: unknown/,
    );
  });

  it('throws on message fragments', () => {
    assert.throws(
      () => fromFragment(assistantText('Done')),
      /Message fragments are not supported/,
    );
  });

  it('throws when nested message fragments are encountered', () => {
    assert.throws(
      () =>
        toFragment({
          type: 'principle',
          title: 'Messaging',
          description: 'No message fragments',
          policies: [assistantText('Done') as never],
        }),
      /Message fragments are not supported/,
    );
  });
});
