import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { dataset, fetchHfRows } from '@deepagents/evals/dataset';

import * as inputs from '../core/inputs.ts';
import { validate } from '../middlewares/validator.ts';
import {
  datasetPath,
  deleteDataset,
  isHfDataset,
  listDatasets,
  readHfConfig,
  saveDataset,
  saveHfDataset,
} from '../services/dataset-store.ts';
import type { AppBindings } from '../store.ts';

export default function (router: Hono<AppBindings>) {
  /**
   * @openapi listDatasets
   * @tags datasets
   * @description List all available datasets
   */
  router.get(
    '/datasets',
    validate(() => ({})),
    (c) => {
      return c.json(listDatasets());
    },
  );

  /**
   * @openapi uploadDataset
   * @tags datasets
   * @description Upload a dataset file (JSON, JSONL, or CSV)
   */
  router.post(
    '/datasets',
    validate('multipart/form-data', (payload) => ({
      file: { select: payload.body.file, against: z.instanceof(File) },
    })),
    async (c) => {
      const { file } = c.var.input;
      const content = await file.arrayBuffer();
      try {
        saveDataset(file.name, content);
      } catch (err) {
        throw new HTTPException(400, {
          message: err instanceof Error ? err.message : 'Upload failed',
        });
      }

      return c.json({ success: true }, 201);
    },
  );

  /**
   * @openapi importHfDataset
   * @tags datasets
   * @description Import a dataset from HuggingFace
   */
  router.post(
    '/datasets/import-hf',
    validate((payload) => ({
      dataset: {
        select: payload.body.dataset,
        against: z.string().min(1).trim(),
      },
      config: {
        select: payload.body.config,
        against: z.string().trim().default('default'),
      },
      split: {
        select: payload.body.split,
        against: z.string().trim().default('train'),
      },
    })),
    (c) => {
      const { dataset: ds, config, split } = c.var.input;

      try {
        const filename = saveHfDataset({ dataset: ds, config, split });
        return c.json({ success: true, filename }, 201);
      } catch (err) {
        throw new HTTPException(400, {
          message: err instanceof Error ? err.message : 'Failed to save',
        });
      }
    },
  );

  /**
   * @openapi getDatasetRows
   * @tags datasets
   * @description Get paginated rows from a dataset
   */
  router.get(
    '/datasets/:name/rows',
    validate((payload) => ({
      name: { select: payload.params.name, against: z.string() },
      offset: { select: payload.query.offset, against: inputs.offsetSchema },
      limit: { select: payload.query.limit, against: inputs.limitSchema },
    })),
    async (c) => {
      const { name, offset, limit } = c.var.input;

      try {
        if (isHfDataset(name)) {
          const ref = readHfConfig(name);
          if (!ref) {
            throw new HTTPException(404, { message: 'Dataset not found' });
          }
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
        if (err instanceof HTTPException) throw err;
        throw new HTTPException(404, {
          message: err instanceof Error ? err.message : 'Dataset not found',
        });
      }
    },
  );

  /**
   * @openapi deleteDataset
   * @tags datasets
   * @description Delete a dataset by name
   */
  router.delete(
    '/datasets/:name',
    validate((payload) => ({
      name: { select: payload.params.name, against: z.string() },
    })),
    (c) => {
      const { name } = c.var.input;
      try {
        deleteDataset(name);
      } catch (err) {
        throw new HTTPException(404, {
          message: err instanceof Error ? err.message : 'Dataset not found',
        });
      }
      return c.body(null, 204);
    },
  );
}
