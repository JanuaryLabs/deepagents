import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ContextFragment,
  MarkdownRenderer,
  TomlRenderer,
  ToonRenderer,
  XmlRenderer,
} from '@deepagents/context';

function codecBackedFragment(): ContextFragment {
  return {
    name: 'hint',
    data: 'STALE_DATA',
    codec: {
      encode() {
        return { type: 'hint', text: 'fresh text' };
      },
      decode() {
        return 'FRESH_TEXT';
      },
    },
  };
}

describe('renderer codec-backed fragment data', () => {
  it('XmlRenderer uses codec-decoded fragment data', () => {
    const renderer = new XmlRenderer();
    const result = renderer.render([codecBackedFragment()]);

    assert.ok(result.includes('FRESH_TEXT'));
    assert.ok(!result.includes('STALE_DATA'));
  });

  it('MarkdownRenderer uses codec-decoded fragment data', () => {
    const renderer = new MarkdownRenderer();
    const result = renderer.render([codecBackedFragment()]);

    assert.ok(result.includes('FRESH_TEXT'));
    assert.ok(!result.includes('STALE_DATA'));
  });

  it('TomlRenderer uses codec-decoded fragment data', () => {
    const renderer = new TomlRenderer();
    const result = renderer.render([codecBackedFragment()]);

    assert.ok(result.includes('FRESH_TEXT'));
    assert.ok(!result.includes('STALE_DATA'));
  });

  it('ToonRenderer uses codec-decoded fragment data', () => {
    const renderer = new ToonRenderer();
    const result = renderer.render([codecBackedFragment()]);

    assert.ok(result.includes('FRESH_TEXT'));
    assert.ok(!result.includes('STALE_DATA'));
  });
});
