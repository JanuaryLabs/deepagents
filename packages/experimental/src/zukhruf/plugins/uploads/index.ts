import { type UIMessage, tool } from 'ai';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import z from 'zod';

import { reminder } from '@deepagents/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../../agent.ts';
import type {
  AgentPluginDefinition,
  AgentPluginHost,
  AgentPluginInstance,
  AgentPluginToolContext,
} from '../../runtime/agent-runtime.ts';

const extensionByMediaType = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
} as const;

export type UploadMediaType = keyof typeof extensionByMediaType;

export const UPLOAD_MEDIA_TYPES = Object.keys(
  extensionByMediaType,
) as readonly UploadMediaType[];

/** Every extension the store writes, plus the `jpeg` spelling it accepts on read. */
const mediaTypeByExtension: Readonly<Record<string, UploadMediaType>> = {
  ...Object.fromEntries(
    Object.entries(extensionByMediaType).map(([mediaType, extension]) => [
      extension,
      mediaType,
    ]),
  ),
  jpeg: 'image/jpeg',
};

/** `<uuid>.<ext>` is the only file name this store writes or reads. */
const UPLOAD_FILE_ID_PATTERN = new RegExp(
  `^[0-9a-f-]{36}\\.(${Object.keys(mediaTypeByExtension).join('|')})$`,
);

export interface UploadScope {
  userId: string;
  sessionId: string;
}

export interface StoredUpload {
  data: Uint8Array<ArrayBuffer>;
  mediaType: UploadMediaType;
}

export interface WrittenUpload {
  fileId: string;
  /** Absolute sandbox path of the stored file. */
  path: string;
}

export interface PublishRequest {
  /** Absolute sandbox path of a file below the session's uploads directory. */
  path: string;
  /** Display name for the user; defaults to the file's basename. */
  name?: string;
}

export interface PublishedUpload extends WrittenUpload {
  mediaType: UploadMediaType;
  name: string;
  /** `GET` route relative to the mounted `http()` app that serves the bytes. */
  href: string;
  /** Absolute URL when the plugin knows its public mount (`publicUrl`). */
  url?: string;
}

/** One entry of `message.metadata.uploads`: the upload receipt the composer sends back. */
interface AttachedUpload {
  path: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface UploadsOptions {
  /** Absolute sandbox directory that receives `<userId>/<sessionId>/<fileId>` files. */
  directory: string;
  /**
   * Absolute URL where the host mounts `http(runtime, uploadsHttp(...))`, for
   * example `http://127.0.0.1:4317/zukhruf/v1`. When set, `publish_upload`
   * returns an absolute `url` the model can hand to the user verbatim.
   */
  publicUrl?: string;
}

export interface Uploads extends AgentPluginInstance {
  /** Stores one file in the session's sandbox. */
  write(scope: UploadScope, upload: StoredUpload): Promise<WrittenUpload>;
  read(scope: UploadScope, fileId: string): Promise<StoredUpload | undefined>;
  /**
   * Adopts a file the agent wrote below the session's uploads directory: it
   * is renamed to a stable `<uuid>.<ext>` id so the `GET` route can serve it.
   */
  publish(
    scope: UploadScope,
    request: PublishRequest,
  ): Promise<PublishedUpload>;
}

export function isUploadMediaType(
  mediaType: string,
): mediaType is UploadMediaType {
  return Object.hasOwn(extensionByMediaType, mediaType);
}

/**
 * Keep composer uploads (images, video, audio) in the conversation sandbox,
 * tell the model where the files a turn attaches under
 * `message.metadata.uploads` live, and let any agent in the tree publish a
 * file it produced so the user can open or download it.
 */
export function uploads({
  directory,
  publicUrl,
}: UploadsOptions): AgentPluginDefinition<Uploads> {
  if (typeof directory !== 'string' || !posix.isAbsolute(directory)) {
    throw new Error(
      `uploads: directory must be an absolute sandbox path, received ${JSON.stringify(directory)}`,
    );
  }
  const resolvedPublicUrl = normalizePublicUrl(publicUrl);
  return {
    name: 'uploads',
    create: () => new UploadsPlugin(directory, resolvedPublicUrl),
  };
}

const publishInputSchema = z.object({
  path: z
    .string()
    .startsWith('/')
    .describe(
      "Absolute sandbox path of the file to publish; it must be inside this session's uploads directory (the directory the attached files live in, subdirectories included).",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Display name shown to the user; defaults to the file name.'),
});

class UploadsPlugin implements Uploads {
  readonly #directory: string;
  readonly #publicUrl: string | undefined;
  #host: AgentPluginHost | undefined;

  readonly tools = {
    publish_upload: tool<
      z.infer<typeof publishInputSchema>,
      PublishedUpload,
      AgentPluginToolContext
    >({
      description:
        "Publish a file you produced in the sandbox so the user can open or download it. The path must be inside this session's uploads directory; the file is renamed to a stable id and the returned url (or href relative to the API) is what the user opens.",
      inputSchema: publishInputSchema,
      execute: (input, { context }) =>
        this.publish(
          { userId: context.conversation.userId, sessionId: context.treeId },
          input,
        ),
    }),
  };

  constructor(directory: string, publicUrl: string | undefined) {
    this.#directory = directory;
    this.#publicUrl = publicUrl;
  }

  configure(root: AgentDeclaration): AgentDeclaration {
    return {
      ...root,
      instructions: [...root.instructions, this.#attachedUploadsReminder()],
    };
  }

  initialize(host: AgentPluginHost): Promise<void> {
    this.#host = host;
    return Promise.resolve();
  }

  async write(
    scope: UploadScope,
    { data, mediaType }: StoredUpload,
  ): Promise<WrittenUpload> {
    const fileId = `${randomUUID()}.${extensionByMediaType[mediaType]}`;
    const path = this.#pathFor(scope, fileId);
    const sandbox = await this.#sandboxFor(scope);
    await sandbox.sandbox.writeFiles([{ path, content: Buffer.from(data) }]);
    return { fileId, path };
  }

  async read(
    scope: UploadScope,
    fileId: string,
  ): Promise<StoredUpload | undefined> {
    return this.#readFrom(await this.#sandboxFor(scope), scope, fileId);
  }

  async publish(
    scope: UploadScope,
    { path, name }: PublishRequest,
  ): Promise<PublishedUpload> {
    const root = this.#scopeFor(scope);
    if (!isBelow(root, path)) {
      throw new Error(
        `publish_upload: ${path} is outside this session's uploads directory ${root}`,
      );
    }
    const extension = posix.extname(path).slice(1).toLowerCase();
    const mediaType = mediaTypeByExtension[extension];
    if (mediaType === undefined) {
      throw new Error(
        `publish_upload: unsupported file extension "${extension}"; publishable extensions are ${Object.keys(mediaTypeByExtension).join(', ')}`,
      );
    }
    const sandbox = await this.#sandboxFor(scope);
    if (!(await sandbox.sandbox.exists(path))) {
      throw new Error(`publish_upload: ${path} does not exist in the sandbox`);
    }
    const basename = posix.basename(path);
    const alreadyPublished =
      posix.dirname(path) === root && UPLOAD_FILE_ID_PATTERN.test(basename);
    const fileId = alreadyPublished
      ? basename
      : `${randomUUID()}.${extensionByMediaType[mediaType]}`;
    const target = this.#pathFor(scope, fileId);
    if (target !== path) {
      const moved = await sandbox.sandbox.executeCommand(
        `mv -- ${shellQuote(path)} ${shellQuote(target)}`,
      );
      if (moved.exitCode !== 0) {
        throw new Error(
          `publish_upload: could not move ${path}: ${moved.stderr.trim() || `exit ${moved.exitCode}`}`,
        );
      }
    }
    const href = `/session/${scope.sessionId}/uploads/${fileId}`;
    return {
      fileId,
      path: target,
      mediaType,
      name: name ?? basename,
      href,
      ...(this.#publicUrl === undefined
        ? {}
        : { url: `${this.#publicUrl}${href}` }),
    };
  }

  /**
   * Lists the turn's attachments for the model. The engine folds it into the
   * user message being saved and hands over that chat, so only files uploaded
   * for this chat by its owner are listed.
   */
  #attachedUploadsReminder() {
    return reminder(
      ({ currentMessage, chat }) => {
        if (currentMessage === undefined || chat === undefined) {
          throw new Error(
            'uploads: the user reminder context must carry currentMessage and chat',
          );
        }
        const scope = this.#scopeFor({
          userId: chat.userId,
          sessionId: chat.id,
        });
        const attached = attachedUploads(currentMessage).filter(({ path }) =>
          isBelow(scope, path),
        );
        if (attached.length === 0) return '';
        return [
          'The user attached the files listed below for this turn; read images by path with the readFile tool when needed (convert HEIC and extract video frames with sandbox commands first), and [Image #N], [Video #N], or [Audio #N] in the message refers to the Nth listed file.',
          ...attached.map(
            ({ path, name, mediaType, size }) =>
              `- ${path} (${name}, ${mediaType}, ${size} bytes)`,
          ),
        ].join('\n');
      },
      { asPart: true },
    );
  }

  #sandboxFor(scope: UploadScope): Promise<ZukhrufSandbox> {
    if (this.#host === undefined) {
      throw new Error(
        'uploads plugin must be initialized before storing or reading uploads',
      );
    }
    return this.#host.sandbox({
      chatId: scope.sessionId,
      userId: scope.userId,
    });
  }

  async #readFrom(
    sandbox: ZukhrufSandbox,
    scope: UploadScope,
    fileId: string,
  ): Promise<StoredUpload | undefined> {
    const extension = UPLOAD_FILE_ID_PATTERN.exec(fileId)?.[1];
    const mediaType =
      extension === undefined ? undefined : mediaTypeByExtension[extension];
    if (mediaType === undefined) return undefined;
    const path = this.#pathFor(scope, fileId);
    if (!(await sandbox.sandbox.exists(path))) return undefined;
    const bytes = await sandbox.sandbox.readFile(path, { encoding: 'binary' });
    return { data: new Uint8Array(bytes), mediaType };
  }

  /** `<directory>/<userId>/<sessionId>`; both identifiers must be one path segment. */
  #scopeFor({ userId, sessionId }: UploadScope): string {
    assertPathSegment('userId', userId);
    assertPathSegment('sessionId', sessionId);
    return posix.join(this.#directory, userId, sessionId);
  }

  #pathFor(scope: UploadScope, fileId: string): string {
    return posix.join(this.#scopeFor(scope), fileId);
  }
}

function normalizePublicUrl(publicUrl: string | undefined): string | undefined {
  if (publicUrl === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error(
      `uploads: publicUrl must be an absolute http(s) URL, received ${JSON.stringify(publicUrl)}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `uploads: publicUrl must be an absolute http(s) URL, received ${JSON.stringify(publicUrl)}`,
    );
  }
  return parsed.href.replace(/\/+$/, '');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertPathSegment(name: string, value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/')
  ) {
    throw new Error(
      `uploads: ${name} must be a single path segment, received "${value}"`,
    );
  }
}

function attachedUploads(message: UIMessage): AttachedUpload[] {
  if (!isRecord(message.metadata) || !Array.isArray(message.metadata.uploads)) {
    return [];
  }
  return message.metadata.uploads.filter(isAttachedUpload);
}

function isAttachedUpload(value: unknown): value is AttachedUpload {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.name === 'string' &&
    typeof value.mediaType === 'string' &&
    typeof value.size === 'number'
  );
}

/** `path` is already normalized (no `.`/`..` segments) and names something below `scope`. */
function isBelow(scope: string, path: string): boolean {
  return posix.normalize(path) === path && path.startsWith(`${scope}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
