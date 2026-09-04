import type { UIMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import { reminder } from '@deepagents/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../../agent.ts';
import type {
  AgentPluginDefinition,
  AgentPluginHost,
  AgentPluginInstance,
} from '../../runtime/agent-runtime.ts';

const extensionByMediaType = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const;

const mediaTypeByExtension: Record<string, UploadMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export type UploadMediaType = keyof typeof extensionByMediaType;

export const UPLOAD_MEDIA_TYPES = Object.keys(
  extensionByMediaType,
) as readonly UploadMediaType[];

/** `<uuid>.<ext>` is the only file name this store writes or reads. */
export const UPLOAD_FILE_ID_PATTERN = /^[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/;

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

/** One entry of `message.metadata.uploads`: the upload receipt the composer sends back. */
interface AttachedUpload {
  path: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface UploadsOptions {
  /** Absolute sandbox directory that receives `<userId>/<sessionId>/<fileId>` image files. */
  directory: string;
}

export interface Uploads extends AgentPluginInstance {
  /** Stores one image in the session's sandbox. */
  write(scope: UploadScope, upload: StoredUpload): Promise<WrittenUpload>;
  read(scope: UploadScope, fileId: string): Promise<StoredUpload | undefined>;
}

export function isUploadMediaType(
  mediaType: string,
): mediaType is UploadMediaType {
  return Object.hasOwn(extensionByMediaType, mediaType);
}

/**
 * Keep composer image uploads in the conversation sandbox and tell the model
 * where the files a turn attaches under `message.metadata.uploads` live, so it
 * reads them by path with the sandbox read tool.
 */
export function uploads({
  directory,
}: UploadsOptions): AgentPluginDefinition<Uploads> {
  if (typeof directory !== 'string' || !posix.isAbsolute(directory)) {
    throw new Error(
      `uploads: directory must be an absolute sandbox path, received ${JSON.stringify(directory)}`,
    );
  }
  return {
    name: 'uploads',
    create: () => new UploadsPlugin(directory),
  };
}

class UploadsPlugin implements Uploads {
  readonly #directory: string;
  #host: AgentPluginHost | undefined;

  constructor(directory: string) {
    this.#directory = directory;
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
          'The user attached the files listed below for this turn; read them by path with the readFile tool when needed, and [Image #N] in the message refers to the Nth listed file.',
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

  /** `<directory>/<userId>/<sessionId>`; `userId` must be one path segment. */
  #scopeFor({ userId, sessionId }: UploadScope): string {
    if (
      userId.length === 0 ||
      userId === '.' ||
      userId === '..' ||
      userId.includes('/')
    ) {
      throw new Error(
        `uploads: userId must be a single path segment, received "${userId}"`,
      );
    }
    return posix.join(this.#directory, userId, sessionId);
  }

  #pathFor(scope: UploadScope, fileId: string): string {
    return posix.join(this.#scopeFor(scope), fileId);
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
