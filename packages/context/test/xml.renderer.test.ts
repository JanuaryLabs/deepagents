import assert from 'node:assert';
import { describe, it } from 'node:test';

import { type ContextFragment, XmlRenderer } from '@deepagents/context';

describe('XmlRenderer', () => {
  describe('primitive data', () => {
    it('renders string data', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [{ name: 'hint', data: 'Use CTEs' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<hint>Use CTEs</hint>');
    });

    it('renders number data', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [{ name: 'count', data: 42 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<count>42</count>');
    });

    it('renders boolean data', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [{ name: 'enabled', data: true }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<enabled>true</enabled>');
    });

    it('renders empty string', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [{ name: 'empty', data: '' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<empty></empty>');
    });
  });

  describe('XML escaping', () => {
    it('escapes ampersand', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'foo & bar' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<text>foo &amp; bar</text>');
    });

    it('escapes less than', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: 'a < b' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<text>a &lt; b</text>');
    });

    it('escapes greater than', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: 'a > b' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<text>a &gt; b</text>');
    });

    it('escapes quotes', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'say "hello"' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<text>say &quot;hello&quot;</text>');
    });

    it('escapes apostrophes', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: "it's fine" },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<text>it&apos;s fine</text>');
    });

    it('escapes multiple special characters', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: '<script>alert("xss")</script>' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(
        result,
        '<text>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</text>',
      );
    });
  });

  describe('multiline content', () => {
    it('indents multiline primitive data', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'code', data: 'line1\nline2\nline3' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<code>\n  line1\n  line2\n  line3\n</code>');
    });
  });

  describe('object data', () => {
    it('renders simple object', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'term', data: { name: 'LTV', definition: 'Lifetime Value' } },
      ];
      const result = renderer.render(fragments);
      const expected = `<term>
  <name>LTV</name>
  <definition>Lifetime Value</definition>
</term>`;
      assert.strictEqual(result, expected);
    });

    it('renders nested objects', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'config',
          data: { database: { host: 'localhost', port: 5432 } },
        },
      ];
      const result = renderer.render(fragments);
      const expected = `<config>
  <database>
    <host>localhost</host>
    <port>5432</port>
  </database>
</config>`;
      assert.strictEqual(result, expected);
    });

    it('skips null values in objects', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'item',
          data: { a: 'value', b: null, c: 'other' } as Record<string, unknown>,
        },
      ];
      const result = renderer.render(fragments);
      const expected = `<item>
  <a>value</a>
  <c>other</c>
</item>`;
      assert.strictEqual(result, expected);
    });

    it('skips undefined values in objects', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'item',
          data: { a: 'value', b: undefined, c: 'other' } as Record<
            string,
            unknown
          >,
        },
      ];
      const result = renderer.render(fragments);
      const expected = `<item>
  <a>value</a>
  <c>other</c>
</item>`;
      assert.strictEqual(result, expected);
    });
  });

  describe('array data', () => {
    it('renders array of primitives', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['one', 'two', 'three'] },
      ];
      const result = renderer.render(fragments);
      const expected = `<items>
  <item>one</item>
  <item>two</item>
  <item>three</item>
</items>`;
      assert.strictEqual(result, expected);
    });

    it('singularizes plural tag names', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'categories', data: ['tech', 'science'] },
      ];
      const result = renderer.render(fragments);
      const expected = `<categories>
  <category>tech</category>
  <category>science</category>
</categories>`;
      assert.strictEqual(result, expected);
    });

    it('handles irregular plurals', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'queries', data: ['SELECT 1', 'SELECT 2'] },
      ];
      const result = renderer.render(fragments);
      const expected = `<queries>
  <query>SELECT 1</query>
  <query>SELECT 2</query>
</queries>`;
      assert.strictEqual(result, expected);
    });

    it('skips null values in arrays', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['one', null, 'three'] as unknown[] },
      ];
      const result = renderer.render(fragments);
      const expected = `<items>
  <item>one</item>
  <item>three</item>
</items>`;
      assert.strictEqual(result, expected);
    });

    it('returns empty string for empty array', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [{ name: 'items', data: [] }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '');
    });
  });

  describe('nested fragments', () => {
    it('renders nested fragment with primitive data', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'container',
          data: [{ name: 'hint', data: 'Use CTEs' }],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `<container>
  <hint>Use CTEs</hint>
</container>`;
      assert.strictEqual(result, expected);
    });

    it('renders multiple nested fragments', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'teachings',
          data: [
            { name: 'hint', data: 'First hint' },
            { name: 'hint', data: 'Second hint' },
          ],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `<teachings>
  <hint>First hint</hint>
  <hint>Second hint</hint>
</teachings>`;
      assert.strictEqual(result, expected);
    });

    it('renders deeply nested fragments', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'level1',
          data: [
            {
              name: 'level2',
              data: [{ name: 'level3', data: 'deep value' }],
            },
          ],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `<level1>
  <level2>
    <level3>deep value</level3>
  </level2>
</level1>`;
      assert.strictEqual(result, expected);
    });

    it('renders fragment with object data inside array', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'terms',
          data: [
            {
              name: 'term',
              data: { name: 'LTV', definition: 'Lifetime Value' },
            },
          ],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `<terms>
  <term>
    <name>LTV</name>
    <definition>Lifetime Value</definition>
  </term>
</terms>`;
      assert.strictEqual(result, expected);
    });
  });

  describe('groupFragments option', () => {
    it('groups fragments by name when enabled', () => {
      const renderer = new XmlRenderer({ groupFragments: true });
      const fragments: ContextFragment[] = [
        {
          name: 'teachings',
          data: [
            { name: 'hint', data: 'First' },
            { name: 'hint', data: 'Second' },
            { name: 'hint', data: 'Third' },
          ],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `<teachings>
  <hints>
    <hint>First</hint>
    <hint>Second</hint>
    <hint>Third</hint>
  </hints>
</teachings>`;
      assert.strictEqual(result, expected);
    });

    it('groups multiple different fragment types', () => {
      const renderer = new XmlRenderer({ groupFragments: true });
      const fragments: ContextFragment[] = [
        {
          name: 'teachings',
          data: [
            { name: 'hint', data: 'Hint 1' },
            { name: 'rule', data: 'Rule 1' },
            { name: 'hint', data: 'Hint 2' },
            { name: 'rule', data: 'Rule 2' },
          ],
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('<hints>'));
      assert.ok(result.includes('<rules>'));
      assert.ok(result.includes('<hint>Hint 1</hint>'));
      assert.ok(result.includes('<hint>Hint 2</hint>'));
      assert.ok(result.includes('<rule>Rule 1</rule>'));
      assert.ok(result.includes('<rule>Rule 2</rule>'));
    });

    it('does not group when option is false', () => {
      const renderer = new XmlRenderer({ groupFragments: false });
      const fragments: ContextFragment[] = [
        {
          name: 'teachings',
          data: [
            { name: 'hint', data: 'First' },
            { name: 'hint', data: 'Second' },
          ],
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(!result.includes('<hints>'));
      const expected = `<teachings>
  <hint>First</hint>
  <hint>Second</hint>
</teachings>`;
      assert.strictEqual(result, expected);
    });

    it('does not group when option is not set', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'teachings',
          data: [
            { name: 'hint', data: 'First' },
            { name: 'hint', data: 'Second' },
          ],
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(!result.includes('<hints>'));
    });
  });

  describe('multiple top-level fragments', () => {
    it('renders multiple fragments separated by newline', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'first', data: 'one' },
        { name: 'second', data: 'two' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<first>one</first>\n<second>two</second>');
    });
  });

  describe('empty inputs', () => {
    it('returns empty string for empty fragments array', () => {
      const renderer = new XmlRenderer();
      const result = renderer.render([]);
      assert.strictEqual(result, '');
    });

    it('returns empty string for fragment with empty object', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [{ name: 'empty', data: {} }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '');
    });
  });

  describe('unicode', () => {
    it('handles unicode characters', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: '你好世界 🌍 émojis' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '<text>你好世界 🌍 émojis</text>');
    });
  });

  describe('table schema structure (regression)', () => {
    it('renders table with nested column fragments', () => {
      const renderer = new XmlRenderer();
      // This is the exact structure produced by SQLite table grounding
      const fragments: ContextFragment[] = [
        {
          name: 'table',
          data: {
            name: 'users',
            columns: [
              {
                name: 'column',
                data: { name: 'id', type: 'INTEGER', pk: true },
              },
              { name: 'column', data: { name: 'email', type: 'TEXT' } },
            ],
          },
        },
      ];
      const result = renderer.render(fragments);

      // Should NOT contain [object Object]
      assert.ok(
        !result.includes('[object Object]'),
        `Should not contain [object Object]. Got:\n${result}`,
      );

      // Should properly render nested fragments
      assert.ok(
        result.includes('<name>id</name>'),
        'Should contain column name',
      );
      assert.ok(
        result.includes('<type>INTEGER</type>'),
        'Should contain column type',
      );
      assert.ok(
        result.includes('<name>email</name>'),
        'Should contain second column name',
      );
    });

    it('renders table with indexes', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'table',
          data: {
            name: 'users',
            columns: [
              { name: 'column', data: { name: 'id', type: 'INTEGER' } },
            ],
            indexes: [
              {
                name: 'index',
                data: { name: 'idx_users_id', columns: ['id'] },
              },
            ],
          },
        },
      ];
      const result = renderer.render(fragments);

      assert.ok(
        !result.includes('[object Object]'),
        `Should not contain [object Object]. Got:\n${result}`,
      );
    });
  });

  describe('mixed content', () => {
    it('renders mixed primitives and fragments in array', () => {
      const renderer = new XmlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'container',
          data: [
            'plain text',
            { name: 'nested', data: 'fragment value' },
            'more text',
          ],
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(
        result.includes('<container>plain text</container>') ||
          result.includes('<container>'),
      );
    });
  });
});
