export interface HfOptions {
  dataset: string;
  config: string;
  split: string;
  rows?: number;
}

interface HfApiResponse {
  rows: Array<{ row_idx: number; row: Record<string, unknown> }>;
  num_rows_total: number;
}

const HF_BASE_URL = 'https://datasets-server.huggingface.co/rows';
const PAGE_SIZE = 100;

export function hf<T = Record<string, unknown>>(
  options: HfOptions,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return paginate<T>(options);
    },
  };
}

async function* paginate<T>(options: HfOptions): AsyncGenerator<T> {
  const { dataset, config, split, rows } = options;
  const limit = rows ?? Infinity;
  let offset = 0;
  let yielded = 0;

  while (yielded < limit) {
    const pageSize =
      limit === Infinity ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - yielded);
    const url = buildUrl(dataset, config, split, offset, pageSize);
    const page = await fetchPage(url);

    if (page.rows.length === 0) return;

    for (const entry of page.rows) {
      yield entry.row as T;
      yielded++;
      if (yielded >= limit) return;
    }

    offset += page.rows.length;
    if (page.rows.length < pageSize || offset >= page.num_rows_total) return;
  }
}

function buildUrl(
  dataset: string,
  config: string,
  split: string,
  offset: number,
  length: number,
): string {
  const url = new URL(HF_BASE_URL);
  url.searchParams.set('dataset', dataset);
  url.searchParams.set('config', config);
  url.searchParams.set('split', split);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('length', String(length));
  return url.toString();
}

export async function fetchHfRows(
  options: { dataset: string; config: string; split: string },
  offset: number,
  length: number,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const url = buildUrl(
    options.dataset,
    options.config,
    options.split,
    offset,
    length,
  );
  const page = await fetchPage(url);
  return {
    rows: page.rows.map((entry) => entry.row),
    total: page.num_rows_total,
  };
}

async function fetchPage(url: string): Promise<HfApiResponse> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `HuggingFace API error ${response.status}: ${body || response.statusText}`,
    );
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as HfApiResponse;
  } catch {
    throw new Error(
      `HuggingFace API returned non-JSON response from ${url}: ${text.slice(0, 200)}`,
    );
  }
}
