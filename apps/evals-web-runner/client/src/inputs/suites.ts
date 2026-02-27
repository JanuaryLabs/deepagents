import { z } from 'zod';

export const listSuitesSchema = z.object({}).catchall(z.unknown());
export const getSuiteSchema = z.object({ id: z.string() });
export const renameSuiteSchema = z.object({
  name: z.string().optional(),
  id: z.string(),
});
