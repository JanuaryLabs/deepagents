import { z } from 'zod';

export const listCompletedRunsSchema = z.object({}).catchall(z.unknown());
export const compareRunsSchema = z.object({
  baseline: z.string(),
  candidate: z.string(),
});
