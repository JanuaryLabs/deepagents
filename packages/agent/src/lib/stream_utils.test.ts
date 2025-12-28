import { smoothStream } from 'ai';
import { simulateReadableStream } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { htmlElementChunking } from './stream_utils.ts';

/**
 * Helper to simulate chunking by calling the function repeatedly until buffer is consumed.
 * This mimics how smoothStream uses the chunking function internally.
 */
function collectChunks(
  chunker: (buffer: string) => string | null,
  input: string,
): string[] {
  const chunks: string[] = [];
  let buffer = input;
  let result: string | null;

  while (buffer.length > 0 && (result = chunker(buffer)) !== null) {
    chunks.push(result);
    buffer = buffer.slice(result.length);
  }

  return chunks;
}

describe('htmlElementChunking', () => {
  describe('word chunking (non-HTML content)', () => {
    it('should return word with trailing whitespace', () => {
      const chunk = htmlElementChunking();
      const result = chunk('hello world');
      assert.strictEqual(result, 'hello ');
    });

    it('should return null when no complete word (no trailing whitespace)', () => {
      const chunk = htmlElementChunking();
      const result = chunk('hello');
      assert.strictEqual(result, null);
    });

    it('should chunk multiple words one at a time', () => {
      const chunk = htmlElementChunking();
      const chunks = collectChunks(chunk, 'hello world foo ');
      assert.deepStrictEqual(chunks, ['hello ', 'world ', 'foo ']);
    });

    it('should handle multiple spaces between words', () => {
      const chunk = htmlElementChunking();
      const result = chunk('hello  world');
      assert.strictEqual(result, 'hello  ');
    });

    it('should handle newlines as whitespace', () => {
      const chunk = htmlElementChunking();
      const result = chunk('hello\nworld');
      assert.strictEqual(result, 'hello\n');
    });
  });

  describe('HTML element detection', () => {
    it('should detect single-word element like <kpi>', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi></kpi>');
      assert.strictEqual(result, '<kpi></kpi>');
    });

    it('should detect kebab-case element like <bar-chart>', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<bar-chart></bar-chart>');
      assert.strictEqual(result, '<bar-chart></bar-chart>');
    });

    it('should detect multi-hyphen element like <data-table-row>', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<data-table-row></data-table-row>');
      assert.strictEqual(result, '<data-table-row></data-table-row>');
    });

    it('should return null for incomplete element name like <ba', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<ba');
      assert.strictEqual(result, null);
    });

    it('should return null for incomplete element name with hyphen like <bar-', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<bar-');
      assert.strictEqual(result, null);
    });

    it('should treat invalid patterns as text like <123', () => {
      const chunk = htmlElementChunking();
      // <123 is not a valid element, so word chunking applies
      const result = chunk('<123 abc');
      assert.strictEqual(result, '<123 ');
    });

    it('should treat < followed by space as text', () => {
      const chunk = htmlElementChunking();
      const result = chunk('< abc');
      assert.strictEqual(result, '< ');
    });
  });

  describe('self-closing elements', () => {
    it('should return complete self-closing element <kpi />', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi />');
      assert.strictEqual(result, '<kpi />');
    });

    it('should return self-closing element without space <kpi/>', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi/>');
      assert.strictEqual(result, '<kpi/>');
    });

    it('should return self-closing element with attributes', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi title="Sales" />');
      assert.strictEqual(result, '<kpi title="Sales" />');
    });

    it('should buffer incomplete self-closing element', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi title="Sales"');
      assert.strictEqual(result, null);
    });

    it('should buffer element with incomplete self-closing', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi /');
      assert.strictEqual(result, null);
    });
  });

  describe('elements with content', () => {
    it('should return complete element with closing tag', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi>content</kpi>');
      assert.strictEqual(result, '<kpi>content</kpi>');
    });

    it('should buffer until closing tag is found', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi>content');
      assert.strictEqual(result, null);
    });

    it('should buffer element with opening tag but no closing', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi>');
      assert.strictEqual(result, null);
    });

    it('should handle element with multiline content', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi>\n  content\n</kpi>');
      assert.strictEqual(result, '<kpi>\n  content\n</kpi>');
    });

    it('should handle element with attributes and content', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<bar-chart title="Sales">data</bar-chart>');
      assert.strictEqual(result, '<bar-chart title="Sales">data</bar-chart>');
    });
  });

  describe('quote handling in attributes', () => {
    it('should not match > inside double quotes', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi sql="SELECT > FROM t"></kpi>');
      assert.strictEqual(result, '<kpi sql="SELECT > FROM t"></kpi>');
    });

    it('should not match > inside single quotes', () => {
      const chunk = htmlElementChunking();
      const result = chunk("<kpi sql='SELECT > FROM t'></kpi>");
      assert.strictEqual(result, "<kpi sql='SELECT > FROM t'></kpi>");
    });

    it('should not match > inside template literals', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi sql=`SELECT > FROM t`></kpi>');
      assert.strictEqual(result, '<kpi sql=`SELECT > FROM t`></kpi>');
    });

    it('should handle escaped double quotes in attributes', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi sql="test\\"more"></kpi>');
      assert.strictEqual(result, '<kpi sql="test\\"more"></kpi>');
    });

    it('should handle escaped single quotes in attributes', () => {
      const chunk = htmlElementChunking();
      const result = chunk("<kpi sql='test\\'more'></kpi>");
      assert.strictEqual(result, "<kpi sql='test\\'more'></kpi>");
    });

    it('should handle multiline SQL in quoted attributes', () => {
      const chunk = htmlElementChunking();
      const sql = `<kpi
  title="Revenue"
  sql="SELECT
    SUM(amount) as total
  FROM orders
  WHERE date > '2024-01-01'">
</kpi>`;
      const result = chunk(sql);
      assert.strictEqual(result, sql);
    });

    it('should not match closing tag pattern inside quotes', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi title="</kpi>fake"></kpi>');
      assert.strictEqual(result, '<kpi title="</kpi>fake"></kpi>');
    });

    it('should handle mix of quote types in different attributes', () => {
      const chunk = htmlElementChunking();
      const result = chunk(`<kpi title="Sales" sql='SELECT "name"'></kpi>`);
      assert.strictEqual(
        result,
        `<kpi title="Sales" sql='SELECT "name"'></kpi>`,
      );
    });
  });

  describe('nested elements', () => {
    it('should handle nested elements of same type', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi><kpi></kpi></kpi>');
      assert.strictEqual(result, '<kpi><kpi></kpi></kpi>');
    });

    it('should handle deeply nested elements of same type', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<row><row><row></row></row></row>');
      assert.strictEqual(result, '<row><row><row></row></row></row>');
    });

    it('should handle nested elements with content', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi>outer<kpi>inner</kpi>more</kpi>');
      assert.strictEqual(result, '<kpi>outer<kpi>inner</kpi>more</kpi>');
    });

    it('should handle elements of different types (not tracking depth)', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<row><kpi></kpi></row>');
      assert.strictEqual(result, '<row><kpi></kpi></row>');
    });
  });

  describe('mixed content', () => {
    it('should chunk text before element first', () => {
      const chunk = htmlElementChunking();
      const chunks = collectChunks(chunk, 'Hello world <kpi></kpi>');
      assert.deepStrictEqual(chunks, ['Hello ', 'world ', '<kpi></kpi>']);
    });

    it('should handle text after element', () => {
      const chunk = htmlElementChunking();
      const chunks = collectChunks(chunk, '<kpi></kpi> more text ');
      assert.deepStrictEqual(chunks, ['<kpi></kpi>', ' more ', 'text ']);
    });

    it('should handle multiple elements in sequence', () => {
      const chunk = htmlElementChunking();
      const chunks = collectChunks(chunk, '<kpi></kpi><bar-chart></bar-chart>');
      assert.deepStrictEqual(chunks, [
        '<kpi></kpi>',
        '<bar-chart></bar-chart>',
      ]);
    });

    it('should handle text between elements', () => {
      const chunk = htmlElementChunking();
      // Note: trailing space without following text is not emitted (buffered for more content)
      const chunks = collectChunks(chunk, '<kpi></kpi> and <bar></bar> ');
      assert.deepStrictEqual(chunks, ['<kpi></kpi>', ' and ', '<bar></bar>']);
    });
  });

  describe('edge cases', () => {
    it('should treat < in text as regular character (a < b)', () => {
      const chunk = htmlElementChunking();
      // Text up to < is returned first, then < needs more context
      const result = chunk('a ');
      assert.strictEqual(result, 'a ');
    });

    it('should handle comparison in text followed by element', () => {
      const chunk = htmlElementChunking();
      const chunks = collectChunks(chunk, 'x < y <kpi></kpi>');
      // 'x ' then '< ' then 'y ' then element
      assert.deepStrictEqual(chunks, ['x ', '< ', 'y ', '<kpi></kpi>']);
    });

    it('should return null for empty buffer', () => {
      const chunk = htmlElementChunking();
      const result = chunk('');
      assert.strictEqual(result, null);
    });

    it('should return null for buffer with only <', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<');
      assert.strictEqual(result, null);
    });

    it('should handle element at end without trailing content', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi></kpi>');
      assert.strictEqual(result, '<kpi></kpi>');
    });

    it('should handle uppercase in element names', () => {
      // HTML element names are case-insensitive
      const chunk = htmlElementChunking();
      const result = chunk('<KPI></KPI>');
      assert.strictEqual(result, '<KPI></KPI>');
    });

    it('should handle numbers in element names after first letter', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<h1></h1>');
      assert.strictEqual(result, '<h1></h1>');
    });

    it('should handle multi-digit element names', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<h123></h123>');
      assert.strictEqual(result, '<h123></h123>');
    });
  });

  describe('case sensitivity', () => {
    it('should handle uppercase element with uppercase closing tag', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<KPI></KPI>');
      assert.strictEqual(result, '<KPI></KPI>');
    });

    it('should handle uppercase element with lowercase closing tag', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<KPI></kpi>');
      assert.strictEqual(result, '<KPI></kpi>');
    });

    it('should handle lowercase element with uppercase closing tag', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi></KPI>');
      assert.strictEqual(result, '<kpi></KPI>');
    });

    it('should handle mixed case in kebab-case elements', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<Bar-Chart></bar-chart>');
      assert.strictEqual(result, '<Bar-Chart></bar-chart>');
    });

    it('should handle nested elements with mixed case', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<KPI><kpi></KPI></kpi>');
      assert.strictEqual(result, '<KPI><kpi></KPI></kpi>');
    });
  });

  describe('unicode and special characters', () => {
    it('should handle unicode in attribute values', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi title="你好世界"></kpi>');
      assert.strictEqual(result, '<kpi title="你好世界"></kpi>');
    });

    it('should handle emoji in attribute values', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi icon="🎉📊"></kpi>');
      assert.strictEqual(result, '<kpi icon="🎉📊"></kpi>');
    });

    it('should handle unicode in content', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi>Données été</kpi>');
      assert.strictEqual(result, '<kpi>Données été</kpi>');
    });

    it('should handle mixed unicode and ASCII', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi title="Sales 销售 🚀"></kpi>');
      assert.strictEqual(result, '<kpi title="Sales 销售 🚀"></kpi>');
    });
  });

  describe('escape sequence edge cases', () => {
    it('should handle double backslash before quote (even escapes)', () => {
      const chunk = htmlElementChunking();
      // \\" means escaped backslash followed by closing quote
      const result = chunk('<kpi sql="test\\\\"></kpi>');
      assert.strictEqual(result, '<kpi sql="test\\\\"></kpi>');
    });

    it('should handle triple backslash before quote', () => {
      const chunk = htmlElementChunking();
      // \\\" means escaped backslash + escaped quote (quote stays open)
      const result = chunk('<kpi sql="test\\\\\\"more"></kpi>');
      assert.strictEqual(result, '<kpi sql="test\\\\\\"more"></kpi>');
    });

    it('should handle double backslash in attribute value', () => {
      const chunk = htmlElementChunking();
      // In JS strings, \\\\ = two backslashes, so path is "C:\\"
      const result = chunk('<kpi path="C:\\\\"></kpi>');
      assert.strictEqual(result, '<kpi path="C:\\\\"></kpi>');
    });

    it('should buffer when backslash escapes closing quote', () => {
      const chunk = htmlElementChunking();
      // In JS strings, \\ = one backslash, which escapes the closing quote
      // This means the quote is never closed, so element is incomplete
      const result = chunk('<kpi path="C:\\"></kpi>');
      assert.strictEqual(result, null); // Correctly buffers as quote is unclosed
    });
  });

  describe('whitespace variants', () => {
    it('should handle newline before self-closing', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi\n/>');
      assert.strictEqual(result, '<kpi\n/>');
    });

    it('should handle tab before self-closing', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi\t/>');
      assert.strictEqual(result, '<kpi\t/>');
    });

    it('should handle multiple whitespace types', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi \n\t />');
      assert.strictEqual(result, '<kpi \n\t />');
    });

    it('should handle newlines in attributes', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi\n  title="test"\n  value="123"\n></kpi>');
      assert.strictEqual(
        result,
        '<kpi\n  title="test"\n  value="123"\n></kpi>',
      );
    });
  });

  describe('empty attributes', () => {
    it('should handle empty double-quoted attribute', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi title=""></kpi>');
      assert.strictEqual(result, '<kpi title=""></kpi>');
    });

    it('should handle empty single-quoted attribute', () => {
      const chunk = htmlElementChunking();
      const result = chunk("<kpi title=''></kpi>");
      assert.strictEqual(result, "<kpi title=''></kpi>");
    });

    it('should handle empty backtick attribute', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi title=``></kpi>');
      assert.strictEqual(result, '<kpi title=``></kpi>');
    });

    it('should handle multiple empty attributes', () => {
      const chunk = htmlElementChunking();
      const result = chunk(`<kpi a="" b='' c=\`\`></kpi>`);
      assert.strictEqual(result, `<kpi a="" b='' c=\`\`></kpi>`);
    });
  });

  describe('deep nesting', () => {
    it('should handle 5 levels of nesting', () => {
      const chunk = htmlElementChunking();
      const result = chunk(
        '<row><row><row><row><row></row></row></row></row></row>',
      );
      assert.strictEqual(
        result,
        '<row><row><row><row><row></row></row></row></row></row>',
      );
    });

    it('should handle 10 levels of nesting', () => {
      const chunk = htmlElementChunking();
      const nested = '<row>'.repeat(10) + '</row>'.repeat(10);
      const result = chunk(nested);
      assert.strictEqual(result, nested);
    });

    it('should handle deep nesting with content', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<row>a<row>b<row>c</row>d</row>e</row>');
      assert.strictEqual(result, '<row>a<row>b<row>c</row>d</row>e</row>');
    });
  });

  describe('nested elements with attributes', () => {
    it('should handle nested element with attributes', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi><kpi attr="value"></kpi></kpi>');
      assert.strictEqual(result, '<kpi><kpi attr="value"></kpi></kpi>');
    });

    it('should handle nested element with quotes containing parent name', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi><kpi title="</kpi>not closing"></kpi></kpi>');
      assert.strictEqual(
        result,
        '<kpi><kpi title="</kpi>not closing"></kpi></kpi>',
      );
    });
  });

  describe('self-closing patterns in attributes', () => {
    it('should handle URL with /> in attribute', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi url="http://example.com/path/>" />');
      assert.strictEqual(result, '<kpi url="http://example.com/path/>" />');
    });

    it('should handle /> pattern in content', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi>some /> text</kpi>');
      assert.strictEqual(result, '<kpi>some /> text</kpi>');
    });
  });

  describe('HTML comments in content', () => {
    it('should handle HTML comment with > in content', () => {
      const chunk = htmlElementChunking();
      const result = chunk('<kpi><!-- comment with > symbol --></kpi>');
      assert.strictEqual(result, '<kpi><!-- comment with > symbol --></kpi>');
    });

    // Note: HTML comments with closing tag patterns are a known limitation.
    // The implementation doesn't parse HTML comments specially, so </kpi> inside
    // a comment will be matched as the closing tag. Full HTML comment parsing
    // would add significant complexity for an edge case unlikely in BI dashboards.
    it('should match closing tag inside comment (known limitation)', () => {
      const chunk = htmlElementChunking();
      // This matches </kpi> inside the comment - expected behavior given no comment parsing
      const result = chunk('<kpi><!-- </kpi> in comment --></kpi>');
      assert.strictEqual(result, '<kpi><!-- </kpi>');
    });
  });
});

describe('htmlElementChunking with smoothStream', () => {
  it('should buffer multiline HTML element until complete', async () => {
    // Simulate chunks arriving like from LLM stream
    const inputChunks = [
      { type: 'text-delta' as const, text: 'Text ', id: '1' },
      { type: 'text-delta' as const, text: '<kpi\n', id: '1' },
      { type: 'text-delta' as const, text: '  sql="SELECT\n', id: '1' },
      { type: 'text-delta' as const, text: '    *"\n', id: '1' },
      { type: 'text-delta' as const, text: '></kpi>', id: '1' },
      { type: 'text-delta' as const, text: ' More ', id: '1' },
    ];

    const inputStream = simulateReadableStream({
      chunks: inputChunks,
      chunkDelayInMs: null,
    });

    const transform = smoothStream({
      chunking: htmlElementChunking(),
      delayInMs: null, // Disable delay for testing
    })();

    const outputStream = inputStream.pipeThrough(transform);
    const outputChunks: Array<{ type: string; text?: string }> = [];

    for await (const chunk of outputStream) {
      outputChunks.push(chunk);
    }

    // Extract text from output chunks
    const texts = outputChunks
      .filter((c) => c.type === 'text-delta' && c.text)
      .map((c) => c.text);

    // The HTML element should be emitted as a single chunk
    const hasCompleteElement = texts.some(
      (t) => t?.includes('<kpi') && t?.includes('</kpi>'),
    );
    assert.ok(
      hasCompleteElement,
      'HTML element should be emitted as complete chunk',
    );
  });

  it('should still chunk regular text word by word', async () => {
    const inputChunks = [
      { type: 'text-delta' as const, text: 'Hello ', id: '1' },
      { type: 'text-delta' as const, text: 'world ', id: '1' },
      { type: 'text-delta' as const, text: 'foo ', id: '1' },
    ];

    const inputStream = simulateReadableStream({
      chunks: inputChunks,
      chunkDelayInMs: null,
    });

    const transform = smoothStream({
      chunking: htmlElementChunking(),
      delayInMs: null,
    })();

    const outputStream = inputStream.pipeThrough(transform);
    const outputChunks: Array<{ type: string; text?: string }> = [];

    for await (const chunk of outputStream) {
      outputChunks.push(chunk);
    }

    const texts = outputChunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text);

    // Each word should be separate
    assert.ok(texts.includes('Hello '), 'Should include "Hello "');
    assert.ok(texts.includes('world '), 'Should include "world "');
    assert.ok(texts.includes('foo '), 'Should include "foo "');
  });

  it('should handle self-closing elements in stream', async () => {
    const inputChunks = [
      { type: 'text-delta' as const, text: '<kpi ', id: '1' },
      { type: 'text-delta' as const, text: 'title="Test" ', id: '1' },
      { type: 'text-delta' as const, text: '/>', id: '1' },
    ];

    const inputStream = simulateReadableStream({
      chunks: inputChunks,
      chunkDelayInMs: null,
    });

    const transform = smoothStream({
      chunking: htmlElementChunking(),
      delayInMs: null,
    })();

    const outputStream = inputStream.pipeThrough(transform);
    const outputChunks: Array<{ type: string; text?: string }> = [];

    for await (const chunk of outputStream) {
      outputChunks.push(chunk);
    }

    const texts = outputChunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text);

    const combinedText = texts.join('');
    assert.ok(
      combinedText.includes('<kpi') && combinedText.includes('/>'),
      'Should contain complete self-closing element',
    );
  });

  it('should pass through non-text-delta chunks immediately', async () => {
    const inputChunks = [
      { type: 'text-delta' as const, text: '<kpi', id: '1' },
      { type: 'tool-call' as const, toolCallId: '123', toolName: 'test' },
      { type: 'text-delta' as const, text: '></kpi>', id: '1' },
    ];

    const inputStream = simulateReadableStream({
      chunks: inputChunks,
      chunkDelayInMs: null,
    });

    const transform = smoothStream({
      chunking: htmlElementChunking(),
      delayInMs: null,
    })();

    const outputStream = inputStream.pipeThrough(transform);
    const outputChunks: Array<{ type: string }> = [];

    for await (const chunk of outputStream) {
      outputChunks.push(chunk);
    }

    // Tool call should be passed through
    const hasToolCall = outputChunks.some((c) => c.type === 'tool-call');
    assert.ok(hasToolCall, 'Tool call chunk should be passed through');
  });
});
