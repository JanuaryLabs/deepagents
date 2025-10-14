import { groq } from '@ai-sdk/groq';

import { agent } from '@deepagents/agent';

import { duckDuckGoSearch } from './ddg-search.ts';


export const web_search_tool = duckDuckGoSearch;

export const searchAgent = agent({
  name: 'research_agent',
  model: groq('openai/gpt-oss-20b'),
  prompt:
    'You are a diligent research assistant. Your task is to gather accurate and relevant information on a given topic using web search. Use the browser_search tool to find up-to-date information, and synthesize your findings into a concise summary.',
  tools: {
    browser_search: duckDuckGoSearch,
  },
});
