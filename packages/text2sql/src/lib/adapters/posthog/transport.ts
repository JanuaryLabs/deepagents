import type {
  CreatePostHogTransportOptions,
  PostHogEventDefinition,
  PostHogPropertyDefinition,
  PostHogPropertyDefinitionType,
  PostHogQueryRequest,
  PostHogTransport,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 45_000;
const PAGE_SIZE = 100;

export class PostHogApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
  readonly retryAfterMs?: number;

  constructor(options: {
    status: number;
    message: string;
    code?: string;
    detail?: string;
    retryAfterMs?: number;
  }) {
    super(options.message);
    this.name = 'PostHogApiError';
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function createPostHogTransport(
  options: CreatePostHogTransportOptions,
): PostHogTransport {
  const origin = parseOrigin(options.host);
  const projectId = String(options.projectId ?? '').trim();
  if (!projectId) throw new Error('PostHog transport requires a projectId.');
  if (typeof options.getAccessToken !== 'function') {
    throw new Error('PostHog transport requires getAccessToken().');
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('PostHog transport requires a fetch implementation.');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('PostHog transport timeoutMs must be a positive integer.');
  }

  const projectPath = `/api/projects/${encodeURIComponent(projectId)}`;

  const requestJson = async (
    path: string,
    init: Omit<RequestInit, 'headers' | 'redirect' | 'signal'> = {},
  ): Promise<unknown> => {
    const token = String(await options.getAccessToken()).trim();
    if (!token) throw new Error('PostHog getAccessToken() returned no token.');

    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, origin), {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        redirect: 'error',
        signal,
      });
    } catch {
      if (signal.aborted) {
        throw new Error(`PostHog request timed out after ${timeoutMs}ms.`);
      }
      throw new Error('PostHog request failed before receiving a response.');
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      if (signal.aborted) {
        throw new Error(`PostHog request timed out after ${timeoutMs}ms.`);
      }
      throw new Error('PostHog response body could not be read.');
    }
    const parsed = parseJson(body);
    if (!response.ok) {
      throw apiError(response, parsed, token);
    }
    if (parsed === undefined) {
      throw new Error('PostHog returned an empty or non-JSON response.');
    }
    return parsed;
  };

  const listDefinitions = async <T>(
    resource: 'event_definitions' | 'property_definitions',
    parameters: URLSearchParams,
  ): Promise<T[]> => {
    const definitions: T[] = [];
    let offset = 0;

    for (;;) {
      const pageParameters = new URLSearchParams(parameters);
      pageParameters.set('limit', String(PAGE_SIZE));
      pageParameters.set('offset', String(offset));
      const page = asRecord(
        await requestJson(
          `${projectPath}/${resource}/?${pageParameters.toString()}`,
        ),
        `PostHog ${resource} response`,
      );
      if (!Array.isArray(page.results)) {
        throw new Error(`PostHog ${resource} response has no results array.`);
      }
      if (page.next !== null && typeof page.next !== 'string') {
        throw new Error(
          `PostHog ${resource} response has an invalid next page.`,
        );
      }

      definitions.push(...(page.results as T[]));
      if (page.next === null) return definitions;
      if (page.results.length === 0) {
        throw new Error(
          `PostHog ${resource} returned an empty non-final page.`,
        );
      }
      offset += page.results.length;
    }
  };

  return {
    async query<T>(request: PostHogQueryRequest): Promise<T> {
      return (await requestJson(`${projectPath}/query/`, {
        method: 'POST',
        body: JSON.stringify(request),
      })) as T;
    },

    listEventDefinitions(): Promise<PostHogEventDefinition[]> {
      return listDefinitions(
        'event_definitions',
        new URLSearchParams({
          exclude_hidden: 'true',
          exclude_stale: 'true',
        }),
      );
    },

    listPropertyDefinitions({
      type,
      groupTypeIndex,
    }: {
      type: PostHogPropertyDefinitionType;
      groupTypeIndex?: number;
    }): Promise<PostHogPropertyDefinition[]> {
      if (
        type === 'group' &&
        (groupTypeIndex === undefined ||
          !Number.isInteger(groupTypeIndex) ||
          groupTypeIndex < 0)
      ) {
        throw new Error(
          'PostHog group property definitions require a non-negative integer groupTypeIndex.',
        );
      }
      const parameters = new URLSearchParams({
        type,
        exclude_hidden: 'true',
        exclude_restricted: 'true',
      });
      if (type === 'group') {
        parameters.set('group_type_index', String(groupTypeIndex));
      }
      return listDefinitions('property_definitions', parameters);
    },
  };
}

function parseOrigin(host: string): URL {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error('PostHog host must be an absolute URL.');
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(
      'PostHog host must use HTTPS except for loopback development hosts.',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'PostHog host must be an origin without credentials or query data.',
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('PostHog host must not include a path.');
  }
  url.pathname = '/';
  return url;
}

function parseJson(body: string): unknown | undefined {
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function apiError(
  response: Response,
  body: unknown,
  accessToken: string,
): PostHogApiError {
  const record = isRecord(body) ? body : undefined;
  const detail = redact(
    readString(record?.detail) ?? readString(record?.error),
    accessToken,
  );
  const code = redact(readString(record?.code), accessToken);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  return new PostHogApiError({
    status: response.status,
    message: detail
      ? `PostHog API returned ${response.status}: ${detail}`
      : `PostHog API returned HTTP ${response.status}.`,
    code,
    detail,
    retryAfterMs,
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1_000 : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function redact(value: string | undefined, secret: string): string | undefined {
  return value?.replaceAll(secret, '[REDACTED]');
}
