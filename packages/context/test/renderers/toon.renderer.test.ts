import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { ContextFragment } from '../../src/index.ts';
import { ToonRenderer } from '../../src/lib/renderers/abstract.renderer.ts';

describe('ToonRenderer', () => {
  describe('primitive data', () => {
    it('renders string data', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'hint', data: 'Use CTEs' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'hint: Use CTEs');
    });

    it('renders number data', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'count', data: 42 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'count: 42');
    });

    it('renders boolean data', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'enabled', data: true }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'enabled: true');
    });

    it('renders false boolean', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'disabled', data: false }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'disabled: false');
    });

    it('renders zero', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'zero', data: 0 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'zero: 0');
    });

    it('renders negative numbers', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'negative', data: -42 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'negative: -42');
    });

    it('renders floating point numbers', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'pi', data: 3.14159 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'pi: 3.14159');
    });
  });

  describe('string quoting', () => {
    it('quotes empty string', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'empty', data: '' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'empty: ""');
    });

    it('quotes string with leading whitespace', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: '  hello' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "  hello"');
    });

    it('quotes string with trailing whitespace', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: 'hello  ' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "hello  "');
    });

    it('quotes reserved literal true', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: 'true' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "true"');
    });

    it('quotes reserved literal false', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: 'false' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "false"');
    });

    it('quotes reserved literal null', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: 'null' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "null"');
    });

    it('quotes numeric strings', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: '123' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "123"');
    });

    it('quotes string with colon', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'key: value' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "key: value"');
    });

    it('quotes string with comma', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: 'a,b,c' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "a,b,c"');
    });

    it('quotes string starting with hyphen', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'text', data: '-flag' }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "-flag"');
    });

    it('does not quote simple string', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'hello world' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: hello world');
    });

    it('escapes backslashes', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'path', data: 'C:\\Users\\test' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'path: "C:\\\\Users\\\\test"');
    });

    it('escapes double quotes', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'say "hello"' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "say \\"hello\\""');
    });

    it('escapes newlines', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'line1\nline2' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "line1\\nline2"');
    });

    it('escapes tabs', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'col1\tcol2' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'text: "col1\\tcol2"');
    });
  });

  describe('number canonicalization', () => {
    it('canonicalizes -0 to 0', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'num', data: -0 }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'num: 0');
    });

    it('canonicalizes NaN to null', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'num', data: NaN }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'num: null');
    });

    it('canonicalizes Infinity to null', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'num', data: Infinity }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'num: null');
    });

    it('canonicalizes -Infinity to null', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'num', data: -Infinity }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'num: null');
    });
  });

  describe('object data', () => {
    it('renders simple object with indentation', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'context', data: { task: 'hikes', location: 'Boulder' } },
      ];
      const result = renderer.render(fragments);
      const expected = `context:
  task: hikes
  location: Boulder`;
      assert.strictEqual(result, expected);
    });

    it('renders nested objects', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'config',
          data: { database: { host: 'localhost', port: 5432 } },
        },
      ];
      const result = renderer.render(fragments);
      const expected = `config:
  database:
    host: localhost
    port: 5432`;
      assert.strictEqual(result, expected);
    });

    it('skips null values in objects', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'item',
          data: { a: 'value', b: null, c: 'other' },
        },
      ];
      const result = renderer.render(fragments);
      const expected = `item:
  a: value
  c: other`;
      assert.strictEqual(result, expected);
    });

    it('renders empty object', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'empty', data: {} }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'empty:');
    });
  });

  describe('primitive arrays', () => {
    it('renders array of strings inline', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'tags', data: ['admin', 'ops', 'dev'] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'tags[3]: admin,ops,dev');
    });

    it('renders array of numbers inline', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'numbers', data: [1, 2, 3] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'numbers[3]: 1,2,3');
    });

    it('renders array of booleans inline', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'flags', data: [true, false, true] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'flags[3]: true,false,true');
    });

    it('renders empty array', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'items', data: [] }];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'items[0]:');
    });

    it('quotes strings needing quoting in arrays', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['hello', 'a,b', 'world'] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'items[3]: hello,"a,b",world');
    });
  });

  describe('tabular arrays', () => {
    it('renders uniform object array as tabular', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'users',
          data: [
            { id: 1, name: 'Ada', role: 'admin' },
            { id: 2, name: 'Bob', role: 'user' },
          ],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `users[2]{id,name,role}:
  1,Ada,admin
  2,Bob,user`;
      assert.strictEqual(result, expected);
    });

    it('handles null values in tabular rows', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'items',
          data: [
            { a: 1, b: null },
            { a: 2, b: 3 },
          ],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `items[2]{a,b}:
  1,
  2,3`;
      assert.strictEqual(result, expected);
    });

    it('quotes values needing quoting in tabular rows', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'items',
          data: [
            { name: 'hello', desc: 'a,b' },
            { name: 'world', desc: 'c:d' },
          ],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `items[2]{name,desc}:
  hello,"a,b"
  world,"c:d"`;
      assert.strictEqual(result, expected);
    });
  });

  describe('mixed arrays', () => {
    it('renders mixed primitives as list items', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'items', data: ['text', 42, true] },
      ];
      const result = renderer.render(fragments);
      // Mixed types but all primitives still use inline format
      assert.strictEqual(result, 'items[3]: text,42,true');
    });

    it('renders non-uniform objects as list items', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'items',
          data: [{ a: 1 }, { b: 2 }],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `items[2]:
  - a: 1
  - b: 2`;
      assert.strictEqual(result, expected);
    });

    it('renders objects with nested values as list items', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'items',
          data: [{ name: 'test', nested: { x: 1 } }],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `items[1]:
  - name: test
    nested:
      x: 1`;
      assert.strictEqual(result, expected);
    });
  });

  describe('nested fragments', () => {
    it('renders nested fragment with primitive data', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'container',
          data: [{ name: 'hint', data: 'Use CTEs' }],
        },
      ];
      const result = renderer.render(fragments);
      const expected = `container[1]:
  - hint: Use CTEs`;
      assert.strictEqual(result, expected);
    });

    it('renders multiple nested fragments', () => {
      const renderer = new ToonRenderer();
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
      const expected = `teachings[2]:
  - hint: First hint
  - hint: Second hint`;
      assert.strictEqual(result, expected);
    });

    it('renders deeply nested fragments', () => {
      const renderer = new ToonRenderer();
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
      assert.ok(result.includes('level1'));
      assert.ok(result.includes('level2'));
      assert.ok(result.includes('level3'));
      assert.ok(result.includes('deep value'));
    });

    it('renders fragment with object data', () => {
      const renderer = new ToonRenderer();
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
      assert.ok(result.includes('terms'));
      assert.ok(result.includes('term'));
      assert.ok(result.includes('name: LTV'));
      assert.ok(result.includes('definition: Lifetime Value'));
    });
  });

  describe('multiple top-level fragments', () => {
    it('separates fragments with newline', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'first', data: 'one' },
        { name: 'second', data: 'two' },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'first: one\nsecond: two');
    });
  });

  describe('empty inputs', () => {
    it('returns empty string for empty fragments array', () => {
      const renderer = new ToonRenderer();
      const result = renderer.render([]);
      assert.strictEqual(result, '');
    });
  });

  describe('unicode', () => {
    it('handles unicode characters in strings', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'text', data: 'Hello World' },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('Hello World'));
    });

    it('handles emojis', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [{ name: 'emoji', data: 'test' }];
      const result = renderer.render(fragments);
      assert.ok(result.includes('emoji'));
      assert.ok(result.includes('test'));
    });
  });

  describe('object with arrays', () => {
    it('renders object containing primitive array', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'config',
          data: { name: 'test', tags: ['a', 'b', 'c'] },
        },
      ];
      const result = renderer.render(fragments);
      const expected = `config:
  name: test
  tags[3]: a,b,c`;
      assert.strictEqual(result, expected);
    });

    it('renders object containing tabular array', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'data',
          data: {
            title: 'Report',
            items: [
              { id: 1, value: 10 },
              { id: 2, value: 20 },
            ],
          },
        },
      ];
      const result = renderer.render(fragments);
      const expected = `data:
  title: Report
  items[2]{id,value}:
    1,10
    2,20`;
      assert.strictEqual(result, expected);
    });
  });

  describe('real-world examples', () => {
    it('renders hikes example from spec', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'hikes',
          data: [
            {
              id: 1,
              name: 'Blue Lake Trail',
              distanceKm: 7.5,
              elevationGain: 320,
              companion: 'ana',
              wasSunny: true,
            },
            {
              id: 2,
              name: 'Ridge Overlook',
              distanceKm: 9.2,
              elevationGain: 540,
              companion: 'luis',
              wasSunny: false,
            },
          ],
        },
      ];
      const result = renderer.render(fragments);
      assert.ok(result.includes('hikes[2]'));
      assert.ok(
        result.includes(
          '{id,name,distanceKm,elevationGain,companion,wasSunny}',
        ),
      );
      assert.ok(result.includes('1,Blue Lake Trail,7.5,320,ana,true'));
      assert.ok(result.includes('2,Ridge Overlook,9.2,540,luis,false'));
    });

    it('renders context example from spec', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        {
          name: 'context',
          data: {
            task: 'Our favorite hikes together',
            location: 'Boulder',
            season: 'spring_2025',
          },
        },
      ];
      const result = renderer.render(fragments);
      const expected = `context:
  task: Our favorite hikes together
  location: Boulder
  season: spring_2025`;
      assert.strictEqual(result, expected);
    });

    it('renders friends array from spec', () => {
      const renderer = new ToonRenderer();
      const fragments: ContextFragment[] = [
        { name: 'friends', data: ['ana', 'luis', 'sam'] },
      ];
      const result = renderer.render(fragments);
      assert.strictEqual(result, 'friends[3]: ana,luis,sam');
    });
  });
});
