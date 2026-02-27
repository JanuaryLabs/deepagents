import z from 'zod';

// ---

// This file holds single complex zod schemas that can be better represented semantically
// for input validation and not complete schemas for models.

// ---

// AI Provider types - accepts any lowercase alphanumeric provider ID
export const aiProviderSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9-]+$/,
    'Provider must be lowercase alphanumeric with hyphens',
  );

export const intLikeSchema = z.coerce.number().int().positive();

export const pageNumberSchema = z.coerce
  .number()
  .int()
  .positive()
  .default(1)
  .nullish()
  .transform((value) => (value === null || value === undefined ? 1 : value))
  .describe(
    'Page number for pagination (starts at 1). Use with limit parameter to control result set size.',
  );

export const pageSizeSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(50)
  .nullish()
  .transform((value) => (value === null || value === undefined ? 50 : value))
  .describe(
    'Number of results per page. Recommended: use smaller limits (10-50) for initial filtering, then get detailed profiles individually.',
  );

/**
 * A schema for validating search queries with flexible requirements based on content.
 *
 * You want to use this with search query parameters that may contain IDs, phone numbers, or text.
 *
 * Rules:
 * - If the query starts with a digit, any length is accepted (for IDs, phone numbers)
 * - If the query is text, minimum 3 characters required
 * - Empty or whitespace-only input returns undefined
 * - Maximum length is 100 characters for all inputs
 *
 * @example
 * searchQuerySchema.parse('1') // '1' (numeric, any length OK)
 * searchQuerySchema.parse('123') // '123'
 * searchQuerySchema.parse('966501234567') // '966501234567' (phone number)
 * searchQuerySchema.parse('abc') // 'abc' (text, minimum 3 chars)
 * searchQuerySchema.parse('hello world') // 'hello world'
 * searchQuerySchema.parse('  test  ') // 'test' (trimmed)
 * searchQuerySchema.parse('ab') // throws error (less than 3 chars)
 * searchQuerySchema.parse('a') // throws error (less than 3 chars)
 * searchQuerySchema.parse('') // undefined
 * searchQuerySchema.parse('   ') // undefined (whitespace only)
 * searchQuerySchema.parse(undefined) // undefined
 */
export const searchQuerySchema = z
  .union([
    // Numeric-start query: any length
    z.string().trim().max(100).regex(/^\d/),
    // Text query: minimum 3 characters
    z.string().trim().min(3).max(100),
    // Empty after trim -> undefined
    z
      .string()
      .trim()
      .max(0)
      .transform(() => undefined),
  ])
  .optional();

/**
 * A schema that converts a truthy string and boolean true to true, and anything else to false.
 *
 * You want to use this with query parameters that are boolean in nature.
 * @example
 * stringBoolean.parse('true') // true
 * stringBoolean.parse('TRUE') // true
 * stringBoolean.parse('false') // false
 * stringBoolean.parse('FALSE') // false
 * stringBoolean.parse('anything else') // false
 * stringBoolean.parse(undefined) // false
 * stringBoolean.parse(null) // false
 * stringBoolean.parse('null') // false
 * stringBoolean.parse('undefined') // false
 * stringBoolean.parse('0') // false
 * stringBoolean.parse('1') // false
 * stringBoolean.parse('') // false
 * stringBoolean.parse(' ') // false
 */
export const stringBoolean = z.coerce
  .string()
  .or(z.coerce.boolean())
  .nullish()
  .transform((value) => {
    // Handle null and undefined
    if (value === null || value === undefined) {
      return false;
    }

    // Handle strings - only 'true' and 'TRUE' should return true
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }

    // Everything else returns false
    return false;
  });

export const commaSeparatedSchema = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return undefined;
    return value
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean);
  })
  .describe(
    'Comma-separated list of fields to return. Omit to return all fields.',
  );

export const atLeastCharSchema = z.string().min(1).trim();

export const nameSchema = z.string().min(1).trim();

export const modelStringSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\s/]+\/[^\s/].+$/, 'Expected "provider/model-id" format');

export const modelListSchema = z.array(modelStringSchema).min(1);

export const offsetSchema = z.coerce
  .number()
  .int()
  .min(0)
  .default(0)
  .nullish()
  .transform((value) => (value === null || value === undefined ? 0 : value));

export const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(200)
  .default(50)
  .nullish()
  .transform((value) => (value === null || value === undefined ? 50 : value));

export const sortOrderSchema = z
  .enum(['asc', 'desc'])
  .optional()
  .default('desc')
  .describe(
    'Sort order: ascending (asc) or descending (desc). Defaults to desc.',
  );
