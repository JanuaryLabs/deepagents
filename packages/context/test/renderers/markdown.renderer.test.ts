import assert from 'node:assert';
import { describe, it } from 'node:test';

import { type ContextFragment, MarkdownRenderer } from '@deepagents/context';

describe('MarkdownRenderer', () => {
  describe('primitive data', () => {
    it('renders string data with title', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'hint', data: 'Use CTEs for complex queries' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '## Hint\nUse CTEs for complex queries');
    });

    it('renders number data', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [{ name: 'count', data: 42 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '## Count\n42');
    });

    it('renders boolean data', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [{ name: 'enabled', data: true }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '## Enabled\ntrue');
    });

    it('renders empty string', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [{ name: 'empty', data: '' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '## Empty\n');
    });
  });

  describe('title case conversion', () => {
    it('converts camelCase to Title Case', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'styleGuide', data: 'content' },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.startsWith('## Style Guide'));
    });

    it('converts single word to Title Case', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [{ name: 'hint', data: 'content' }];
      const result = renderer.render(fragments);
      assert.ok(result.startsWith('## Hint'));
    });

    it('handles multiple capital letters', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'userAPIKey', data: 'content' },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('##'));
    });
  });

  describe('object data', () => {
    it('renders simple object as bullet list', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'term', data: { name: 'LTV', definition: 'Lifetime Value' } },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('## Term'));
      assert.ok(result.includes('- **name**: LTV'));
      assert.ok(result.includes('- **definition**: Lifetime Value'));
    });

    it('renders nested objects with indentation', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'config',
          data: { database: { host: 'localhost', port: 5432 } },
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('- **database**:'));
      assert.ok(result.includes('  - **host**: localhost'));
      assert.ok(result.includes('  - **port**: 5432'));
    });

    it('skips null values in objects', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'item',
          data: { a: 'value', b: null, c: 'other' },
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('- **a**: value'));
      assert.ok(!result.includes('- **b**'));
      assert.ok(result.includes('- **c**: other'));
    });

    it('skips undefined values in objects', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'item',
          data: { a: 'value', b: undefined, c: 'other' },
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(!result.includes('- **b**'));
    });
  });

  describe('array data', () => {
    it('renders array of primitives as bullet list', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['one', 'two', 'three'] },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('## Items'));
      // With nested fragments, primitives in arrays become list items
      const lines = result.split('\n');
      assert.ok(lines.length >= 2);
    });

    it('skips null values in arrays', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['one', null, 'three'] },
      ];
      const result = renderer.render(fragments);
      assert.ok(!result.includes('null'));
    });

    it('handles empty array', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [{ name: 'items', data: [] }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '## Items\n');
    });
  });

  describe('nested fragments', () => {
    it('renders nested fragment with primitive data', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'container',
          data: [{ name: 'hint', data: 'Use CTEs' }],
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('## Container'));
      assert.ok(result.includes('- **hint**: Use CTEs'));
    });

    it('renders multiple nested fragments', () => {
      const renderer = new MarkdownRenderer();
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
      assert.ok(result.includes('- **hint**: First hint'));
      assert.ok(result.includes('- **hint**: Second hint'));
    });

    it('renders deeply nested fragments', () => {
      const renderer = new MarkdownRenderer();
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
      assert.ok(result.includes('## Level1'));
      assert.ok(result.includes('**level2**'));
      assert.ok(result.includes('**level3**: deep value'));
    });

    it('renders fragment with object data', () => {
      const renderer = new MarkdownRenderer();
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
      assert.ok(result.includes('**term**'));
      assert.ok(result.includes('**name**: LTV'));
      assert.ok(result.includes('**definition**: Lifetime Value'));
    });
  });

  describe('groupFragments option', () => {
    it('groups fragments by name when enabled', () => {
      const renderer = new MarkdownRenderer({ groupFragments: true });
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
      assert.ok(result.includes('**Hints**:'));
      assert.ok(result.includes('**hint**: First'));
      assert.ok(result.includes('**hint**: Second'));
      assert.ok(result.includes('**hint**: Third'));
    });

    it('groups multiple different fragment types', () => {
      const renderer = new MarkdownRenderer({ groupFragments: true });
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
      assert.ok(result.includes('**Hints**:'));
      assert.ok(result.includes('**Rules**:'));
    });

    it('does not group when option is false', () => {
      const renderer = new MarkdownRenderer({ groupFragments: false });
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
      assert.ok(!result.includes('**Hints**:'));
    });

    it('does not group when option is not set', () => {
      const renderer = new MarkdownRenderer();
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
      assert.ok(!result.includes('**Hints**:'));
    });
  });

  describe('multiple top-level fragments', () => {
    it('separates fragments with double newline', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'first', data: 'one' },
        { name: 'second', data: 'two' },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('## First\none\n\n## Second\ntwo'));
    });
  });

  describe('empty inputs', () => {
    it('returns empty string for empty fragments array', () => {
      const renderer = new MarkdownRenderer();
      const result = renderer.render([]);
      assert.strictEqual(result, '');
    });
  });

  describe('special characters', () => {
    it('preserves markdown special characters in content', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'code', data: 'Use `backticks` for inline code' },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('`backticks`'));
    });

    it('preserves asterisks in content', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'SELECT * FROM users' },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('SELECT * FROM users'));
    });
  });

  describe('unicode', () => {
    it('handles unicode characters', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: '你好世界 🌍 émojis' },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('你好世界 🌍 émojis'));
    });
  });

  describe('indentation levels', () => {
    it('increases indentation for nested objects', () => {
      const renderer = new MarkdownRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'config',
          data: {
            level1: {
              level2: {
                level3: 'deep',
              },
            },
          },
        },
      ];
      const result = renderer.render(fragments);
      const lines = result.split('\n');
      // Check that indentation increases
      const level1Line = lines.find((l) => l.includes('**level1**'));
      const level2Line = lines.find((l) => l.includes('**level2**'));
      const level3Line = lines.find((l) => l.includes('**level3**'));
      assert.ok(level1Line);
      assert.ok(level2Line);
      assert.ok(level3Line);
    });
  });
});
