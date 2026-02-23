import { Hono } from 'hono';
import { raw } from 'hono/html';

import { dataset } from '../../../dataset/index.ts';
import { fetchHfRows } from '../../../dataset/hf.ts';
import type { HfDatasetRef } from '../services/dataset-store.ts';
import { Layout } from '../components/Layout.tsx';
import {
  datasetPath,
  isHfDataset,
  listDatasets,
  readHfConfig,
} from '../services/dataset-store.ts';

const app = new Hono();

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function displayName(filename: string, hfRef: HfDatasetRef | null): string {
  if (hfRef) return `${hfRef.dataset} (${hfRef.config}/${hfRef.split})`;
  return filename;
}

function truncate(val: unknown, max = 120): string {
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

app.get('/', (c) => {
  const datasets = listDatasets();

  return c.render(
    <Layout title="Datasets">
      <div class="mb-6 space-y-4">
        <form
          method="post"
          action="/api/datasets"
          enctype="multipart/form-data"
          class="flex items-end gap-4"
        >
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Upload Dataset</legend>
            <input
              type="file"
              name="file"
              accept=".json,.jsonl,.csv"
              required
              class="file-input file-input-sm"
            />
          </fieldset>
          <button type="submit" class="btn btn-neutral btn-sm">
            Upload
          </button>
        </form>

        <form
          method="post"
          action="/api/datasets/hf"
          class="flex items-end gap-4"
        >
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Add from HuggingFace</legend>
            <input
              type="text"
              name="dataset"
              required
              placeholder="e.g. squad, glue"
              class="input input-sm w-full"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Config</legend>
            <input
              type="text"
              name="config"
              value="default"
              class="input input-sm w-32"
            />
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Split</legend>
            <input
              type="text"
              name="split"
              value="train"
              class="input input-sm w-24"
            />
          </fieldset>
          <button type="submit" class="btn btn-neutral btn-sm">
            Add
          </button>
        </form>
      </div>

      {datasets.length === 0 ? (
        <div class="rounded-lg border-2 border-dashed border-base-content/20 p-12 text-center">
          <p class="text-sm text-base-content/60">No datasets uploaded yet.</p>
        </div>
      ) : (
        <div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
          <table class="table table-zebra table-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((ds) => {
                const hfRef = isHfDataset(ds.name) ? readHfConfig(ds.name) : null;
                return (
                  <tr>
                    <td class="font-medium">
                      <a
                        href={`/datasets/${encodeURIComponent(ds.name)}`}
                        class="link link-primary"
                      >
                        {displayName(ds.name, hfRef)}
                      </a>
                    </td>
                    <td class="text-base-content/60">
                      {hfRef ? (
                        <span class="badge badge-warning badge-sm">HuggingFace</span>
                      ) : (
                        ds.extension
                      )}
                    </td>
                    <td class="text-base-content/60">
                      {hfRef ? '—' : formatSize(ds.sizeBytes)}
                    </td>
                    <td class="text-right">
                      <form
                        method="post"
                        action={`/api/datasets/${encodeURIComponent(ds.name)}/delete`}
                        class="inline"
                      >
                        <button type="submit" class="btn btn-ghost btn-xs text-error">
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {raw(`<script>
document.addEventListener('submit', function(e) {
  var btn = e.target.querySelector('button[type="submit"]');
  if (btn) {
    btn.disabled = true;
    var spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-sm';
    btn.prepend(spinner);
  }
});
</script>`)}
    </Layout>,
  );
});

app.get('/:name', async (c) => {
  const name = c.req.param('name');
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const limit = 50;

  const allDatasets = listDatasets();
  const current = allDatasets.find((d) => d.name === name);
  if (!current) {
    return c.text('Dataset not found', 404);
  }

  const hfRef = isHfDataset(name) ? readHfConfig(name) : null;

  let rows: Record<string, unknown>[];
  let total: number;
  try {
    if (hfRef) {
      const result = await fetchHfRows(hfRef, offset, limit);
      rows = result.rows;
      total = result.total;
    } else {
      const allRows = await dataset<Record<string, unknown>>(datasetPath(name)).toArray();
      total = allRows.length;
      rows = allRows.slice(offset, offset + limit);
    }
  } catch (err) {
    return c.text(
      err instanceof Error ? err.message : 'Failed to read dataset',
      400,
    );
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  const subtitle = hfRef
    ? `HuggingFace \u00b7 ${hfRef.dataset} \u00b7 ${hfRef.config}/${hfRef.split} \u00b7 ${total} rows`
    : `${current.extension} \u00b7 ${formatSize(current.sizeBytes)} \u00b7 ${total} rows`;

  const switcherScript = raw(`<script>
document.getElementById('ds-switcher').addEventListener('change', function() {
  location.href = '/datasets/' + encodeURIComponent(this.value);
});
</script>`);

  return c.render(
    <Layout>
      <div class="mb-6 flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold">
            {displayName(name, hfRef)}
          </h1>
          <p class="mt-1 text-sm text-base-content/60">{subtitle}</p>
        </div>
        <div class="flex items-center gap-3">
          <select id="ds-switcher" class="select select-sm">
            {allDatasets.map((ds) => (
              <option value={ds.name} selected={ds.name === name}>
                {ds.name}
              </option>
            ))}
          </select>
          <div class="breadcrumbs text-sm">
            <ul>
              <li><a href="/datasets">Datasets</a></li>
              <li>{displayName(name, hfRef)}</li>
            </ul>
          </div>
        </div>
      </div>

      {total === 0 ? (
        <div class="rounded-lg border-2 border-dashed border-base-content/20 p-12 text-center">
          <p class="text-sm text-base-content/60">This dataset is empty.</p>
        </div>
      ) : (
        <div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
          <table class="table table-zebra table-pin-rows table-sm">
            <thead>
              <tr>
                <th>#</th>
                {columns.map((col) => (
                  <th>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr>
                  <td class="text-base-content/40">{offset + i + 1}</td>
                  {columns.map((col) => (
                    <td
                      class="max-w-xs truncate"
                      title={
                        typeof row[col] === 'string'
                          ? (row[col] as string)
                          : JSON.stringify(row[col])
                      }
                    >
                      {truncate(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > limit && (
        <div class="mt-4 flex items-center justify-between text-sm">
          <span class="text-base-content/60">
            Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}{' '}
            rows
          </span>
          <div class="join">
            {hasPrev && (
              <a
                href={`/datasets/${encodeURIComponent(name)}?offset=${Math.max(0, offset - limit)}`}
                class="btn btn-outline btn-sm join-item"
              >
                Previous
              </a>
            )}
            {hasNext && (
              <a
                href={`/datasets/${encodeURIComponent(name)}?offset=${offset + limit}`}
                class="btn btn-outline btn-sm join-item"
              >
                Next
              </a>
            )}
          </div>
        </div>
      )}

      {switcherScript}
    </Layout>,
  );
});

export default app;
