export interface HfOptions {
  dataset: string;
  config: string;
  split: string;
  rows?: number;
}

/** The fields this module reads from a datasets-server `/rows` page. */
interface HfRowsPage {
  rows: Array<{ row_idx: number; row: Record<string, unknown> }>;
  num_rows_total: number;
}

const HF_BASE_URL = 'https://datasets-server.huggingface.co/rows';
const PAGE_SIZE = 100;

export function hf(options: HfOptions): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]() {
      return paginate(options);
    },
  };
}

async function* paginate(
  options: HfOptions,
): AsyncGenerator<Record<string, unknown>> {
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
      yield entry.row;
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

export async function downloadHf(options: HfOptions): Promise<string> {
  const lines: string[] = [];
  for await (const row of hf(options)) {
    lines.push(JSON.stringify(row));
  }
  return lines.join('\n');
}

async function fetchPage(url: string): Promise<HfRowsPage> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `HuggingFace API error ${response.status}: ${body || response.statusText}`,
    );
  }
  const text = await response.text();
  const page = parseJson(text, url);
  if (!isHfRowsPage(page)) {
    throw new Error(
      `HuggingFace API returned an unexpected rows page from ${url}: ${text.slice(0, 200)}`,
    );
  }
  return page;
}

function parseJson(text: string, url: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `HuggingFace API returned non-JSON response from ${url}: ${text.slice(0, 200)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHfRowsPage(value: unknown): value is HfRowsPage {
  return (
    isRecord(value) &&
    typeof value.num_rows_total === 'number' &&
    Array.isArray(value.rows) &&
    value.rows.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.row_idx === 'number' &&
        isRecord(entry.row),
    )
  );
}
