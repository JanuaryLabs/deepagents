import { tool } from 'ai';
import * as ddg from 'duck-duck-scrape';
import { z } from 'zod';

export type Source = 'text' | 'news' | 'images';

export const duckDuckGoSearch = tool({
  description:
    'A tool for searching the web. Useful for when you need to find information about current events or topics that are not covered in your training data.',
  inputSchema: z.object({
    query: z.string().min(1),
    source: z.enum(['text', 'news', 'images']).default('text'),
    region: z.string().default('wt-wt'),
    locale: z.string().optional(),
    safesearch: z.enum(['strict', 'moderate', 'off']).default('moderate'),
    time: z.enum(['d', 'w', 'm', 'y']).optional(),
    maxResults: z.number().int().positive().max(50).default(5),
  }),
  execute: async ({ query, source, region, locale, maxResults, ...input }) => {
    console.log('DuckDuckGo search', {
      query,
      source,
      region,
      locale,
      maxResults,
      ...input,
    });
    const safeSearch =
      ddg.SafeSearchType[
        input.safesearch.toUpperCase() as keyof typeof ddg.SafeSearchType
      ];
    const time =
      ddg.SearchTimeType[
        input.time?.toUpperCase() as keyof typeof ddg.SearchTimeType
      ];

    if (source === 'text') {
      const res = await ddg.search(query, { region, safeSearch, time, locale });
      console.log({ text: res });
      const items = res.results.slice(0, maxResults).map((r) => ({
        snippet: r.description,
        title: r.title,
        link: r.url,
        hostname: r.hostname,
      }));
      return { items, total: res.results.length, vqd: res.vqd };
    }

    if (source === 'news') {
      const res = await ddg.searchNews(query, { safeSearch, time });
      const items = res.results.slice(0, maxResults).map((r) => ({
        snippet: r.excerpt,
        title: r.title,
        link: r.url,
        date: r.date, // epoch ms
        source: r.syndicate,
        image: r.image,
        relativeTime: r.relativeTime,
      }));
      return { items, total: res.results.length, vqd: res.vqd };
    }

    const res = await ddg.searchImages(query, { safeSearch });
    const items = res.results.slice(0, maxResults).map((r) => ({
      title: r.title,
      thumbnail: r.thumbnail,
      image: r.image,
      url: r.url,
      height: r.height,
      width: r.width,
      source: r.source,
    }));
    return { items, total: res.results.length, vqd: res.vqd };
  },
});
