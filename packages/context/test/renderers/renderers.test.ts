import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ContextFragment,
  MarkdownRenderer,
  TomlRenderer,
  XmlRenderer,
} from '@deepagents/context';

describe('XmlRenderer', () => {
  const renderer = new XmlRenderer();

  it('should render simple object', () => {
    const fragment: ContextFragment = {
      name: 'styleGuide',
      data: { prefer: 'CTEs', never: 'subqueries' },
    };
    const result = renderer.render([fragment]);
    const expected = `<styleGuide>
  <prefer>CTEs</prefer>
  <never>subqueries</never>
</styleGuide>`;
    assert.strictEqual(result, expected);
  });

  it('should render object with array', () => {
    const fragment: ContextFragment = {
      name: 'workflow',
      data: { task: 'Analysis', steps: ['step1', 'step2'] },
    };
    const result = renderer.render([fragment]);
    const expected = `<workflow>
  <task>Analysis</task>
  <steps>
    <step>step1</step>
    <step>step2</step>
  </steps>
</workflow>`;
    assert.strictEqual(result, expected);
  });

  it('should skip null and undefined values', () => {
    const fragment: ContextFragment = {
      name: 'config',
      data: { enabled: true, disabled: null, missing: undefined },
    };
    const result = renderer.render([fragment]);
    const expected = `<config>
  <enabled>true</enabled>
</config>`;
    assert.strictEqual(result, expected);
  });

  it('should escape XML special characters', () => {
    const fragment: ContextFragment = {
      name: 'test',
      data: { content: '<tag> & "quote"' },
    };
    const result = renderer.render([fragment]);
    assert.ok(result.includes('&lt;tag&gt; &amp; &quot;quote&quot;'));
  });
});

describe('MarkdownRenderer', () => {
  const renderer = new MarkdownRenderer();

  it('should render simple object', () => {
    const fragment: ContextFragment = {
      name: 'styleGuide',
      data: { prefer: 'CTEs', never: 'subqueries' },
    };
    const result = renderer.render([fragment]);
    const expected = `## Style Guide
- **prefer**: CTEs
- **never**: subqueries`;
    assert.strictEqual(result, expected);
  });

  it('should render object with array', () => {
    const fragment: ContextFragment = {
      name: 'workflow',
      data: { task: 'Analysis', steps: ['step1', 'step2'] },
    };
    const result = renderer.render([fragment]);
    const expected = `## Workflow
- **task**: Analysis
- **steps**:
  - step1
  - step2`;
    assert.strictEqual(result, expected);
  });

  it('should skip null and undefined values', () => {
    const fragment: ContextFragment = {
      name: 'config',
      data: { enabled: true, disabled: null, missing: undefined },
    };
    const result = renderer.render([fragment]);
    const expected = `## Config
- **enabled**: true`;
    assert.strictEqual(result, expected);
  });

  it('should convert camelCase to Title Case', () => {
    const fragment: ContextFragment = {
      name: 'myStyleGuide',
      data: { test: 'value' },
    };
    const result = renderer.render([fragment]);
    assert.ok(result.includes('## My Style Guide'));
  });
});

describe('TomlRenderer', () => {
  const renderer = new TomlRenderer();

  it('should render simple object', () => {
    const fragment: ContextFragment = {
      name: 'styleGuide',
      data: { prefer: 'CTEs', never: 'subqueries' },
    };
    const result = renderer.render([fragment]);
    const expected = `[styleGuide]
prefer = "CTEs"
never = "subqueries"`;
    assert.strictEqual(result, expected);
  });

  it('should render object with array', () => {
    const fragment: ContextFragment = {
      name: 'workflow',
      data: { task: 'Analysis', steps: ['step1', 'step2'] },
    };
    const result = renderer.render([fragment]);
    const expected = `[workflow]
task = "Analysis"
steps = ["step1", "step2"]`;
    assert.strictEqual(result, expected);
  });

  it('should skip null and undefined values', () => {
    const fragment: ContextFragment = {
      name: 'config',
      data: { enabled: true, disabled: null, missing: undefined },
    };
    const result = renderer.render([fragment]);
    const expected = `[config]
enabled = true`;
    assert.strictEqual(result, expected);
  });

  it('should handle nested objects', () => {
    const fragment: ContextFragment = {
      name: 'database',
      data: {
        host: 'localhost',
        settings: { timeout: 30, retry: true },
      },
    };
    const result = renderer.render([fragment]);
    const expected = `[database]
host = "localhost"

[database.settings]
timeout = 30
retry = true`;
    assert.strictEqual(result, expected);
  });

  it('should escape quotes in strings', () => {
    const fragment: ContextFragment = {
      name: 'test',
      data: { message: 'Hello "world"' },
    };
    const result = renderer.render([fragment]);
    assert.ok(result.includes('message = "Hello \\"world\\""'));
  });
});
