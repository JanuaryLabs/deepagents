import { safeParse as parseContentType } from 'fast-content-type-parse';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import z from 'zod';

import type { AgentPluginDefinition } from '../../runtime/agent-runtime.ts';
import {
  type HttpEnv,
  type HttpProjection,
  mountPath,
  projectHttp,
} from '../http/index.ts';
import { validate } from '../http/validator.ts';
import {
  UPLOAD_MEDIA_TYPES,
  type UploadMediaType,
  type Uploads,
  isUploadMediaType,
} from './index.ts';

export const UPLOAD_FILENAME_HEADER = 'x-upload-filename';

const SESSION_UPLOADS_ROUTE_PATH = '/session/:sessionId/uploads';
const SESSION_UPLOAD_ROUTE_PATH = `${SESSION_UPLOADS_ROUTE_PATH}/:fileId`;
const NO_STORE = { 'cache-control': 'no-store' } as const;
const IMMUTABLE = {
  'cache-control': 'private, max-age=31536000, immutable',
} as const;
const sessionIdSchema = z.uuid();
const uploadFilenameSchema = z
  .string()
  .min(1)
  .transform((encoded, context) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      context.addIssue({
        code: 'custom',
        message: `${UPLOAD_FILENAME_HEADER} must be URI-encoded`,
      });
      return z.NEVER;
    }
  });

/**
 * What `POST /session/:sessionId/uploads` answers. The composer keeps it and
 * sends it back under `message.metadata.uploads` on the turn that attaches it.
 */
export interface UploadReceipt {
  /** Absolute sandbox path the model reads with the sandbox read tool. */
  path: string;
  /** Client file name from the `x-upload-filename` header. */
  name: string;
  mediaType: UploadMediaType;
  /** Byte length of the stored file. */
  size: number;
  /** `GET` route serving the bytes for rendering. */
  url: string;
}

/**
 * Per-session upload and retrieval bound to one `uploads()` definition.
 * The caller must choose the maximum accepted upload size in bytes.
 */
export function uploadsHttp(
  definition: AgentPluginDefinition<Uploads>,
  { maxBytes }: { maxBytes: number },
): HttpProjection {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(
      'uploadsHttp: maxBytes must be a positive safe integer',
    );
  }
  return projectHttp(definition, (plugin) => ({
    capabilities: {
      uploads: { path: '/session', mediaTypes: UPLOAD_MEDIA_TYPES },
    },
    authenticatedRoutes: uploadRoutes(plugin, maxBytes),
  }));
}

function uploadRoutes(uploads: Uploads, maxBytes: number) {
  const app = new Hono<HttpEnv>();
  app.post(
    SESSION_UPLOADS_ROUTE_PATH,
    bodyLimit({
      maxSize: maxBytes,
      onError: () => {
        throw new HTTPException(413, {
          message: 'Upload is too large',
          cause: {
            code: 'api/payload-too-large',
            detail: `Upload exceeds ${maxBytes} bytes`,
          },
        });
      },
    }),
    validate((payload) => ({
      sessionId: {
        select: payload.params.sessionId,
        against: sessionIdSchema,
      },
      name: {
        select: payload.headers[UPLOAD_FILENAME_HEADER],
        against: uploadFilenameSchema,
      },
    })),
    async (context) => {
      const { sessionId, name } = context.var.input;
      const contentType = context.req.header('content-type');
      const mediaType =
        contentType === undefined
          ? undefined
          : parseContentType(contentType).type;
      if (mediaType === undefined || !isUploadMediaType(mediaType)) {
        throw new HTTPException(415, {
          message: 'Unsupported Media Type',
          cause: {
            code: 'zukhruf/unsupported-media-type',
            detail: `Uploads must be one of ${UPLOAD_MEDIA_TYPES.join(', ')}`,
          },
        });
      }
      const data = new Uint8Array(await context.req.arrayBuffer());
      const { fileId, path } = await uploads.write(
        { userId: context.get('userId'), sessionId },
        { data, mediaType },
      );
      const url = new URL(
        `${mountPath(context)}/session/${sessionId}/uploads/${fileId}`,
        context.req.url,
      ).href;
      return context.json(
        {
          path,
          name,
          mediaType,
          size: data.byteLength,
          url,
        } satisfies UploadReceipt,
        201,
        NO_STORE,
      );
    },
  );
  app.all(SESSION_UPLOADS_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'POST'),
  );

  app.on(
    ['GET', 'HEAD'],
    SESSION_UPLOAD_ROUTE_PATH,
    validate((payload) => ({
      sessionId: {
        select: payload.params.sessionId,
        against: sessionIdSchema,
      },
    })),
    async (context) => {
      const { sessionId } = context.var.input;
      const fileId = context.req.param('fileId');
      const upload = await uploads.read(
        { userId: context.get('userId'), sessionId },
        fileId,
      );
      if (!upload) {
        throw new HTTPException(404, {
          message: 'Upload not found',
          cause: {
            code: 'zukhruf/upload-not-found',
            detail: `Upload ${fileId} does not exist in session ${sessionId}`,
          },
        });
      }
      // Byte ranges let <video>/<audio> seek and let Safari play at all; the
      // whole file is already in memory, so a range is a plain subarray.
      const total = upload.data.byteLength;
      const headers = {
        'content-type': upload.mediaType,
        'accept-ranges': 'bytes',
        ...IMMUTABLE,
      };
      const rangeHeader = context.req.header('range');
      const head = context.req.method === 'HEAD';
      if (rangeHeader === undefined) {
        const full = { ...headers, 'content-length': String(total) };
        return head
          ? context.body(null, 200, full)
          : context.body(upload.data, 200, full);
      }
      const range = parseByteRange(rangeHeader, total);
      if (range === undefined) {
        return context.body(null, 416, {
          ...headers,
          'content-range': `bytes */${total}`,
        });
      }
      const partial = {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${total}`,
        'content-length': String(range.end - range.start + 1),
      };
      return head
        ? context.body(null, 206, partial)
        : context.body(
            upload.data.subarray(range.start, range.end + 1),
            206,
            partial,
          );
    },
  );
  app.all(SESSION_UPLOAD_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'GET, HEAD'),
  );

  return app;
}

/**
 * One `bytes=` range (RFC 9110 §14.1.2): `a-b`, `a-`, or `-n`; `undefined`
 * when the header is malformed, multi-range, or unsatisfiable.
 */
function parseByteRange(
  header: string,
  total: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || total === 0) return undefined;
  const [, first, last] = match;
  if (first === '' && last === '') return undefined;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0) return undefined;
    return { start: Math.max(total - suffix, 0), end: total - 1 };
  }
  const start = Number(first);
  const end = last === '' ? total - 1 : Math.min(Number(last), total - 1);
  if (start > end || start >= total) return undefined;
  return { start, end };
}

function methodNotAllowed(
  context: { header(name: string, value: string): void },
  allow: string,
): never {
  context.header('Allow', allow);
  throw new HTTPException(405, {
    message: 'Method not allowed',
    cause: {
      code: 'api/method-not-allowed',
      detail: `This endpoint only accepts ${allow} requests`,
    },
  });
}
