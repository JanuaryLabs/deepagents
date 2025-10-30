import { tool } from 'ai';
import { z } from 'zod';

import { toState } from '@deepagents/agent';

export interface HNSearchItem {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  story_text: string | null;
  comment_text: string | null;
  num_comments: number | null;
  created_at: string;
  created_at_i: number;
  _tags: string[];
}

export interface HNSearchResponse {
  query: string;
  hits: HNSearchItem[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
}

export interface HNItemResponse {
  id: string;
  created_at: string;
  created_at_i: number;
  type: 'story' | 'comment' | 'poll' | 'pollopt' | 'show' | 'ask' | 'job';
  author: string;
  title?: string;
  url?: string;
  text?: string;
  points?: number;
  parent_id?: string;
  children?: HNItemResponse[];
  story_id?: string;
  story_title?: string;
  story_url?: string;
}

export interface HNUserResponse {
  username: string;
  about?: string;
  karma: number;
  created_at: string;
  created_at_i: number;
}

function buildTags(options: {
  type?: 'story' | 'comment' | 'all';
  author?: string;
}): string | undefined {
  const tags: string[] = [];

  if (options.type && options.type !== 'all') {
    tags.push(options.type);
  }

  if (options.author) {
    tags.push(`author_${options.author}`);
  }

  return tags.length > 0 ? tags.join(',') : undefined;
}

function buildNumericFilters(options: {
  timeFilter?: 'd' | 'w' | 'm' | 'y' | 'all';
  minPoints?: number;
  minComments?: number;
  maxAgeHours?: number;
}): string | undefined {
  const filters: string[] = [];

  if (options.timeFilter && options.timeFilter !== 'all') {
    const now = Math.floor(Date.now() / 1000);
    const timeMap = {
      d: 86400, // 1 day in seconds
      w: 604800, // 1 week
      m: 2592000, // ~30 days
      y: 31536000, // ~365 days
    };
    const seconds = timeMap[options.timeFilter];
    const timestamp = now - seconds;
    filters.push(`created_at_i>${timestamp}`);
  }

  if (options.maxAgeHours !== undefined && options.maxAgeHours > 0) {
    const now = Math.floor(Date.now() / 1000);
    const seconds = options.maxAgeHours * 3600;
    const timestamp = now - seconds;
    filters.push(`created_at_i>${timestamp}`);
  }

  if (options.minPoints !== undefined && options.minPoints > 0) {
    filters.push(`points>=${options.minPoints}`);
  }

  if (options.minComments !== undefined && options.minComments > 0) {
    filters.push(`num_comments>=${options.minComments}`);
  }

  return filters.length > 0 ? filters.join(',') : undefined;
}

async function searchHackerNewsAPI(params: {
  query?: string;
  tags?: string;
  numericFilters?: string;
  sortBy?: 'relevance' | 'date';
  page?: number;
  hitsPerPage?: number;
}): Promise<HNSearchResponse> {
  const {
    query = '',
    tags,
    numericFilters,
    sortBy = 'relevance',
    page = 0,
    hitsPerPage = 20,
  } = params;

  const endpoint =
    sortBy === 'date'
      ? 'http://hn.algolia.com/api/v1/search_by_date'
      : 'http://hn.algolia.com/api/v1/search';

  const urlParams = new URLSearchParams();

  if (query) {
    urlParams.set('query', query);
  }

  if (tags) {
    urlParams.set('tags', tags);
  }

  if (numericFilters) {
    urlParams.set('numericFilters', numericFilters);
  }

  urlParams.set('page', page.toString());
  urlParams.set('hitsPerPage', Math.min(hitsPerPage, 1000).toString());

  const url = `${endpoint}?${urlParams.toString()}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `HN API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    return data as HNSearchResponse;
  } catch (error) {
    throw new Error(
      `Failed to search HackerNews: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

async function fetchHNItem(id: string): Promise<HNItemResponse> {
  const url = `http://hn.algolia.com/api/v1/items/${id}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `HN API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    return data as HNItemResponse;
  } catch (error) {
    throw new Error(
      `Failed to fetch HN item: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

async function fetchHNUser(username: string): Promise<HNUserResponse> {
  const url = `http://hn.algolia.com/api/v1/users/${username}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `HN API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    return data as HNUserResponse;
  } catch (error) {
    throw new Error(
      `Failed to fetch HN user: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

function formatHNLink(id: string): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}...`;
}

function formatStoryItem(
  hit: HNSearchItem,
  index: number,
  page: number,
  hitsPerPage: number,
): string {
  const lines: string[] = [];
  const itemNumber = page * hitsPerPage + index + 1;

  lines.push(`\n${itemNumber}. ${hit.title || '(No title)'}`);

  if (hit.url) {
    lines.push(`   URL: ${hit.url}`);
  }

  if (hit.points !== null) {
    lines.push(
      `   ${hit.points} points | by ${hit.author} | ${hit.num_comments || 0} comments`,
    );
  } else {
    lines.push(`   by ${hit.author}`);
  }

  lines.push(`   Date: ${formatDate(hit.created_at_i)}`);

  if (hit.story_text) {
    lines.push(`   Text: ${truncateText(hit.story_text, 200)}`);
  }

  lines.push(`   HN Link: ${formatHNLink(hit.objectID)}`);

  return lines.join('\n');
}

function formatCommentItem(
  hit: HNSearchItem,
  index: number,
  page: number,
  hitsPerPage: number,
): string {
  const lines: string[] = [];
  const itemNumber = page * hitsPerPage + index + 1;

  lines.push(`\n${itemNumber}. Comment by ${hit.author}`);

  if (hit.comment_text) {
    lines.push(`   ${truncateText(hit.comment_text, 300)}`);
  }

  lines.push(`   Date: ${formatDate(hit.created_at_i)}`);
  lines.push(`   HN Link: ${formatHNLink(hit.objectID)}`);

  return lines.join('\n');
}

function formatMixedItem(
  hit: HNSearchItem,
  index: number,
  page: number,
  hitsPerPage: number,
): string {
  const lines: string[] = [];
  const itemNumber = page * hitsPerPage + index + 1;
  const isStory = hit._tags.includes('story');
  const isComment = hit._tags.includes('comment');
  const type = isStory ? 'Story' : 'Comment';

  lines.push(`\n${itemNumber}. [${type}] ${hit.title || 'Comment'}`);

  if (isStory) {
    if (hit.url) {
      lines.push(`   URL: ${hit.url}`);
    }
    if (hit.points !== null) {
      lines.push(`   ${hit.points} points | ${hit.num_comments || 0} comments`);
    }
    if (hit.story_text) {
      lines.push(`   Text: ${truncateText(hit.story_text, 200)}`);
    }
  } else if (isComment && hit.comment_text) {
    lines.push(`   ${truncateText(hit.comment_text, 200)}`);
  }

  lines.push(`   Date: ${formatDate(hit.created_at_i)}`);
  lines.push(`   HN Link: ${formatHNLink(hit.objectID)}`);

  return lines.join('\n');
}

function formatSearchResults(
  response: HNSearchResponse,
  options: {
    itemType: 'story' | 'comment' | 'mixed';
    emptyMessage: string;
  },
): string {
  const { hits, nbHits, page, nbPages } = response;
  const { itemType, emptyMessage } = options;

  if (hits.length === 0) {
    return emptyMessage;
  }

  const formatItem = (hit: HNSearchItem, index: number) => {
    switch (itemType) {
      case 'story':
        return formatStoryItem(hit, index, page, response.hitsPerPage);
      case 'comment':
        return formatCommentItem(hit, index, page, response.hitsPerPage);
      case 'mixed':
        return formatMixedItem(hit, index, page, response.hitsPerPage);
    }
  };

  const results = hits.map(formatItem);
  const typeLabel =
    itemType === 'mixed'
      ? 'results'
      : `${itemType === 'story' ? 'stories' : 'comments'}`;
  const header = `Found ${nbHits} ${typeLabel} (showing page ${page + 1} of ${nbPages}):\n`;

  return header + results.join('\n');
}

function formatStoryResults(response: HNSearchResponse): string {
  return formatSearchResults(response, {
    itemType: 'story',
    emptyMessage: `No stories found for query: "${response.query}"`,
  });
}

function formatCommentResults(response: HNSearchResponse): string {
  return formatSearchResults(response, {
    itemType: 'comment',
    emptyMessage: `No comments found for query: "${response.query}"`,
  });
}

function formatAuthorResults(response: HNSearchResponse): string {
  return formatSearchResults(response, {
    itemType: 'mixed',
    emptyMessage: 'No results found for this author',
  });
}

function formatItemDetails(item: HNItemResponse): string {
  const lines: string[] = [];

  if (item.type === 'story') {
    lines.push(`Story: ${item.title || '(No title)'}`);
    if (item.url) {
      lines.push(`URL: ${item.url}`);
    }
    lines.push(`By: ${item.author}`);
    if (item.points !== undefined) {
      lines.push(`Points: ${item.points}`);
    }
    lines.push(`Date: ${formatDate(item.created_at_i)}`);
    if (item.text) {
      lines.push(`\nText:\n${item.text}`);
    }
    lines.push(`\nHN Link: ${formatHNLink(item.id)}`);
  } else if (item.type === 'comment') {
    lines.push(`Comment by ${item.author}`);
    if (item.story_title) {
      lines.push(`On story: ${item.story_title}`);
    }
    lines.push(`Date: ${formatDate(item.created_at_i)}`);
    if (item.text) {
      lines.push(`\n${item.text}`);
    }
    lines.push(`\nHN Link: ${formatHNLink(item.id)}`);
  }

  return lines.join('\n');
}

function formatUserProfile(user: HNUserResponse): string {
  const lines: string[] = [];

  lines.push(`User: ${user.username}`);
  lines.push(`Karma: ${user.karma.toLocaleString()}`);
  lines.push(`Member since: ${formatDate(user.created_at_i)}`);

  if (user.about) {
    lines.push(`\nAbout:\n${user.about}`);
  }

  lines.push(
    `\nProfile: https://news.ycombinator.com/user?id=${user.username}`,
  );

  return lines.join('\n');
}

function formatJobItem(
  hit: HNSearchItem,
  index: number,
  page: number,
  hitsPerPage: number,
): string {
  const lines: string[] = [];
  const itemNumber = page * hitsPerPage + index + 1;

  lines.push(`\n${itemNumber}. ${hit.title || '(No title)'}`);

  if (hit.url) {
    lines.push(`   URL: ${hit.url}`);
  }

  lines.push(`   Posted by: ${hit.author}`);
  lines.push(`   Date: ${formatDate(hit.created_at_i)}`);

  if (hit.story_text) {
    lines.push(`   Description: ${truncateText(hit.story_text, 300)}`);
  }

  lines.push(`   HN Link: ${formatHNLink(hit.objectID)}`);

  return lines.join('\n');
}

function formatJobResults(response: HNSearchResponse): string {
  const { hits, nbHits, page, nbPages } = response;

  if (hits.length === 0) {
    return `No job postings found for query: "${response.query}"`;
  }

  const results = hits.map((hit, index) =>
    formatJobItem(hit, index, page, response.hitsPerPage),
  );

  const header = `Found ${nbHits} job postings (showing page ${page + 1} of ${nbPages}):\n`;
  return header + results.join('\n');
}

export const search_by_query = tool({
  description:
    'Tool to search HackerNews stories by keywords and filters. Use when you need to find HN stories matching specific search criteria, time periods, or popularity thresholds.',
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        'Search query for story titles and content. Examples: "artificial intelligence", "python"',
      ),
    timeFilter: z
      .enum(['d', 'w', 'm', 'y', 'all'])
      .default('all')
      .describe('Time filter: d=day, w=week, m=month, y=year, all=no filter'),
    minPoints: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum points threshold'),
    minComments: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum comments threshold'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('relevance')
      .describe('Sort results by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const numericFilters = buildNumericFilters({
      timeFilter: input.timeFilter,
      minPoints: input.minPoints,
      minComments: input.minComments,
    });

    const response = await searchHackerNewsAPI({
      query: input.query,
      tags: 'story',
      numericFilters,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatStoryResults(response);
  },
});

export const search_by_author = tool({
  description:
    'Tool to search HackerNews content by author username. Use when you need to find all stories, comments, or both by a specific HN user.',
  inputSchema: z.object({
    author: z
      .string()
      .describe('HackerNews username to search for. Examples: "pg", "tptacek"'),
    type: z
      .enum(['story', 'comment', 'all'])
      .default('all')
      .describe('Type of content: story, comment, or all'),
    timeFilter: z
      .enum(['d', 'w', 'm', 'y', 'all'])
      .default('all')
      .describe('Time filter: d=day, w=week, m=month, y=year, all=no filter'),
    minComments: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum comments threshold (for stories only)'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('date')
      .describe('Sort results by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const tags = buildTags({ type: input.type, author: input.author });
    const numericFilters = buildNumericFilters({
      timeFilter: input.timeFilter,
      minComments: input.minComments,
    });

    const response = await searchHackerNewsAPI({
      tags,
      numericFilters,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatAuthorResults(response);
  },
});

export const get_story_item = tool({
  description:
    'Tool to get detailed information about a specific HackerNews story by ID. Use when you need full details about a particular HN story including title, URL, author, points, and comments.',
  inputSchema: z.object({
    storyId: z.string().describe('HackerNews story ID. Example: "38709478"'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const item = await fetchHNItem(input.storyId);

    if (item.type !== 'story') {
      throw new Error(
        `Item ${input.storyId} is not a story (type: ${item.type})`,
      );
    }

    context.hackernews_sources.push({
      title: item.title || 'Untitled',
      hn_url: `https://news.ycombinator.com/item?id=${item.id}`,
      story_url: item.url || '',
    });

    return formatItemDetails(item);
  },
});

export const get_story_comment = tool({
  description:
    'Tool to get detailed information about a specific HackerNews comment by ID. Use when you need full details about a particular comment including text, author, and parent story information.',
  inputSchema: z.object({
    commentId: z
      .string()
      .describe('HackerNews comment ID. Example: "38710123"'),
  }),
  execute: async (input) => {
    const item = await fetchHNItem(input.commentId);

    if (item.type !== 'comment') {
      throw new Error(
        `Item ${input.commentId} is not a comment (type: ${item.type})`,
      );
    }

    return formatItemDetails(item);
  },
});

export const get_front_page_stories = tool({
  description:
    'Tool to get current HackerNews front page stories. Use when you need to see the latest trending and popular stories on HN.',
  inputSchema: z.object({
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(30)
      .describe('Results per page (max 50)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const response = await searchHackerNewsAPI({
      tags: 'front_page',
      sortBy: 'date',
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatStoryResults(response);
  },
});

export const get_story_comments = tool({
  description:
    'Tool to get all comments for a specific HackerNews story. Use when you need to read the discussion and comments on a particular HN story.',
  inputSchema: z.object({
    storyId: z.string().describe('HackerNews story ID. Example: "38709478"'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('date')
      .describe('Sort comments by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input) => {
    const response = await searchHackerNewsAPI({
      tags: `comment,story_${input.storyId}`,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    return formatCommentResults(response);
  },
});

export const search_ask_hn = tool({
  description:
    'Tool to search Ask HN posts - questions posed to the HackerNews community. Use when you need to find community questions and discussions on specific topics.',
  inputSchema: z.object({
    query: z
      .string()
      .default('')
      .describe(
        'Search query for Ask HN posts. Examples: "artificial intelligence", "career"',
      ),
    timeFilter: z
      .enum(['d', 'w', 'm', 'y', 'all'])
      .default('all')
      .describe('Time filter: d=day, w=week, m=month, y=year, all=no filter'),
    minPoints: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum points threshold'),
    minComments: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum comments threshold'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('relevance')
      .describe('Sort by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const numericFilters = buildNumericFilters({
      timeFilter: input.timeFilter,
      minPoints: input.minPoints,
      minComments: input.minComments,
    });

    const response = await searchHackerNewsAPI({
      query: input.query,
      tags: 'ask_hn',
      numericFilters,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatStoryResults(response);
  },
});

export const search_show_hn = tool({
  description:
    'Tool to search Show HN posts - projects and products shared with the HackerNews community. Use when you need to discover community projects, demos, or products on specific topics.',
  inputSchema: z.object({
    query: z
      .string()
      .default('')
      .describe(
        'Search query for Show HN posts. Examples: "web app", "open source"',
      ),
    timeFilter: z
      .enum(['d', 'w', 'm', 'y', 'all'])
      .default('all')
      .describe('Time filter: d=day, w=week, m=month, y=year, all=no filter'),
    minPoints: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum points threshold'),
    minComments: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum comments threshold'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('relevance')
      .describe('Sort by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const numericFilters = buildNumericFilters({
      timeFilter: input.timeFilter,
      minPoints: input.minPoints,
      minComments: input.minComments,
    });

    const response = await searchHackerNewsAPI({
      query: input.query,
      tags: 'show_hn',
      numericFilters,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatStoryResults(response);
  },
});

export const search_jobs = tool({
  description:
    'Tool to search HackerNews job postings. Use when you need to find tech job opportunities posted on HN.',
  inputSchema: z.object({
    query: z
      .string()
      .default('')
      .describe(
        'Search query for job postings. Examples: "remote", "machine learning"',
      ),
    timeFilter: z
      .enum(['d', 'w', 'm', 'y', 'all'])
      .default('all')
      .describe('Time filter: d=day, w=week, m=month, y=year, all=no filter'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('date')
      .describe('Sort by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const numericFilters = buildNumericFilters({
      timeFilter: input.timeFilter,
    });

    const response = await searchHackerNewsAPI({
      query: input.query,
      tags: 'job',
      numericFilters,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatJobResults(response);
  },
});

export const search_polls = tool({
  description:
    'Tool to search HackerNews polls - community surveys and voting. Use when you need to find community polls on various topics.',
  inputSchema: z.object({
    query: z
      .string()
      .default('')
      .describe('Search query for polls. Example: "programming language"'),
    timeFilter: z
      .enum(['d', 'w', 'm', 'y', 'all'])
      .default('all')
      .describe('Time filter: d=day, w=week, m=month, y=year, all=no filter'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('date')
      .describe('Sort by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const numericFilters = buildNumericFilters({
      timeFilter: input.timeFilter,
    });

    const response = await searchHackerNewsAPI({
      query: input.query,
      tags: 'poll',
      numericFilters,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatStoryResults(response);
  },
});

export const get_user_profile = tool({
  description:
    "Tool to get HackerNews user profile information. Use when you need to view a user's karma, account creation date, and bio.",
  inputSchema: z.object({
    username: z.string().describe('HackerNews username. Example: "pg"'),
  }),
  execute: async (input) => {
    const user = await fetchHNUser(input.username);
    return formatUserProfile(user);
  },
});

export const search_by_domain = tool({
  description:
    'Tool to search HackerNews stories from a specific domain or website. Use when you need to find all HN posts from a particular domain or track discussions about content from specific websites.',
  inputSchema: z.object({
    domain: z
      .string()
      .describe('Domain to search. Examples: "github.com", "arxiv.org"'),
    timeFilter: z
      .enum(['d', 'w', 'm', 'y', 'all'])
      .default('all')
      .describe('Time filter: d=day, w=week, m=month, y=year, all=no filter'),
    minPoints: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum points threshold'),
    minComments: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum comments threshold'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('date')
      .describe('Sort by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const numericFilters = buildNumericFilters({
      timeFilter: input.timeFilter,
      minPoints: input.minPoints,
      minComments: input.minComments,
    });

    const urlParams = new URLSearchParams();
    urlParams.set('query', input.domain);
    urlParams.set('restrictSearchableAttributes', 'url');
    urlParams.set('tags', 'story');
    if (numericFilters) {
      urlParams.set('numericFilters', numericFilters);
    }
    urlParams.set('page', input.page.toString());
    urlParams.set('hitsPerPage', input.hitsPerPage.toString());

    const endpoint =
      input.sortBy === 'date'
        ? 'http://hn.algolia.com/api/v1/search_by_date'
        : 'http://hn.algolia.com/api/v1/search';

    const url = `${endpoint}?${urlParams.toString()}`;

    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(
        `HN API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as HNSearchResponse;
    fillContext(context, data);
    return formatStoryResults(data);
  },
});

export const search_highly_discussed = tool({
  description:
    'Tool to search for highly discussed HackerNews stories with many comments. Use when you need to find engaging or controversial discussions with significant community participation.',
  inputSchema: z.object({
    minComments: z
      .number()
      .int()
      .min(1)
      .describe(
        'Minimum number of comments (required). Example: 100 for highly discussed stories',
      ),
    query: z
      .string()
      .default('')
      .describe('Optional search query. Example: "AI"'),
    timeFilter: z
      .enum(['d', 'w', 'm', 'y', 'all'])
      .default('all')
      .describe('Time filter: d=day, w=week, m=month, y=year, all=no filter'),
    minPoints: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum points threshold'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('date')
      .describe('Sort by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Results per page (max 1000)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const numericFilters = buildNumericFilters({
      timeFilter: input.timeFilter,
      minPoints: input.minPoints,
      minComments: input.minComments,
    });

    const response = await searchHackerNewsAPI({
      query: input.query,
      tags: 'story',
      numericFilters,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatStoryResults(response);
  },
});

export const search_trending = tool({
  description:
    "Tool to find currently trending HackerNews stories - recent posts with high engagement. Use when you need to discover what's hot right now on HN by combining recency with high points and comments.",
  inputSchema: z.object({
    minPoints: z
      .number()
      .int()
      .min(10)
      .default(50)
      .describe(
        'Minimum points threshold. Example: 100 for highly upvoted stories',
      ),
    maxAgeHours: z
      .number()
      .int()
      .min(1)
      .max(72)
      .default(24)
      .describe('Maximum age in hours. Example: 24 for stories from today'),
    minComments: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe('Minimum comments threshold'),
    sortBy: z
      .enum(['relevance', 'date'])
      .default('date')
      .describe('Sort by relevance or date'),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Page number (0-indexed)'),
    hitsPerPage: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .describe('Results per page (max 100)'),
  }),
  execute: async (input, options) => {
    const context = toState<{
      hackernews_sources: {
        title: string;
        hn_url: string;
        story_url: string;
      }[];
    }>(options);
    context.hackernews_sources ??= [];

    const numericFilters = buildNumericFilters({
      maxAgeHours: input.maxAgeHours,
      minPoints: input.minPoints,
      minComments: input.minComments,
    });

    const response = await searchHackerNewsAPI({
      tags: 'story',
      numericFilters,
      sortBy: input.sortBy,
      page: input.page,
      hitsPerPage: input.hitsPerPage,
    });

    fillContext(context, response);
    return formatStoryResults(response);
  },
});

function fillContext(
  context: {
    hackernews_sources: {
      title?: string | null;
      hn_url?: string | null;
      story_url?: string | null;
      story_text?: string | null;
      comment_text?: string | null;
    }[];
  },
  result: HNSearchResponse,
) {
  result.hits.forEach((hit) => {
    context.hackernews_sources.push({
      title: hit.title,
      hn_url: hit.objectID
        ? `https://news.ycombinator.com/item?id=${hit.objectID}`
        : undefined,
      story_url: hit.url,
      story_text: hit.story_text,
      comment_text: hit.comment_text,
    });
  });
}

export const hackernewsTools = {
  search_by_query,
  search_by_author,
  get_story_item,
  get_story_comment,
  get_front_page_stories,
  get_story_comments,
  search_ask_hn,
  search_show_hn,
  search_jobs,
  search_polls,
  get_user_profile,
  search_by_domain,
  search_highly_discussed,
  search_trending,
};
