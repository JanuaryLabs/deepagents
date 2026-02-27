import { z } from 'zod';

export const listDatasetsSchema = z.object({}).catchall(z.unknown());
export const uploadDatasetSchema = z.object({ file: z.instanceof(Blob) });
export const importHfDatasetSchema = z.object({
  config: z.string().default('default'),
  dataset: z.string(),
  split: z.string().default('train'),
});
export const getDatasetRowsSchema = z.object({
  name: z.string(),
  offset: z.number().min(0).optional().default(0),
  limit: z.number().min(1).max(200).optional().default(50),
});
export const deleteDatasetSchema = z.object({ name: z.string() });
