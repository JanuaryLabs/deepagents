import assert from 'node:assert';
import { describe, it } from 'vitest';

import { normalizeStreamdownChildren } from './normalize-streamdown-children.ts';

describe('normalizeStreamdownChildren', () => {
  describe('non-string input', () => {
    it('returns undefined as-is', () => {
      assert.strictEqual(normalizeStreamdownChildren(undefined), undefined);
    });

    it('returns null as-is', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(null as unknown as never),
        null,
      );
    });
  });

  describe('self-closing tag spacing', () => {
    it('adds blank line between self-closing and opening tag', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi title="A" /><line-chart title="B"></line-chart>',
        ),
        '<kpi title="A"/>\n\n<div><line-chart title="B"></line-chart></div>',
      );
    });

    it('handles multiple consecutive self-closing tags', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<kpi /><bar-chart /><line-chart />'),
        '<kpi />\n\n<bar-chart />\n\n<line-chart />',
      );
    });
  });

  describe('custom element wrapping', () => {
    it('wraps tag at start of string in div', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<line-chart title="Test"></line-chart>'),
        '\n\n<div><line-chart title="Test"></line-chart></div>',
      );
    });

    it('wraps tag after single newline in div with blank line', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          'Some text\n<line-chart title="Test"></line-chart>',
        ),
        'Some text\n\n<div><line-chart title="Test"></line-chart></div>',
      );
    });

    it('wraps tag after double newline in div', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          'Some text\n\n<line-chart title="Test"></line-chart>',
        ),
        'Some text\n\n<div><line-chart title="Test"></line-chart></div>',
      );
    });

    it('handles multiple custom elements', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<line-chart title="A"></line-chart>\n<bar-chart title="B"></bar-chart>',
        ),
        '\n\n<div><line-chart title="A"></line-chart></div>\n\n<div><bar-chart title="B"></bar-chart></div>',
      );
    });

    it('handles multiline attributes in custom elements', () => {
      const input = `<line-chart
  title="Monthly Active Rate"
  sql="SELECT 1"
  x-key="month"
></line-chart>`;
      assert.strictEqual(
        normalizeStreamdownChildren(input),
        '\n\n<div><line-chart title="Monthly Active Rate" sql="SELECT 1" x-key="month"></line-chart></div>',
      );
    });
  });

  describe('text before custom elements', () => {
    it('inserts blank line when text precedes tag on previous line', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          'Monthly Activity & Retention\n<line-chart title="Test"></line-chart>',
        ),
        'Monthly Activity & Retention\n\n<div><line-chart title="Test"></line-chart></div>',
      );
    });

    it('preserves text content before the tag', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          'Header text\n<bar-chart title="Chart"></bar-chart>',
        ),
        'Header text\n\n<div><bar-chart title="Chart"></bar-chart></div>',
      );
    });
  });

  describe('multiline tag collapsing', () => {
    it('collapses multiline kpi with >= in SQL attribute', () => {
      const input = `<kpi
  title="Payments in the last 30 days"
  sql="SELECT COUNT(*)::int AS value FROM public.payment WHERE payment_date >= NOW() - INTERVAL '30 days'"
  variant="sparkline"
  format="compact"
></kpi>`;
      assert.strictEqual(
        normalizeStreamdownChildren(input, ['kpi']),
        `\n\n<div><kpi title="Payments in the last 30 days" sql="SELECT COUNT(&#42;)::int AS value FROM public.payment WHERE payment_date >= NOW() - INTERVAL '30 days'" variant="sparkline" format="compact"></kpi></div>`,
      );
    });

    it('collapses multiline self-closing tag', () => {
      const input = `<kpi
  title="Test"
  sql="SELECT 1"
/>`;
      assert.strictEqual(
        normalizeStreamdownChildren(input),
        '<kpi title="Test" sql="SELECT 1"/>',
      );
    });
  });

  describe('non-hyphenated tag names via tagNames param', () => {
    it('wraps single-line kpi when tagNames includes kpi', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<kpi title="Revenue"></kpi>', ['kpi']),
        '\n\n<div><kpi title="Revenue"></kpi></div>',
      );
    });

    it('wraps row when tagNames includes row', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<row>content</row>', ['row']),
        '\n\n<div><row>content</row></div>',
      );
    });

    it('does not wrap unregistered tags', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<kpi title="A"></kpi>', ['line-chart']),
        '<kpi title="A"></kpi>',
      );
    });

    it('falls back to hyphenated pattern when no tagNames', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<line-chart title="A"></line-chart>'),
        '\n\n<div><line-chart title="A"></line-chart></div>',
      );
    });
  });

  describe('asterisk escaping in attribute values', () => {
    it('escapes COUNT(*) in sql attribute', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi sql="SELECT COUNT(*) AS value FROM orders"></kpi>',
          ['kpi'],
        ),
        '\n\n<div><kpi sql="SELECT COUNT(&#42;) AS value FROM orders"></kpi></div>',
      );
    });

    it('escapes SELECT * in sql attribute', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<data-table sql="SELECT * FROM users"></data-table>',
        ),
        '\n\n<div><data-table sql="SELECT &#42; FROM users"></data-table></div>',
      );
    });

    it('escapes multiple asterisks in one attribute', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi sql="SELECT COUNT(*) AS a, SUM(*) AS b FROM t"></kpi>',
          ['kpi'],
        ),
        '\n\n<div><kpi sql="SELECT COUNT(&#42;) AS a, SUM(&#42;) AS b FROM t"></kpi></div>',
      );
    });

    it('escapes markdown bold in advice attribute', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<metric-card title="Health" advice="**Deliverability is solid** at 98%."></metric-card>',
          ['metric-card'],
        ),
        '\n\n<div><metric-card title="Health" advice="&#42;&#42;Deliverability is solid&#42;&#42; at 98%."></metric-card></div>',
      );
    });

    it('does not escape asterisks in plain text outside attributes', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          'Use COUNT(*) for totals\n<line-chart sql="SELECT 1"></line-chart>',
        ),
        'Use COUNT(*) for totals\n\n<div><line-chart sql="SELECT 1"></line-chart></div>',
      );
    });

    it('leaves attribute unchanged when no asterisks present', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi title="Revenue" sql="SELECT SUM(amount) FROM orders"></kpi>',
          ['kpi'],
        ),
        '\n\n<div><kpi title="Revenue" sql="SELECT SUM(amount) FROM orders"></kpi></div>',
      );
    });

    it('escapes COUNT(*)::int PostgreSQL cast', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi sql="SELECT COUNT(*)::int AS value FROM public.payment"></kpi>',
          ['kpi'],
        ),
        '\n\n<div><kpi sql="SELECT COUNT(&#42;)::int AS value FROM public.payment"></kpi></div>',
      );
    });
  });

  describe('multiple SQL attributes on same element', () => {
    it('escapes asterisks in both sql and trend-sql attributes', () => {
      const input = `<kpi
  title="New Orders"
  sql="SELECT COUNT(*) AS value FROM orders"
  trend-sql="SELECT DATE(created_at) AS date, COUNT(*) AS value FROM orders GROUP BY date"
></kpi>`;
      assert.strictEqual(
        normalizeStreamdownChildren(input, ['kpi']),
        '\n\n<div><kpi title="New Orders" sql="SELECT COUNT(&#42;) AS value FROM orders" trend-sql="SELECT DATE(created_at) AS date, COUNT(&#42;) AS value FROM orders GROUP BY date"></kpi></div>',
      );
    });

    it('collapses multiline and escapes both sql attributes', () => {
      const input = `<param-select
  name="region"
  label="Region"
  options-sql="SELECT DISTINCT region FROM stores"
  sql="SELECT COUNT(*) FROM stores WHERE region = :region"
></param-select>`;
      assert.strictEqual(
        normalizeStreamdownChildren(input, ['param-select']),
        '\n\n<div><param-select name="region" label="Region" options-sql="SELECT DISTINCT region FROM stores" sql="SELECT COUNT(&#42;) FROM stores WHERE region = :region"></param-select></div>',
      );
    });
  });

  describe('escaped quote normalization in SQL-like attributes', () => {
    it('normalizes escaped identifier quotes in multiline sql attribute without truncation', () => {
      const input = `<line-chart
  title="Rating Activity Trend"
  sql="WITH year_bounds AS (SELECT MAX(\\"details.yearpublished\\") AS latest_year FROM BoardGames WHERE \\"details.yearpublished\\" IS NOT NULL) SELECT SUM(COALESCE(\\"stats.usersrated\\",0)) AS users_rated_total FROM BoardGames WHERE \\"details.yearpublished\\" = (SELECT latest_year FROM year_bounds);"
  x-key="year"
></line-chart>`;
      assert.strictEqual(
        normalizeStreamdownChildren(input, ['line-chart']),
        '\n\n<div><line-chart title="Rating Activity Trend" sql="WITH year_bounds AS (SELECT MAX(&quot;details.yearpublished&quot;) AS latest_year FROM BoardGames WHERE &quot;details.yearpublished&quot; IS NOT NULL) SELECT SUM(COALESCE(&quot;stats.usersrated&quot;,0)) AS users_rated_total FROM BoardGames WHERE &quot;details.yearpublished&quot; = (SELECT latest_year FROM year_bounds);" x-key="year"></line-chart></div>',
      );
    });

    it('normalizes escaped quotes across sql, trend-sql, and options-sql attributes', () => {
      const input = `<kpi
  title="Orders"
  sql="SELECT \\"details.name\\" AS name FROM BoardGames"
  trend-sql="SELECT \\"details.yearpublished\\" AS year FROM BoardGames"
  options-sql="SELECT \\"details.name\\" AS value, \\"details.name\\" AS label FROM BoardGames"
></kpi>`;
      assert.strictEqual(
        normalizeStreamdownChildren(input, ['kpi']),
        '\n\n<div><kpi title="Orders" sql="SELECT &quot;details.name&quot; AS name FROM BoardGames" trend-sql="SELECT &quot;details.yearpublished&quot; AS year FROM BoardGames" options-sql="SELECT &quot;details.name&quot; AS value, &quot;details.name&quot; AS label FROM BoardGames"></kpi></div>',
      );
    });
  });

  describe('BigQuery and special SQL patterns', () => {
    it('preserves backtick-quoted BigQuery table identifiers', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi sql="SELECT COUNT(*) FROM `bigquery-public-data.chicago.trips`"></kpi>',
          ['kpi'],
        ),
        '\n\n<div><kpi sql="SELECT COUNT(&#42;) FROM `bigquery-public-data.chicago.trips`"></kpi></div>',
      );
    });

    it('preserves single quotes inside double-quoted attributes', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          `<kpi sql="SELECT COUNT(*) FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'"></kpi>`,
          ['kpi'],
        ),
        `\n\n<div><kpi sql="SELECT COUNT(&#42;) FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'"></kpi></div>`,
      );
    });

    it('preserves comparison operators in attribute values', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi sql="SELECT COUNT(*) FROM orders WHERE amount >= 100 AND qty < 5"></kpi>',
          ['kpi'],
        ),
        '\n\n<div><kpi sql="SELECT COUNT(&#42;) FROM orders WHERE amount >= 100 AND qty < 5"></kpi></div>',
      );
    });
  });

  describe('single-word tags without tagNames', () => {
    it('does not wrap kpi when tagNames is undefined', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<kpi title="Revenue"></kpi>'),
        '<kpi title="Revenue"></kpi>',
      );
    });

    it('does not wrap row when tagNames is undefined', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<row>content</row>'),
        '<row>content</row>',
      );
    });

    it('wraps hyphenated line-chart without tagNames', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<line-chart title="A"></line-chart>'),
        '\n\n<div><line-chart title="A"></line-chart></div>',
      );
    });

    it('does not wrap kpi when tagNames is empty array', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<kpi title="Revenue"></kpi>', []),
        '<kpi title="Revenue"></kpi>',
      );
    });
  });

  describe('nested elements', () => {
    it('wraps outer grid and inner children', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<grid cols="2"><kpi title="A"></kpi><kpi title="B"></kpi></grid>',
          ['grid', 'kpi'],
        ),
        '\n\n<div><grid cols="2"><div><kpi title="A"></kpi></div><div><kpi title="B"></kpi></div></grid></div>',
      );
    });

    it('wraps row and nested line-chart', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<row><line-chart title="Sales"></line-chart></row>',
          ['row', 'line-chart'],
        ),
        '\n\n<div><row><div><line-chart title="Sales"></line-chart></div></row></div>',
      );
    });

    it('wraps 3-level deep nesting correctly', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<grid cols="2"><row><kpi title="A"></kpi></row></grid>',
          ['grid', 'row', 'kpi'],
        ),
        '\n\n<div><grid cols="2"><div><row><div><kpi title="A"></kpi></div></row></div></grid></div>',
      );
    });

    it('handles same-name nesting with depth tracking', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<row><row>inner</row></row>', ['row']),
        '\n\n<div><row><div><row>inner</row></div></row></div>',
      );
    });

    it('handles multiple intermediate closing tags at depth > 1', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<row><row>A</row><row>B</row></row>', [
          'row',
        ]),
        '\n\n<div><row><div><row>A</row></div><div><row>B</row></div></row></div>',
      );
    });
  });

  describe('inner element wrapping', () => {
    it('wraps self-closing children inside parent custom element', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<data-insight title="Stats"><metric-row label="A" value="1" /></data-insight>',
          ['data-insight', 'metric-row'],
        ),
        '\n\n<div><data-insight title="Stats"><div><metric-row label="A" value="1"/></div>\n\n</data-insight></div>',
      );
    });

    it('wraps multiple self-closing children inside parent', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<data-insight title="Stats"><metric-row label="A" value="1" /><metric-row label="B" value="2" /></data-insight>',
          ['data-insight', 'metric-row'],
        ),
        '\n\n<div><data-insight title="Stats"><div><metric-row label="A" value="1"/></div>\n\n<div><metric-row label="B" value="2"/></div>\n\n</data-insight></div>',
      );
    });

    it('wraps inner elements but preserves markdown text', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<data-insight title="Stats">\n<metric-row label="A" value="1" />\n\n- **Bold**: text\n</data-insight>',
          ['data-insight', 'metric-row'],
        ),
        '\n\n<div><data-insight title="Stats">\n<div><metric-row label="A" value="1"/></div>\n\n- **Bold**: text\n</data-insight></div>',
      );
    });
  });

  describe('self-closing tags', () => {
    it('self-closing with explicit tagNames is not wrapped', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<kpi title="A" />', ['kpi']),
        '<kpi title="A"/>',
      );
    });

    it('self-closing between regular tags passes through unwrapped', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi title="A"></kpi>\n<kpi title="B" />\n<kpi title="C"></kpi>',
          ['kpi'],
        ),
        '\n\n<div><kpi title="A"></kpi></div>\n<kpi title="B"/>\n\n<div><kpi title="C"></kpi></div>',
      );
    });

    it('self-closing not wrapped, following regular tag wrapped separately', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi title="Total" sql="SELECT COUNT(*)" /><line-chart title="Trend" sql="SELECT 1"></line-chart>',
          ['kpi', 'line-chart'],
        ),
        '<kpi title="Total" sql="SELECT COUNT(&#42;)"/>\n\n<div><line-chart title="Trend" sql="SELECT 1"></line-chart></div>',
      );
    });
  });

  describe('whitespace edge cases', () => {
    it('returns whitespace-only string unchanged', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('   \n  \n   '),
        '   \n  \n   ',
      );
    });

    it('collapses tab indentation in multiline attributes', () => {
      const input = `<kpi
\ttitle="Test"
\tsql="SELECT 1"
></kpi>`;
      assert.strictEqual(
        normalizeStreamdownChildren(input, ['kpi']),
        '\n\n<div><kpi title="Test" sql="SELECT 1"></kpi></div>',
      );
    });

    it('preserves multiple blank lines between text and element', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          'Text\n\n\n<line-chart title="A"></line-chart>',
        ),
        'Text\n\n\n<div><line-chart title="A"></line-chart></div>',
      );
    });
  });

  describe('real-world LLM output', () => {
    it('preserves markdown heading before custom element', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '## Revenue\n<line-chart title="Monthly Revenue" sql="SELECT 1"></line-chart>',
        ),
        '## Revenue\n\n<div><line-chart title="Monthly Revenue" sql="SELECT 1"></line-chart></div>',
      );
    });

    it('wraps consecutive same-tag elements separately', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<kpi title="A"></kpi>\n<kpi title="B"></kpi>',
          ['kpi'],
        ),
        '\n\n<div><kpi title="A"></kpi></div>\n\n<div><kpi title="B"></kpi></div>',
      );
    });

    it('preserves text between elements', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<line-chart title="A"></line-chart>\n\nSome analysis here.\n\n<bar-chart title="B"></bar-chart>',
        ),
        '\n\n<div><line-chart title="A"></line-chart></div>\n\nSome analysis here.\n\n<div><bar-chart title="B"></bar-chart></div>',
      );
    });

    it('wraps element with markdown children', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<data-insight title="Analysis">**Revenue** is up 15%</data-insight>',
          ['data-insight'],
        ),
        '\n\n<div><data-insight title="Analysis">**Revenue** is up 15%</data-insight></div>',
      );
    });

    it('wraps element with trailing text after', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<line-chart title="A"></line-chart>\nDone.',
        ),
        '\n\n<div><line-chart title="A"></line-chart></div>\nDone.',
      );
    });
  });

  describe('edge cases', () => {
    it('does not wrap standard HTML elements like div, span', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<div>content</div>'),
        '<div>content</div>',
      );
    });

    it('handles empty string', () => {
      assert.strictEqual(normalizeStreamdownChildren(''), '');
    });

    it('handles string with no custom elements', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('Just plain text without any tags'),
        'Just plain text without any tags',
      );
    });

    it('wraps element with bare < in content text', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<data-insight>revenue < $1M</data-insight>',
          ['data-insight'],
        ),
        '\n\n<div><data-insight>revenue < $1M</data-insight></div>',
      );
    });

    it('does not add extra newline when text already ends with blank line', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          'Text\n\n<line-chart title="A"></line-chart>',
        ),
        'Text\n\n<div><line-chart title="A"></line-chart></div>',
      );
    });

    it('wraps tag with no attributes', () => {
      assert.strictEqual(
        normalizeStreamdownChildren('<row></row>', ['row']),
        '\n\n<div><row></row></div>',
      );
    });
  });

  describe('unclosed custom elements (malformed LLM output)', () => {
    // The model occasionally drops a closing tag mid-stream. A second <column>
    // left open used to be emitted bare (no wrapper, no close) while its
    // sibling was wrapped. Row's `[&>div]:contents` then dissolved the bare
    // column and collapsed the whole layout. Normalize must recover so every
    // column wraps symmetrically.
    function columnTally(out: string) {
      return {
        opens: (out.match(/<column\b/g) ?? []).length,
        closes: (out.match(/<\/column>/g) ?? []).length,
        wrapped: (out.match(/<div><column\b/g) ?? []).length,
      };
    }

    it('closes and wraps a column the model left open so siblings stay symmetric', () => {
      const out = normalizeStreamdownChildren(
        '<row>\n<column span="1">\nA\n</column>\n<column span="1">\nB\n</row>',
        ['row', 'column'],
      );
      assert.ok(typeof out === 'string');
      const { opens, closes, wrapped } = columnTally(out);
      assert.strictEqual(opens, 2, 'both columns should be present');
      assert.strictEqual(closes, opens, 'every column should be closed');
      assert.strictEqual(wrapped, opens, 'every column should be div-wrapped');
    });

    it('still wraps both columns when the markup is well-formed', () => {
      assert.strictEqual(
        normalizeStreamdownChildren(
          '<row><column>A</column><column>B</column></row>',
          ['row', 'column'],
        ),
        '\n\n<div><row><div><column>A</column></div><div><column>B</column></div></row></div>',
      );
    });

    it('recovers the real dropped-</column> row with service-cost children', () => {
      const out = normalizeStreamdownChildren(
        '<row>\n<column span="1">\n<service-cost service="gateway"></service-cost>\n</column>\n<column span="1">\n<service-cost service="database"></service-cost>\n<service-cost service="storage"></service-cost>\n</row>',
        ['row', 'column', 'service-cost'],
      );
      assert.ok(typeof out === 'string');
      const { opens, closes, wrapped } = columnTally(out);
      assert.strictEqual(closes, opens, 'every column should be closed');
      assert.strictEqual(wrapped, opens, 'every column should be div-wrapped');
    });

    it('auto-closes an unclosed inner element nested in a grid', () => {
      const out = normalizeStreamdownChildren(
        '<grid cols="2"><kpi title="A"></kpi><kpi title="B"></grid>',
        ['grid', 'kpi'],
      );
      assert.ok(typeof out === 'string');
      assert.strictEqual(
        (out.match(/<kpi\b/g) ?? []).length,
        (out.match(/<\/kpi>/g) ?? []).length,
        'every kpi should be closed',
      );
    });
  });
});
