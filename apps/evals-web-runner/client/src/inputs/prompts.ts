import { z } from 'zod';

export const listPromptsSchema = z.object({}).catchall(z.unknown());
export const createPromptSchema = z.object({
  content: z.string(),
  name: z.string(),
});
export const getPromptSchema = z.object({ id: z.string() });
export const deletePromptSchema = z.object({ id: z.string() });
