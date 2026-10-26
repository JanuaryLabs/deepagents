import { experimental_createWebFetchTool } from '@ai-sdk/tool-web-fetch';
import { HttpServer } from '@zukhruf/testing/http';
import assert from 'node:assert/strict';
import { type TestContext, describe, it, mock } from 'node:test';

const nativeFetch = globalThis.fetch;
// Keep the SDK implementation; route only its HTTP transport to globalThis.fetch,
// which each test redirects to its own server. The connector binds the tool when
// it loads, so a mock made inside a later test would never reach it: this one
// mock lives for the file's own test process and holds no state between tests.
mock.module('@ai-sdk/tool-web-fetch', {
  namedExports: {
    experimental_createWebFetchTool: (
      options: Parameters<typeof experimental_createWebFetchTool>[0],
    ) =>
      experimental_createWebFetchTool({
        ...options,
        fetch: (input, init) => globalThis.fetch(input, init),
      }),
  },
});

const { rss } = await import('@deepagents/retrieval/connectors');
const summary =
  'The feed contains useful background and source details. '.repeat(8);
const paragraph =
  'This article explains how a small research team records its discoveries and preserves reliable sources. Each result includes enough detail for another person to reproduce the investigation and assess the evidence. ';
const article = {
  status: 200,
  contentType: 'text/html',
  body: `<!doctype html><html><head><title>Research notes</title></head><body><nav>Menu Home</nav><article><h1>Research notes</h1><p>${paragraph.repeat(3)}</p><p>A <strong>significant finding</strong> with a <a href="https://source.example.com/proof">source reference</a>.</p><p>${paragraph.repeat(3)}</p></article></body></html>`,
};
const publicArticleUrl = 'https://articles.example.com/article';

async function fixture(
  t: TestContext,
  response: typeof article,
  articleUrl: string,
) {
  const requests: string[] = [];
  const server = await new HttpServer().start((request, reply) => {
    if (request.url === '/feed') {
      reply.setHeader('content-type', 'application/rss+xml');
      reply.end(`<rss version="2.0"><channel>
        <title>Research feed</title><link>https://feeds.example.com</link><description>Research updates</description>
        <item><title>Research notes</title><guid>article-one</guid><link>${articleUrl}</link>
          <description>${summary}</description><author>Researcher</author><category>Science</category>
          <pubDate>Sat, 24 Oct 2026 10:00:00 GMT</pubDate></item>
        <item><title>Second article</title><guid>article-two</guid><description>Second summary</description></item>
      </channel></rss>`);
      return;
    }
    assert.ok(request.url);
    requests.push(request.url);
    reply.writeHead(response.status, { 'content-type': response.contentType });
    reply.end(response.body);
  });
  t.mock.method(
    globalThis,
    'fetch',
    (input: Parameters<typeof fetch>[0], init: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.hostname, 'articles.example.com');
      return nativeFetch(`${server.origin}${url.pathname}`, init);
    },
  );
  return Object.assign(server, { requests });
}

describe('RSS article ingestion', () => {
  it('preserves feed content, metadata, and item limits without fetching articles by default', async (t) => {
    await using server = await fixture(t, article, publicArticleUrl);
    const connector = rss(`${server.origin}/feed`, { maxItems: 1 });
    const sources = await Array.fromAsync(connector.sources());

    assert.equal(connector.sourceId, `rss:${server.origin}/feed`);
    assert.deepEqual(
      sources.map(({ id }) => id),
      ['feed-info', 'article-one'],
    );
    assert.match(await sources[0].content(), /RSS Feed: Research feed/);
    const content = await sources[1].content();
    assert.match(
      content,
      /Title: Research notes\nAuthor: Researcher\nPublished: Sat, 24 Oct 2026 10:00:00 GMT\nCategories: Science/,
    );
    assert.ok(content.includes(`Content:\n${summary}`));
    assert.deepEqual(server.requests, []);
  });

  it('extracts Markdown with source links while preserving feed metadata', async (t) => {
    await using server = await fixture(t, article, publicArticleUrl);
    const sources = await Array.fromAsync(
      rss(`${server.origin}/feed`, {
        maxItems: 1,
        fetchFullArticles: true,
      }).sources(),
    );
    const content = await sources[1].content();

    assert.match(content, /\*\*significant finding\*\*/);
    assert.match(
      content,
      /\[source reference\]\(https:\/\/source\.example\.com\/proof\)/,
    );
    assert.match(content, /Author: Researcher/);
    assert.ok(content.includes(`Link: ${publicArticleUrl}`));
    assert.ok(content.includes(`Summary: Research notes - ${summary}`));
    assert.deepEqual(server.requests, ['/article']);
  });

  for (const [name, response] of [
    ['HTTP failure', { ...article, status: 503, body: 'Service unavailable' }],
    [
      'content below the minimum length',
      {
        ...article,
        body: '<html><body><article>Too short</article></body></html>',
      },
    ],
    [
      'content shorter than the feed summary',
      {
        ...article,
        contentType: 'text/plain',
        body: 'A shorter extracted article. '.repeat(10),
      },
    ],
  ] as const) {
    it(`keeps the feed summary after ${name}`, async (t) => {
      await using server = await fixture(t, response, publicArticleUrl);
      const sources = await Array.fromAsync(
        rss(`${server.origin}/feed`, {
          maxItems: 1,
          fetchFullArticles: true,
        }).sources(),
      );

      assert.ok(
        (await sources[1].content()).includes(
          `Full Article Content:\n${summary}`,
        ),
      );
      assert.deepEqual(server.requests, ['/article']);
    });
  }

  it('uses the feed summary for private-network article URLs without sending a request', async (t) => {
    await using server = await fixture(t, article, 'http://127.0.0.1/private');
    const sources = await Array.fromAsync(
      rss(`${server.origin}/feed`, {
        maxItems: 1,
        fetchFullArticles: true,
      }).sources(),
    );

    assert.ok(
      (await sources[1].content()).includes(
        `Full Article Content:\n${summary}`,
      ),
    );
    assert.deepEqual(server.requests, []);
  });

  it('ingests the complete document beyond the SDK interactive reading limit', async (t) => {
    const body = `${paragraph.repeat(300)}END OF COMPLETE ARTICLE`;
    assert.ok(body.length > 50_000);
    await using server = await fixture(
      t,
      { ...article, contentType: 'text/plain', body },
      publicArticleUrl,
    );
    const sources = await Array.fromAsync(
      rss(`${server.origin}/feed`, {
        maxItems: 1,
        fetchFullArticles: true,
      }).sources(),
    );

    assert.ok(
      (await sources[1].content()).includes(`Full Article Content:\n${body}`),
    );
    assert.deepEqual(server.requests, ['/article']);
  });
});
