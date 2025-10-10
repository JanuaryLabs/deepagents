import { Readability } from '@mozilla/readability';
import Parser from 'rss-parser';

const rssParser = new Parser({
  customFields: {
    feed: ['copyright', 'language', 'managingEditor', 'webMaster'],
    item: ['category', 'creator', 'enclosure', 'guid'],
  },
});

async function parseRSSFeed(feedUrl: string) {
  try {
    console.log(`Fetching RSS feed: ${feedUrl}`);
    const feed = await rssParser.parseURL(feedUrl);

    return {
      title: feed.title || '',
      description: feed.description || '',
      link: feed.link || '',
      language: feed.language || 'en',
      lastBuildDate: (feed as any).lastBuildDate || new Date().toISOString(),
      items: feed.items.map((item) => ({
        title: item.title || '',
        description: item.content || item.summary || item.contentSnippet || '',
        link: item.link || '',
        pubDate: item.pubDate || item.isoDate || '',
        author: item.creator || (item as any).author || '',
        categories: Array.isArray(item.categories)
          ? item.categories
          : item.category
            ? [item.category]
            : [],
        guid: item.guid || item.guid || '',
        contentEncoded:
          (item as any)['content:encoded'] || (item as any).content || '',
      })),
    };
  } catch (error) {
    console.error(`Failed to parse RSS feed ${feedUrl}:`, error);
    throw new Error(
      `RSS parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

async function fetchArticleContent(url: string): Promise<string> {
  try {
    console.log(`Fetching full article content from: ${url}`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS-RAG-Bot/1.0)',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        Connection: 'keep-alive',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    // Use Mozilla's Readability to extract the main content
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) {
      throw new Error('Readability failed to extract article content');
    }

    // Combine title and content for comprehensive text
    const fullContent = `${article.title ? article.title + '\n\n' : ''}${article.textContent || article.content}`;

    // Ensure we have meaningful content (at least 200 characters for full articles)
    if (fullContent.length < 200) {
      throw new Error(
        `Extracted content too short (${fullContent.length} chars) - likely failed to find main content`,
      );
    }

    console.log(
      `✓ Successfully extracted article: "${article.title}" (${fullContent.length} chars, ~${Math.round(fullContent.split(' ').length)} words)`,
    );

    return fullContent;
  } catch (error) {
    console.warn(
      `Failed to fetch article content from ${url}:`,
      error instanceof Error ? error.message : error,
    );
    return ''; // Return empty string on failure rather than throwing
  }
}
export function rss(
  feedUrl: string,
  options: {
    maxItems?: number;
    fetchFullArticles?: boolean;
  } = {},
) {
  const sourceId = `rss:${feedUrl}`;
  const { maxItems = 50, fetchFullArticles = false } = options;

  return {
    sourceId,
    instructions: `You answer questions about articles and content from the RSS feed: ${feedUrl}.
      Always cite the article title and link when referencing specific content.
      The feed contains recent articles, blog posts, and news items.
      When referencing content, include the publication date and author when available.
      ${fetchFullArticles ? 'Full article content has been extracted from the original links for comprehensive analysis.' : 'Content includes RSS summaries and descriptions.'}`,
    sources: async function* () {
      const feed = await parseRSSFeed(feedUrl);
      // Add feed summary source
      const feedSummary = `RSS Feed: ${feed.title}
Description: ${feed.description}
Website: ${feed.link}
Language: ${feed.language}
Last Updated: ${feed.lastBuildDate}
Total Items: ${feed.items.length}

This feed provides: ${feed.description}`;
      yield {
        id: 'feed-info',
        content: async () => feedSummary,
      };

      // Individual article sources (limit to maxItems)
      const itemsToProcess = feed.items.slice(0, maxItems);
      for (const item of itemsToProcess) {
        const documentId =
          item.guid || item.link || `${item.title}-${item.pubDate}`;
        yield {
          id: documentId,
          content: async () => {
            // Try full article fetch if enabled, fallback to RSS content
            let articleContent = item.contentEncoded || item.description;
            if (fetchFullArticles && item.link) {
              const fullContent = await fetchArticleContent(item.link);
              if (fullContent && fullContent.length > articleContent.length) {
                articleContent = fullContent;
              }
            }
            return `Title: ${item.title}
Author: ${item.author}
Published: ${item.pubDate}
Categories: ${item.categories.join(', ')}
Link: ${item.link}
${fetchFullArticles ? 'Full Article Content:' : 'Content:'}
${articleContent}

Summary: ${item.title} - ${item.description}`;
          },
        };
      }
    },
  };
}
