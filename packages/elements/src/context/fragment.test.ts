import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { XmlRenderer } from '@deepagents/context';
import { elementsFragment } from '@deepagents/elements/context';

describe('elementsFragment', () => {
  it('shows the model the tag syntax as real tags, not HTML entities', () => {
    const prompt = new XmlRenderer().render([
      elementsFragment([{ name: 'followup', allowedAttributes: ['question'] }]),
    ]);

    assert.ok(prompt.includes('`<element-name attribute="value" />`'));
    assert.doesNotMatch(prompt, /&lt;|&gt;|&quot;|&apos;/);
  });

  it('lists each declared element with its description and allowed attributes', () => {
    const prompt = new XmlRenderer().render([
      elementsFragment([
        {
          name: 'followup',
          allowedAttributes: ['question'],
          description: 'Suggest a follow-up question',
        },
        { name: 'kpi', allowedAttributes: ['title', 'value'] },
      ]),
    ]);

    assert.ok(
      prompt.includes(
        [
          '  <element>',
          '    <name>followup</name>',
          '    <description>Suggest a follow-up question</description>',
          '    <allowed-attributes>question</allowed-attributes>',
          '  </element>',
          '  <element>',
          '    <name>kpi</name>',
          '    <allowed-attributes>title, value</allowed-attributes>',
          '  </element>',
          '</elements>',
        ].join('\n'),
      ),
    );
  });

  it('leaves the escaping of other fragments to the renderer', () => {
    const prompt = new XmlRenderer().render([
      elementsFragment([{ name: 'followup', allowedAttributes: ['question'] }]),
      { name: 'hint', data: 'Write <b> & "quote" as text' },
    ]);

    assert.ok(
      prompt.includes(
        '<hint>Write &lt;b&gt; &amp; &quot;quote&quot; as text</hint>',
      ),
    );
  });

  it('exposes the descriptor snapshot on metadata without rendering it', () => {
    const descriptors = [{ name: 'followup', allowedAttributes: ['question'] }];

    const fragment = elementsFragment(descriptors);

    assert.deepEqual(fragment.metadata, {
      elements: [
        {
          name: 'followup',
          allowedAttributes: ['question'],
          description: undefined,
        },
      ],
    });
  });

  it('renders nothing for an empty catalog', () => {
    const prompt = new XmlRenderer().render([elementsFragment([])]);

    assert.equal(prompt, '');
  });

  it('is deterministic for identical input', () => {
    const descriptors = [
      { name: 'kpi', allowedAttributes: ['title'], description: 'A metric' },
    ];

    assert.deepEqual(
      elementsFragment(descriptors),
      elementsFragment(descriptors),
    );
  });
});
