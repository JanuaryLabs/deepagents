import z from 'zod';

import { stringBoolean } from './core/inputs.ts';
import { parse } from './middlewares/validator.ts';

const env = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  DEBUG_HTTP_ERRORS: stringBoolean,
  PORT: z.string().optional().default('3000'),
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  BASE_PATH: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value && value !== '/' ? value : '';
      return normalized ? `${normalized}/` : '/';
    }),
  EVALS_DB_PATH: z.string().optional().default('.evals/store.db'),
});

try {
  const data = await parse(env, process.env);
  process.env = Object.assign({}, process.env, data);
} catch (error) {
  console.error(
    'Please check that all required environment variables are correctly set.',
  );
  console.dir(error, { depth: null });
  process.exit(1);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    // Extend the ProcessEnv interface with the parsed environment variables
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-empty-interface
    interface ProcessEnv extends z.infer<typeof env> {}
  }
}
