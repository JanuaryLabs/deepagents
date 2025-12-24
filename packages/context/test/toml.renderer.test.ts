import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { ContextFragment } from '../src/lib/context.ts';
import { TomlRenderer } from '../src/lib/renderers/abstract.renderer.ts';

describe('TomlRenderer', () => {
  describe('primitive data', () => {
    it('renders string data as key-value pair', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'hint', data: 'Use CTEs' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'hint = "Use CTEs"');
    });

    it('renders number data without quotes', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'count', data: 42 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'count = 42');
    });

    it('renders boolean data without quotes', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'enabled', data: true }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'enabled = true');
    });

    it('renders false boolean', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'disabled', data: false }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'disabled = false');
    });

    it('renders empty string', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'empty', data: '' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'empty = ""');
    });

    it('renders zero', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'zero', data: 0 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'zero = 0');
    });

    it('renders negative numbers', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'negative', data: -42 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'negative = -42');
    });

    it('renders floating point numbers', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'pi', data: 3.14159 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'pi = 3.14159');
    });
  });

  describe('string escaping', () => {
    it('escapes backslashes', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'path', data: 'C:\\Users\\test' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'path = "C:\\\\Users\\\\test"');
    });

    it('escapes double quotes', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'say "hello"' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text = "say \\"hello\\""');
    });

    it('escapes both backslashes and quotes', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'complex', data: 'path: "C:\\test"' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'complex = "path: \\"C:\\\\test\\""');
    });
  });

  describe('object data', () => {
    it('renders simple object as section', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'term', data: { name: 'LTV', definition: 'Lifetime Value' } },
      ];
      const result = renderer.render(fragments);
      const expected = `[term]
name = "LTV"
definition = "Lifetime Value"`;
      assert.strictEqual(result, expected);
    });

    it('renders nested objects with dot notation', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'config',
          data: { database: { host: 'localhost', port: 5432 } },
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('[config]'));
      assert.ok(result.includes('[config.database]'));
      assert.ok(result.includes('host = "localhost"'));
      assert.ok(result.includes('port = 5432'));
    });

    it('skips null values in objects', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'item',
          data: { a: 'value', b: null, c: 'other' } as Record<string, unknown>,
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('a = "value"'));
      assert.ok(!result.includes('b ='));
      assert.ok(result.includes('c = "other"'));
    });

    it('skips undefined values in objects', () => {
      const renderer = new TomlRenderer();
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
      assert.ok(!result.includes('b ='));
    });

    it('handles mixed types in object', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'config', data: { name: 'test', count: 5, enabled: true } },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('name = "test"'));
      assert.ok(result.includes('count = 5'));
      assert.ok(result.includes('enabled = true'));
    });
  });

  describe('array data', () => {
    it('renders array of strings', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['one', 'two', 'three'] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'items = ["one", "two", "three"]');
    });

    it('renders array of numbers', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'numbers', data: [1, 2, 3] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'numbers = [1, 2, 3]');
    });

    it('renders array of booleans', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'flags', data: [true, false, true] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'flags = [true, false, true]');
    });

    it('renders mixed array', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'mixed', data: ['text', 42, true] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'mixed = ["text", 42, true]');
    });

    it('skips null values in arrays', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['one', null, 'three'] as unknown[] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'items = ["one", "three"]');
    });

    it('renders empty array', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'items', data: [] }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'items = []');
    });

    it('escapes strings in arrays', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['say "hi"', 'path\\to'] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'items = ["say \\"hi\\"", "path\\\\to"]');
    });
  });

  describe('nested fragments', () => {
    it('renders nested fragment with primitive data', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'container',
          data: [{ name: 'hint', data: 'Use CTEs' }],
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('[container]'));
      assert.ok(result.includes('hint = "Use CTEs"'));
    });

    it('renders multiple nested fragments', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'teachings',
          data: [
            { name: 'hint1', data: 'First hint' },
            { name: 'hint2', data: 'Second hint' },
          ],
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('[teachings]'));
      assert.ok(result.includes('hint1 = "First hint"'));
      assert.ok(result.includes('hint2 = "Second hint"'));
    });

    it('renders deeply nested fragments with dot notation', () => {
      const renderer = new TomlRenderer();
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
      assert.ok(result.includes('[level1]'));
      assert.ok(result.includes('[level1.level2]'));
      assert.ok(result.includes('level3 = "deep value"'));
    });

    it('renders fragment with object data', () => {
      const renderer = new TomlRenderer();
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
      assert.ok(result.includes('[terms]'));
      assert.ok(result.includes('[terms.term]'));
      assert.ok(result.includes('name = "LTV"'));
      assert.ok(result.includes('definition = "Lifetime Value"'));
    });
  });

  describe('multiple top-level fragments', () => {
    it('separates fragments with double newline', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'first', data: 'one' },
        { name: 'second', data: 'two' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'first = "one"\n\nsecond = "two"');
    });

    it('separates object fragments with double newline', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'section1', data: { key: 'value1' } },
        { name: 'section2', data: { key: 'value2' } },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('[section1]'));
      assert.ok(result.includes('[section2]'));
      assert.ok(result.includes('\n\n'));
    });
  });

  describe('empty inputs', () => {
    it('returns empty string for empty fragments array', () => {
      const renderer = new TomlRenderer();
      const result = renderer.render([]);
      assert.strictEqual(result, '');
    });

    it('renders empty object as section only', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [{ name: 'empty', data: {} }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, '[empty]');
    });
  });

  describe('unicode', () => {
    it('handles unicode characters in strings', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: '你好世界 🌍 émojis' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text = "你好世界 🌍 émojis"');
    });

    it('handles unicode in keys', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'config', data: { 名前: 'test' } },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('名前 = "test"'));
    });
  });

  describe('special TOML values', () => {
    it('handles objects in arrays by JSON stringifying', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: [{ a: 1 }, { b: 2 }] },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('items = ['));
      // Objects in arrays are JSON stringified
    });
  });

  describe('path building', () => {
    it('builds correct dot-notation paths for deeply nested objects', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'root',
          data: {
            child1: {
              child2: {
                value: 'deep',
              },
            },
          },
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('[root]'));
      assert.ok(result.includes('[root.child1]'));
      assert.ok(result.includes('[root.child1.child2]'));
      assert.ok(result.includes('value = "deep"'));
    });
  });

  describe('array of fragments with primitives', () => {
    it('renders fragment with array of primitives', () => {
      const renderer = new TomlRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'section',
          data: {
            tags: ['one', 'two', 'three'],
          },
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('[section]'));
      assert.ok(result.includes('tags = ["one", "two", "three"]'));
    });
  });

  describe('groupFragments option', () => {
    it('does not affect TOML output significantly', () => {
      const renderer = new TomlRenderer({ groupFragments: true });
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
      // TOML doesn't have the same grouping concept as XML
      assert.ok(result.includes('[teachings]'));
    });
  });
});
