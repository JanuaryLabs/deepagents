import { parse as parseContentType } from 'fast-content-type-parse';
import type { Context, MiddlewareHandler, ValidationTargets } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import z from 'zod';

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

type HasUndefined<T> = undefined extends T ? true : false;

type InferTarget<
  T extends ValidatorConfig,
  S,
  Target extends keyof ValidationTargets,
> = {
  [K in keyof T as T[K]['select'] extends S ? K : never]: HasUndefined<
    z.infer<T[K]['against']>
  > extends true
    ? z.infer<T[K]['against']> | undefined
    : z.infer<T[K]['against']> extends ValidationTargets[Target]
      ? z.infer<T[K]['against']>
      : z.infer<T[K]['against']>;
};

type InferIn<T extends ValidatorConfig> = (keyof InferTarget<
  T,
  QuerySelect | QueriesSelect,
  'query'
> extends never
  ? never
  : { query: InferTarget<T, QuerySelect | QueriesSelect, 'query'> }) &
  (keyof InferTarget<T, BodySelect, 'json'> extends never
    ? never
    : { json: InferTarget<T, BodySelect, 'json'> }) &
  (keyof InferTarget<T, ParamsSelect, 'param'> extends never
    ? never
    : { param: InferTarget<T, ParamsSelect, 'param'> }) &
  (keyof InferTarget<T, HeadersSelect, 'header'> extends never
    ? never
    : { header: InferTarget<T, HeadersSelect, 'header'> });

type RequestPart = 'body' | 'query' | 'queries' | 'params' | 'headers';

/**
 * Where one input is read from: the selector runs once against these markers,
 * and each request resolves them to the named part's value.
 */
abstract class Selection {
  abstract readonly part: RequestPart;
  readonly key: string;

  constructor(key: string) {
    this.key = key;
  }
}
class BodySelect extends Selection {
  readonly part = 'body';
}
class QuerySelect extends Selection {
  readonly part = 'query';
}
class QueriesSelect extends Selection {
  readonly part = 'queries';
}
class ParamsSelect extends Selection {
  readonly part = 'params';
}
class HeadersSelect extends Selection {
  readonly part = 'headers';
}

function selections<S extends Selection>(
  select: (key: string) => S,
): Record<string, S> {
  return new Proxy<Record<string, S>>(
    {},
    {
      get: (_target, key) =>
        typeof key === 'string' ? select(key) : undefined,
    },
  );
}

const markers = {
  body: selections((key) => new BodySelect(key)),
  query: selections((key) => new QuerySelect(key)),
  queries: selections((key) => new QueriesSelect(key)),
  params: selections((key) => new ParamsSelect(key)),
  headers: selections((key) => new HeadersSelect(key)),
};

function inputSchema<T extends ValidatorConfig>(config: T) {
  const shape = Object.fromEntries(
    Object.entries(config).map(([key, { against }]) => [key, against]),
  );
  assertShapeOf(shape, config);
  return z.object(shape);
}

function assertShapeOf<T extends ValidatorConfig>(
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

function read(select: unknown, request: Record<RequestPart, unknown>) {
  if (!(select instanceof Selection)) return select;
  const part = request[select.part];
  return isRecord(part) ? part[select.key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type SelectorFn<T> = (payload: {
  body: Record<string, BodySelect>;
  query: Record<string, QuerySelect>;
  queries: Record<string, QueriesSelect>;
  params: Record<string, ParamsSelect>;
  headers: Record<string, HeadersSelect>;
}) => T;
type ValidateMiddleware<T extends ValidatorConfig> = MiddlewareHandler<
  {
    Variables: {
      input: ExtractInput<T>;
    };
  },
  string,
  { in: InferIn<T> }
>;

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
  if (!_selector) {
    throw new Error('Selector function is required');
  }
  const config = _selector(markers);
  const schema = inputSchema(config);

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

    const request = {
      body,
      query: parseQueryParams(c.req.query()),
      queries: parseQueriesParams(c.req.queries()),
      params: c.req.param(),
      headers: Object.fromEntries(
        Object.entries(c.req.header()).map(([k, v]) => [k, v ?? '']),
      ),
    };
    const input = Object.fromEntries(
      Object.entries(config).map(([key, { select }]) => [
        key,
        read(select, request),
      ]),
    );

    c.set('input', await parse(schema, input));
    await next();
  });
}

export async function parse<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  input: unknown,
) {
  const result = await schema.safeParseAsync(input);
  if (!result.success) {
    // Declared as a plain record so the OpenAPI analyzer can describe it.
    const errors: Record<string, unknown> = result.error.flatten((issue) => ({
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
