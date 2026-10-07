import { parse as parseContentType } from 'fast-content-type-parse';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import z from 'zod';

import { parse } from './parse.ts';

type ContentType =
  | 'application/json'
  | 'application/x-www-form-urlencoded'
  | 'multipart/form-data'
  | 'text/plain';

type ValidatorConfig = Record<
  string,
  { select: unknown; against: z.ZodTypeAny }
>;

/** Each selected input's schema, under the input's name. */
type InputShape<T extends ValidatorConfig> = {
  [K in keyof T]: T[K]['against'];
};

type ExtractInput<T extends ValidatorConfig> = z.output<
  ReturnType<typeof inputSchema<T>>
>;

/** The parsed request parts a selector picks its inputs from. */
interface RequestPayload {
  body: unknown;
  query: Record<string, string | null | undefined>;
  queries: Record<string, (string | null)[]>;
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
}

type SelectorFn<T> = (payload: RequestPayload) => T;
type ValidateMiddleware<T extends ValidatorConfig> = MiddlewareHandler<{
  Variables: {
    input: ExtractInput<T>;
  };
}>;

function inputSchema<T extends ValidatorConfig>(config: T) {
  const shape = Object.fromEntries(
    Object.entries(config).map(([key, { against }]) => [key, against]),
  );
  assertInputShape(shape, config);
  return z.object(shape);
}

function assertInputShape<T extends ValidatorConfig>(
  shape: Record<string, z.ZodTypeAny>,
  config: T,
): asserts shape is InputShape<T> {
  const keys = Object.keys(config);
  if (
    Object.keys(shape).length !== keys.length ||
    keys.some((key) => shape[key] !== config[key]?.against)
  ) {
    throw new Error('The input schema does not match its selectors');
  }
}

export function validate<T extends ValidatorConfig>(
  selector: SelectorFn<T>,
): ValidateMiddleware<T>;
export function validate<T extends ValidatorConfig>(
  expectedContentTypeOrSelector: ContentType,
  selector: SelectorFn<T>,
): ValidateMiddleware<T>;
export function validate<T extends ValidatorConfig>(
  expectedContentTypeOrSelector: ContentType | SelectorFn<T>,
  selector?: SelectorFn<T>,
): ValidateMiddleware<T> {
  const expectedContentType =
    typeof expectedContentTypeOrSelector === 'string'
      ? expectedContentTypeOrSelector
      : undefined;
  const _selector =
    typeof expectedContentTypeOrSelector === 'function'
      ? expectedContentTypeOrSelector
      : selector;
  void _selector;
  if (!_selector) {
    throw new Error('Selector function is required');
  }

  return createMiddleware(async (c, next) => {
    const ct = c.req.header('content-type');
    if (c.req.method === 'GET' && ct) {
      throw new HTTPException(415, {
        message: 'Unsupported Media Type',
        cause: {
          code: 'api/unsupported-media-type',
          detail: `GET requests cannot have a content type header`,
        },
      });
    }
    if (expectedContentType) {
      void verifyContentType(ct, expectedContentType);
    }

    const contentType = ct ? parseContentType(ct) : null;
    let body: unknown = null;

    switch (contentType?.type) {
      case 'application/json':
        body = await parseJson(c);
        break;
      case 'application/x-www-form-urlencoded':
      case 'multipart/form-data':
        body = await c.req.parseBody();
        break;
      default:
        body = {};
    }

    const payload: RequestPayload = {
      body,
      query: parseQueryParams(c.req.query()),
      queries: parseQueriesParams(c.req.queries()),
      params: c.req.param(),
      headers: c.req.header(),
    };

    const config = _selector(payload);
    const input = Object.fromEntries(
      Object.entries(config).map(([key, { select }]) => [key, select]),
    );
    c.set('input', await parse(inputSchema(config), input));
    await next();
  });
}

export const openapi = validate;

export const consume = (contentType: ContentType) => {
  return createMiddleware(async (context, next) => {
    verifyContentType(context.req.header('content-type'), contentType);
    await next();
  });
};

export function verifyContentType(
  actual: string | undefined,
  expected: ContentType,
): asserts actual is ContentType {
  if (!actual) {
    throw new HTTPException(415, {
      message: 'Unsupported Media Type',
      cause: {
        code: 'api/unsupported-media-type',
        detail: 'Missing content type header',
      },
    });
  }
  const { type: incomingContentType } = parseContentType(actual);
  if (incomingContentType !== expected) {
    throw new HTTPException(415, {
      message: 'Unsupported Media Type',
      cause: {
        code: 'api/unsupported-media-type',
        detail: `Expected content type: ${expected}, but got: ${incomingContentType}`,
      },
    });
  }
}

async function parseJson(context: Context) {
  try {
    return await context.req.json();
  } catch (error) {
    throw new HTTPException(400, {
      message: 'The request body is not valid JSON',
      cause: {
        code: 'api/invalid-json',
        detail: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function parseQueryParams(
  queryParams: Record<string, string | undefined>,
): Record<string, string | null | undefined> {
  return Object.fromEntries(
    Object.entries(queryParams).map(([key, value]) => [
      key,
      value === 'null' ? null : value,
    ]),
  );
}

function parseQueriesParams(
  queriesParams: Record<string, string[]>,
): Record<string, (string | null)[]> {
  return Object.fromEntries(
    Object.entries(queriesParams).map(([key, values]) => [
      key,
      values.map((value) => (value === 'null' ? null : value)),
    ]),
  );
}
