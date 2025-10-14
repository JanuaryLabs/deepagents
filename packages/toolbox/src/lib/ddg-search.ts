import { tool } from 'ai';
import * as ddg from 'duck-duck-scrape';
import { uniqBy } from 'lodash-es';
import { z } from 'zod';

export type Source = 'text' | 'news' | 'images';

export async function serp({
  query,
  source,
  locale = 'en-us',
  maxResults = 50,
  ...input
}: z.input<typeof ddgSearchSchema>) {
  const safeSearch =
    ddg.SafeSearchType[
      'MODERATE'
      // input.safesearch.toUpperCase() as keyof typeof ddg.SafeSearchType
    ];
  const time =
    ddg.SearchTimeType[
      input.time?.toUpperCase() as keyof typeof ddg.SearchTimeType
    ];

  if (source === 'text') {
    const res = await ddg.search(query, {
      region: 'wt-wt',
      safeSearch,
      time,
      locale,
    });
    const items = res.results.slice(0, maxResults).map((r) => ({
      snippet: r.description,
      title: r.title,
      link: r.url,
      hostname: r.hostname,
    }));
    return { items, total: res.results.length, vqd: res.vqd } as const;
  }

  if (source === 'news') {
    const res = await ddg.searchNews(query, {
      safeSearch,
      time,
    });
    const items = res.results.slice(0, maxResults).map((r) => ({
      snippet: r.excerpt,
      title: r.title,
      link: r.url,
      date: r.date, // epoch ms
      source: r.syndicate,
      image: r.image,
      relativeTime: r.relativeTime,
    }));
    return { items, total: res.results.length, vqd: res.vqd } as const;
  }

  const res = await ddg.searchImages(query, { safeSearch });
  const items = res.results.slice(0, maxResults).map((r) => ({
    title: r.title,
    thumbnail: r.thumbnail,
    image: r.image,
    link: r.url,
    height: r.height,
    width: r.width,
    source: r.source,
  }));
  return { items, total: res.results.length, vqd: res.vqd } as const;
}

async function performSearch(query: string) {
  const results = await serp({
    source: 'news',
    query: query,
  });
  const result = uniqBy(results.items as { link: string }[], (it) => it.link);
  return result as typeof results.items;
}

export const ddgSearchSchema = z.object({
  query: z.string().min(1),
  source: z.enum(['text', 'news', 'images']).default('text'),
  locale: z.string().optional().default('en-us'),
  // region: z.string().default('wt-wt'),
  // safesearch: z.enum(['strict', 'moderate', 'off']).default('moderate'),
  time: z.enum(['d', 'w', 'm', 'y']).optional(),
  maxResults: z.number().int().positive().max(50).default(5),
});
export const duckDuckGoSearch = tool({
  description:
    'A tool for searching the web. Useful for when you need to find information about current events or topics that are not covered in your training data.',
  inputSchema: ddgSearchSchema,
  execute: serp,
});
