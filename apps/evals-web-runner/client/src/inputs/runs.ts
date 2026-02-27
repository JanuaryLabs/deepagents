import { z } from 'zod';

export const streamRunEventsSchema = z.object({ id: z.string() });
export const listRunsSchema = z.object({}).catchall(z.unknown());
export const createRunSchema = z.object({
  batchSize: z.number().gt(0).optional(),
  dataset: z.string(),
  endpointUrl: z.string().url().optional(),
  maxConcurrency: z.number().gt(0).default(10),
  models: z.array(z.string()),
  name: z.string(),
  promptId: z.string().optional(),
  recordSelection: z.string().optional(),
  scorerModel: z.string().optional(),
  scorers: z.array(z.string()),
  taskMode: z.enum(['prompt', 'http']).default('prompt'),
  threshold: z.number().min(0).max(1).default(0.5),
  timeout: z.number().gt(0).default(30000),
  trials: z.number().gt(0).default(1),
});
export const getRunSchema = z.object({ id: z.string() });
export const renameRunSchema = z.object({
  name: z.string().optional(),
  id: z.string(),
});
