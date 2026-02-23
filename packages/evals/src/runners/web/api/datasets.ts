import { Hono } from 'hono';

import { fetchHfRows } from '../../../dataset/hf.ts';
import { dataset } from '../../../dataset/index.ts';
import {
  datasetPath,
  deleteDataset,
  isHfDataset,
  listDatasets,
  readHfConfig,
  saveDataset,
  saveHfDataset,
} from '../services/dataset-store.ts';

const app = new Hono();

app.get('/', (c) => {
  return c.json(listDatasets());
});

app.post('/', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || typeof file === 'string') {
    return c.text('No file uploaded', 400);
  }

  const name = file.name;
  const content = await file.arrayBuffer();
  try {
    saveDataset(name, content);
  } catch (err) {
    return c.text(err instanceof Error ? err.message : 'Upload failed', 400);
  }

  return c.redirect('/datasets');
});

app.post('/hf', async (c) => {
  const body = await c.req.parseBody();
  const ds = String(body['dataset'] ?? '').trim();
  const config = String(body['config'] ?? '').trim() || 'default';
  const split = String(body['split'] ?? '').trim() || 'train';

  if (!ds) {
    return c.text('Dataset name is required', 400);
  }

  try {
    saveHfDataset({ dataset: ds, config, split });
  } catch (err) {
    return c.text(err instanceof Error ? err.message : 'Failed to save', 400);
  }

  return c.redirect('/datasets');
});

app.get('/:name/rows', async (c) => {
  const name = c.req.param('name');
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));

  if (!listDatasets().find((d) => d.name === name)) {
    return c.text('Dataset not found', 404);
  }

  try {
    if (isHfDataset(name)) {
      const ref = readHfConfig(name)!;
      const result = await fetchHfRows(ref, offset, limit);
      const columns =
        result.rows.length > 0 ? Object.keys(result.rows[0]!) : [];
      return c.json({
        rows: result.rows,
        columns,
        total: result.total,
        offset,
        limit,
      });
    }

    const ds = dataset<Record<string, unknown>>(datasetPath(name));
    const allRows = await ds.toArray();
    const page = allRows.slice(offset, offset + limit);
    const columns = allRows.length > 0 ? Object.keys(allRows[0]!) : [];

    return c.json({
      rows: page,
      columns,
      total: allRows.length,
      offset,
      limit,
    });
  } catch (err) {
    return c.text(
      err instanceof Error ? err.message : 'Failed to read dataset',
      400,
    );
  }
});

app.post('/:name/delete', (c) => {
  const name = c.req.param('name');
  try {
    deleteDataset(name);
  } catch {
    return c.text('File not found', 404);
  }
  return c.redirect('/datasets');
});

export default app;
