import { z } from 'zod';

export const listModelsSchema = z.object({}).catchall(z.unknown());
