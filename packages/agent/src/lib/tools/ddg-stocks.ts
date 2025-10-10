import { tool } from 'ai';
import { stocks as ddgStocks } from 'duck-duck-scrape';
import { z } from 'zod';

type Quote = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  last: number | null;
  change: number | null;
  percentChange: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  date: string | null; // ET
  time: string | null; // ET
  halted: boolean | null;
  source: 'DuckDuckGo/Xignite';
  raw?: unknown; // optional raw for debugging
};

const toQuote = (r: any): Quote => ({
  symbol: r?.Security?.Symbol ?? null,
  name: r?.Security?.Name ?? null,
  exchange: r?.Security?.Market ?? null,
  currency: r?.Currency ?? null,
  last: r?.Last ?? null,
  change: r?.ChangeFromPreviousClose ?? null,
  percentChange: r?.PercentChangeFromPreviousClose ?? null,
  open: r?.Open ?? null,
  high: r?.High ?? null,
  low: r?.Low ?? null,
  prevClose: r?.PreviousClose ?? null,
  volume: r?.Volume ?? null,
  date: r?.Date ?? null,
  time: r?.Time ?? null,
  halted: r?.TradingHalted ?? null,
  source: 'DuckDuckGo/Xignite',
  raw: r,
});

export const duckStocks = tool({
  description: 'A tool for fetching stock market quotes. Useful for when you need to get the latest stock price and related information for one or more stock symbols.',
  inputSchema: z.object({
    symbols: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .transform((s) => (Array.isArray(s) ? s : [s])),
    includeRaw: z.boolean().default(false),
  }),
  execute: async ({ symbols, includeRaw }) => {
    const tasks = symbols.map(async (s) => {
      const sym = s.trim().toUpperCase();
      try {
        const r = await ddgStocks(sym);
        if (!r || (r.Outcome && r.Outcome !== 'Success')) {
          return { symbol: sym, error: r?.Message || 'No quote' };
        }
        const q = toQuote(r);
        if (!includeRaw) delete q.raw;
        return q;
      } catch (e: any) {
        return { symbol: sym, error: e?.message || 'fetch_failed' };
      }
    });
    const results = await Promise.all(tasks);
    return { results };
  },
});
