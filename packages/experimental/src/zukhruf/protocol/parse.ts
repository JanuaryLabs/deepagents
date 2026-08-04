import { HTTPException } from 'hono/http-exception';
import z from 'zod';

interface ValidationIssue {
  message: string;
  code: string;
  path: string;
}

export async function parse<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  input: unknown,
) {
  const result = await schema.safeParseAsync(input);
  if (!result.success) {
    const errors: z.inferFlattenedErrors<
      z.ZodObject<T>,
      ValidationIssue
    >['fieldErrors'] = result.error.flatten((issue) => ({
      message: issue.message,
      code: issue.code,
      path: issue.path.join('.'),
    })).fieldErrors;

    throw new HTTPException(400, {
      message: 'Validation failed',
      cause: {
        code: 'api/validation-failed',
        detail: 'The input data is invalid',
        errors,
      },
    });
  }
  return result.data;
}
