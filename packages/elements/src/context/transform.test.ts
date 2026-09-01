import { simulateReadableStream } from 'ai';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { elementsStreamTransform } from '@deepagents/elements/context';

async function collectTexts(
  chunks: Array<{ type: 'text-delta'; text: string; id: string }>,
): Promise<string[]> {
  const stream = simulateReadableStream({ chunks, chunkDelayInMs: null });
  const transform = elementsStreamTransform({
    tools: {},
    stopStream: () => undefined,
  });
  const texts: string[] = [];
  for await (const chunk of stream.pipeThrough(transform)) {
    if (chunk.type === 'text-delta' && chunk.text) {
      texts.push(chunk.text);
    }
  }
  return texts;
}

const delta = (text: string) => ({
  type: 'text-delta' as const,
  text,
  id: '1',
});

describe('elementsStreamTransform', () => {
  it('never emits a partial custom tag while an element streams', async () => {
    const texts = await collectTexts([
      delta('Before '),
      delta('<followup '),
      delta('question="What '),
      delta('drove the spike?"'),
      delta('></followup>'),
      delta(' after '),
    ]);

    for (const text of texts) {
      const opens = text.includes('<followup');
      const closes = text.includes('</followup>');
      assert.equal(
        opens,
        closes,
        `Chunk ${JSON.stringify(text)} contains a partial element`,
      );
    }
    const element = texts.find((text) => text.includes('<followup'));
    assert.equal(
      element,
      '<followup question="What drove the spike?"></followup>',
    );
  });

  it('chunks regular text word by word', async () => {
    const texts = await collectTexts([
      delta('Hello '),
      delta('world '),
      delta('foo '),
    ]);

    assert.ok(texts.includes('Hello '));
    assert.ok(texts.includes('world '));
    assert.ok(texts.includes('foo '));
  });

  it('emits a self-closing element as one chunk', async () => {
    const texts = await collectTexts([
      delta('<kpi '),
      delta('title="Revenue" '),
      delta('/>'),
    ]);

    assert.ok(texts.includes('<kpi title="Revenue" />'));
  });

  it('ignores a closing tag inside an HTML comment', async () => {
    const texts = await collectTexts([
      delta('<kpi title="x"><!-- </kpi> -->'),
      delta('real</kpi>'),
    ]);

    const element = texts.find((text) => text.startsWith('<kpi'));
    assert.equal(element, '<kpi title="x"><!-- </kpi> -->real</kpi>');
  });

  it('passes element content through verbatim, escape sequences included', async () => {
    const texts = await collectTexts([delta('<kpi sql="SELECT\\n  *" />')]);

    assert.ok(texts.includes('<kpi sql="SELECT\\n  *" />'));
  });

  it('emits repeated same-name elements as separate chunks', async () => {
    const texts = await collectTexts([
      delta(
        '<followup question="A?"></followup><followup question="B?"></followup>',
      ),
    ]);

    assert.deepEqual(texts, [
      '<followup question="A?"></followup>',
      '<followup question="B?"></followup>',
    ]);
  });

  it('does not swallow text between same-name elements', async () => {
    const texts = await collectTexts([
      delta('<kpi title="a" /> then <kpi title="b" />'),
    ]);

    assert.ok(texts.includes('<kpi title="a" />'));
    assert.ok(texts.includes('<kpi title="b" />'));
    assert.equal(texts.join(''), '<kpi title="a" /> then <kpi title="b" />');
  });

  it('treats a lone angle bracket as plain text', async () => {
    const texts = await collectTexts([delta('5 < 10 is '), delta('true ')]);

    assert.equal(texts.join(''), '5 < 10 is true ');
  });
});
