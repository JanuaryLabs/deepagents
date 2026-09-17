import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Hono } from 'hono';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import test from 'node:test';

import {
  type AgentModel,
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  SqliteMailboxStore,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';
import {
  type PublishedUpload,
  UPLOAD_MEDIA_TYPES,
  type UploadsOptions,
  uploads,
} from '@deepagents/experimental/zukhruf/uploads';
import {
  UPLOAD_FILENAME_HEADER,
  type UploadReceipt,
  uploadsHttp,
} from '@deepagents/experimental/zukhruf/uploads/http';

const MOUNT = '/zukhruf/v1';
const USER_HEADER = 'x-test-user';
const OWNER = 'owner-1';
const UPLOAD_DIRECTORY = '/workspace/uploads';
const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** `ftyp` boxes are enough for the store, which never sniffs bytes. */
const MP4_HEADER = Buffer.from(
  '0000002066747970697736d00000020069736f6d69736f32',
  'hex',
);
const HEIC_HEADER = Buffer.from(
  '0000001866747970686569630000000068656963',
  'hex',
);
const MP3_HEADER = Buffer.from('494433040000000000', 'hex');
const MAX_UPLOAD_BYTES = 4096;
const PUBLIC_URL = `http://localhost${MOUNT}`;

class ControlledTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #options?: ConsumeOptions;

  push(turn: TurnRef): Promise<void> {
    this.turns.push(turn);
    return Promise.resolve();
  }

  getTurnActivity(): Promise<TurnActivity> {
    return Promise.resolve(this.turns.length === 0 ? 'idle' : 'queued');
  }

  getCurrentTurn(): Promise<TurnRef | undefined> {
    return Promise.resolve(this.turns[0]);
  }

  cancel(streamId: string): Promise<void> {
    const index = this.turns.findIndex((turn) => turn.streamId === streamId);
    if (index >= 0) this.turns.splice(index, 1);
    return Promise.resolve();
  }

  consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    this.#handler = handler;
    this.#options = options;
    return Promise.resolve({
      [Symbol.asyncDispose]: () => {
        this.#handler = undefined;
        this.#options = undefined;
        return Promise.resolve();
      },
    });
  }

  resumeParked(): Promise<void> {
    return Promise.resolve();
  }

  async runNext(): Promise<void> {
    const turn = this.turns.shift();
    assert(turn, 'expected a queued turn');
    assert(this.#handler, 'expected a running queue consumer');
    try {
      await this.#handler(turn, {
        signal: new AbortController().signal,
        park: () => Promise.resolve(),
      });
      await this.#options?.onSettled?.(turn);
    } catch (error) {
      await this.#options?.onOrphaned(
        turn,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textChunks(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
    },
  ];
}

function toolCallChunks(
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV4StreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: `call-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage,
    },
  ];
}

/** Streams the scripted chunk list for each successive model call, then keeps answering with text. */
function scriptedModel(script: LanguageModelV4StreamPart[][] = []) {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    provider: 'test',
    modelId: 'uploads-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks:
          script[model.doStreamCalls.length - 1] ??
          textChunks('I see a pixel.'),
      }),
    }),
  });
  return model;
}

/**
 * One real runtime over one in-memory sandbox filesystem that every attach
 * shares, the way a named backend keeps its rootfs across attaches.
 */
async function harness(
  options: {
    withUploads?: boolean;
    script?: LanguageModelV4StreamPart[][];
  } = {},
) {
  const resources = new AsyncDisposableStack();
  const fs = new InMemoryFs();
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const uploaded = uploads({
    directory: UPLOAD_DIRECTORY,
    publicUrl: PUBLIC_URL,
  });
  const model = scriptedModel(options.script);
  const queue = new ControlledTurnQueue();
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'uploads-agent',
      model: model as unknown as AgentModel,
      sandbox: defineSandbox(async () => createVirtualSandbox({ fs })),
      instructions: [],
      plugins: [uploaded],
    }),
  );
  const stack = defineStack(async () => ({
    store: new InMemoryContextStore(),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue,
    mailboxStore,
  }));
  const runtime = await runtimeSetup.initialize(stack);
  resources.use(await runtime.work());

  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    const userId = context.req.header(USER_HEADER);
    if (userId) context.set('userId', userId);
    return next();
  });
  app.route(
    MOUNT,
    options.withUploads === false
      ? http(runtime)
      : http(runtime, uploadsHttp(uploaded, { maxBytes: MAX_UPLOAD_BYTES })),
  );

  return {
    app,
    fs,
    model,
    queue,
    uploads: runtime.plugin(uploaded),
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

/** Reads the stored bytes through a fresh attach to the shared filesystem. */
async function storedBytes(
  fs: InMemoryFs,
  userId: string,
  sessionId: string,
  fileId: string,
): Promise<Buffer> {
  await using sandbox = await createVirtualSandbox({ fs });
  return Buffer.from(
    await sandbox.readFile(
      `${UPLOAD_DIRECTORY}/${userId}/${sessionId}/${fileId}`,
      { encoding: 'binary' },
    ),
  );
}

/** Writes a file into the shared sandbox filesystem the way an agent's bash tool would. */
async function writeSandboxFile(
  fs: InMemoryFs,
  path: string,
  content: Buffer,
): Promise<void> {
  await using sandbox = await createVirtualSandbox({ fs });
  await sandbox.writeFiles([{ path, content }]);
}

async function sessionDirectoryExists(
  fs: InMemoryFs,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  await using sandbox = await createVirtualSandbox({ fs });
  return sandbox.exists(`${UPLOAD_DIRECTORY}/${userId}/${sessionId}`);
}

function request(
  app: Hono<HttpEnv>,
  path: string,
  init: RequestInit & { user?: string } = {},
) {
  const { user = OWNER, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set(USER_HEADER, user);
  return app.request(path, { ...rest, headers });
}

function upload(
  app: Hono<HttpEnv>,
  sessionId: string,
  init: {
    body?: RequestInit['body'];
    contentType?: string;
    filename?: string;
    user?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': init.contentType ?? 'image/png',
  };
  if (init.filename !== undefined) {
    headers[UPLOAD_FILENAME_HEADER] = encodeURIComponent(init.filename);
  }
  return request(app, `${MOUNT}/session/${sessionId}/uploads`, {
    method: 'POST',
    body: init.body ?? PNG_PIXEL,
    headers,
    user: init.user,
  });
}

function turn(
  app: Hono<HttpEnv>,
  sessionId: string,
  message: {
    parts: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  },
) {
  return request(app, `${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: { id: `message-${randomUUID()}`, role: 'user', ...message },
      trigger: 'submit-message',
    }),
  });
}

/** Text of the latest user message the model received on its `call`th invocation. */
function promptedUserText(model: MockLanguageModelV4, call: number): string {
  const prompt = model.doStreamCalls[call]?.prompt;
  assert.ok(prompt, `the model was called ${call + 1} times`);
  const message = prompt.findLast((candidate) => candidate.role === 'user');
  assert.ok(message?.role === 'user');
  return message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

test('uploads() requires an absolute sandbox directory and an absolute public URL', () => {
  assert.throws(
    () => uploads({ directory: 'relative' }),
    /directory must be an absolute sandbox path/,
  );
  assert.throws(
    () => uploads({} as UploadsOptions),
    /directory must be an absolute sandbox path/,
  );
  assert.throws(
    () => uploads({ directory: UPLOAD_DIRECTORY, publicUrl: 'zukhruf/v1' }),
    /publicUrl must be an absolute http\(s\) URL/,
  );
  assert.throws(
    () => uploads({ directory: UPLOAD_DIRECTORY, publicUrl: 'ftp://host/v1' }),
    /publicUrl must be an absolute http\(s\) URL/,
  );
  assert.throws(
    () =>
      uploadsHttp(uploads({ directory: UPLOAD_DIRECTORY }), { maxBytes: 0 }),
    /maxBytes must be a positive safe integer/,
  );
});

test('uploads reject path segments that can escape their owner and session scope', async () => {
  await using h = await harness();

  await assert.rejects(
    h.uploads.write(
      { userId: OWNER, sessionId: '../victim' },
      { data: PNG_PIXEL, mediaType: 'image/png' },
    ),
    /sessionId must be a single path segment/,
  );
  assert.equal(await sessionDirectoryExists(h.fs, 'victim', ''), false);
});

test('discovery advertises the uploads capability only when it is composed', async () => {
  await using withCapability = await harness();
  await using withoutCapability = await harness({ withUploads: false });
  const sessionId = randomUUID();

  const present = (await (
    await request(withCapability.app, `${MOUNT}/info`)
  ).json()) as { capabilities: Record<string, unknown> };
  const absent = (await (
    await request(withoutCapability.app, `${MOUNT}/info`)
  ).json()) as { capabilities: Record<string, unknown> };

  assert.deepEqual(present.capabilities.uploads, {
    href: `${MOUNT}/session`,
    mediaTypes: [...UPLOAD_MEDIA_TYPES],
  });
  assert.equal(absent.capabilities.uploads, undefined);
  assert.equal(
    (await upload(withoutCapability.app, sessionId, { filename: 'pixel.png' }))
      .status,
    404,
  );
  assert.equal(
    (
      await withCapability.app.request(
        `${MOUNT}/session/${sessionId}/uploads`,
        {
          method: 'POST',
          body: PNG_PIXEL,
          headers: {
            'content-type': 'image/png',
            [UPLOAD_FILENAME_HEADER]: 'pixel.png',
          },
        },
      )
    ).status,
    401,
  );
});

test('POST /session/:sessionId/uploads stores the image in the session sandbox and returns a receipt naming its sandbox path', async () => {
  await using h = await harness();
  const sessionId = randomUUID();

  const response = await upload(h.app, sessionId, {
    filename: 'screen shot.png',
  });
  const receipt = (await response.json()) as UploadReceipt;

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const fileId = posix.basename(new URL(receipt.url).pathname);
  assert.deepEqual(receipt, {
    path: `${UPLOAD_DIRECTORY}/${OWNER}/${sessionId}/${fileId}`,
    name: 'screen shot.png',
    mediaType: 'image/png',
    size: PNG_PIXEL.byteLength,
    url: `http://localhost${MOUNT}/session/${sessionId}/uploads/${fileId}`,
  });
  assert.deepEqual(
    await storedBytes(h.fs, OWNER, sessionId, fileId),
    PNG_PIXEL,
  );

  const jpeg = (await (
    await upload(h.app, sessionId, {
      filename: 'photo.jpg',
      contentType: 'image/jpeg; charset=binary',
    })
  ).json()) as UploadReceipt;
  assert.equal(jpeg.mediaType, 'image/jpeg');
  assert.match(jpeg.path, /\.jpg$/);

  const stored: Array<[string, Buffer, string, RegExp]> = [
    ['image/heic', HEIC_HEADER, 'IMG_0001.HEIC', /\.heic$/],
    ['video/mp4', MP4_HEADER, 'clip.mp4', /\.mp4$/],
    ['video/quicktime', MP4_HEADER, 'IMG_0002.MOV', /\.mov$/],
    ['audio/mpeg', MP3_HEADER, 'track.mp3', /\.mp3$/],
    ['audio/mp4', MP4_HEADER, 'voice.m4a', /\.m4a$/],
  ];
  for (const [contentType, body, filename, extension] of stored) {
    const receipt = (await (
      await upload(h.app, sessionId, { body, contentType, filename })
    ).json()) as UploadReceipt;
    assert.deepEqual(
      { mediaType: receipt.mediaType, name: receipt.name, size: receipt.size },
      { mediaType: contentType, name: filename, size: body.byteLength },
    );
    assert.match(receipt.path, extension);
    assert.deepEqual(
      await storedBytes(h.fs, OWNER, sessionId, posix.basename(receipt.path)),
      body,
    );
  }
});

test('POST /session/:sessionId/uploads requires a URI-encoded x-upload-filename header', async () => {
  await using h = await harness();
  const sessionId = randomUUID();

  const missing = await upload(h.app, sessionId);
  const malformed = await request(
    h.app,
    `${MOUNT}/session/${sessionId}/uploads`,
    {
      method: 'POST',
      body: PNG_PIXEL,
      headers: {
        'content-type': 'image/png',
        [UPLOAD_FILENAME_HEADER]: '%E0%A4%A',
      },
    },
  );

  for (const response of [missing, malformed]) {
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { cause: { code: string } }).cause.code,
      'api/validation-failed',
    );
  }
  assert.equal(await sessionDirectoryExists(h.fs, OWNER, sessionId), false);
});

test('GET /session/:sessionId/uploads/:fileId serves the bytes to the owner only', async () => {
  await using h = await harness();
  const sessionId = randomUUID();
  const { url } = (await (
    await upload(h.app, sessionId, { filename: 'pixel.png' })
  ).json()) as UploadReceipt;
  const path = new URL(url).pathname;

  const served = await request(h.app, path);
  const head = await request(h.app, path, { method: 'HEAD' });
  const foreign = await request(h.app, path, { user: 'owner-2' });
  const missing = await request(
    h.app,
    `${MOUNT}/session/${sessionId}/uploads/${randomUUID()}.png`,
  );
  const traversal = await request(
    h.app,
    `${MOUNT}/session/${sessionId}/uploads/..%2F..%2Fsecret.png`,
  );

  assert.equal(served.status, 200);
  assert.deepEqual(
    {
      type: served.headers.get('content-type'),
      cache: served.headers.get('cache-control'),
      ranges: served.headers.get('accept-ranges'),
      length: served.headers.get('content-length'),
    },
    {
      type: 'image/png',
      cache: 'private, max-age=31536000, immutable',
      ranges: 'bytes',
      length: String(PNG_PIXEL.byteLength),
    },
  );
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG_PIXEL);
  assert.equal(head.status, 200);
  assert.equal(
    head.headers.get('content-length'),
    String(PNG_PIXEL.byteLength),
  );
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const response of [foreign, missing, traversal]) {
    assert.equal(response.status, 404);
    assert.equal(
      ((await response.json()) as { cause: { code: string } }).cause.code,
      'zukhruf/upload-not-found',
    );
  }
});

test('GET /session/:sessionId/uploads/:fileId honours single byte ranges so media elements can seek', async () => {
  await using h = await harness();
  const sessionId = randomUUID();
  const { url } = (await (
    await upload(h.app, sessionId, {
      body: MP4_HEADER,
      contentType: 'video/mp4',
      filename: 'clip.mp4',
    })
  ).json()) as UploadReceipt;
  const path = new URL(url).pathname;
  const total = MP4_HEADER.byteLength;

  const prefix = await request(h.app, path, {
    headers: { range: 'bytes=0-3' },
  });
  const suffix = await request(h.app, path, { headers: { range: 'bytes=-4' } });
  const open = await request(h.app, path, { headers: { range: 'bytes=20-' } });
  const beyond = await request(h.app, path, {
    headers: { range: `bytes=${total}-` },
  });
  const multi = await request(h.app, path, {
    headers: { range: 'bytes=0-1,4-5' },
  });

  assert.deepEqual(
    {
      status: prefix.status,
      range: prefix.headers.get('content-range'),
      length: prefix.headers.get('content-length'),
      type: prefix.headers.get('content-type'),
      body: Buffer.from(await prefix.arrayBuffer()),
    },
    {
      status: 206,
      range: `bytes 0-3/${total}`,
      length: '4',
      type: 'video/mp4',
      body: MP4_HEADER.subarray(0, 4),
    },
  );
  assert.equal(
    suffix.headers.get('content-range'),
    `bytes ${total - 4}-${total - 1}/${total}`,
  );
  assert.deepEqual(
    Buffer.from(await suffix.arrayBuffer()),
    MP4_HEADER.subarray(total - 4),
  );
  assert.equal(
    open.headers.get('content-range'),
    `bytes 20-${total - 1}/${total}`,
  );
  assert.deepEqual(
    Buffer.from(await open.arrayBuffer()),
    MP4_HEADER.subarray(20),
  );
  for (const response of [beyond, multi]) {
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${total}`);
  }
});

test('POST /session/:sessionId/uploads rejects anything but a supported media type', async () => {
  await using h = await harness();
  const sessionId = randomUUID();

  const text = await upload(h.app, sessionId, {
    body: 'hello',
    contentType: 'text/plain',
    filename: 'hello.txt',
  });
  const svg = await upload(h.app, sessionId, {
    body: '<svg/>',
    contentType: 'image/svg+xml',
    filename: 'shape.svg',
  });
  const untyped = await request(
    h.app,
    `${MOUNT}/session/${sessionId}/uploads`,
    {
      method: 'POST',
      body: PNG_PIXEL,
      headers: { [UPLOAD_FILENAME_HEADER]: 'pixel.png' },
    },
  );

  for (const response of [text, svg, untyped]) {
    assert.equal(response.status, 415);
    assert.equal(
      ((await response.json()) as { cause: { code: string } }).cause.code,
      'zukhruf/unsupported-media-type',
    );
  }
});

test('POST /session/:sessionId/uploads rejects declared and streamed oversized bodies', async () => {
  await using h = await harness();
  const sessionId = randomUUID();
  const body = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  const streamed = await upload(h.app, sessionId, {
    body,
    filename: 'large.png',
  });
  const declared = await request(
    h.app,
    `${MOUNT}/session/${sessionId}/uploads`,
    {
      method: 'POST',
      body,
      headers: {
        'content-length': String(body.byteLength),
        'content-type': 'image/png',
        [UPLOAD_FILENAME_HEADER]: 'large.png',
      },
    },
  );

  for (const response of [streamed, declared]) {
    assert.equal(response.status, 413);
    assert.equal(
      ((await response.json()) as { cause: { code: string } }).cause.code,
      'api/payload-too-large',
    );
  }
  assert.equal(await sessionDirectoryExists(h.fs, OWNER, sessionId), false);
});

test('POST /session/:sessionId accepts any well-formed user message, https file parts included, since nothing resolves URLs into the prompt', async () => {
  await using h = await harness();
  const sessionId = randomUUID();

  const response = await turn(h.app, sessionId, {
    parts: [
      {
        type: 'file',
        mediaType: 'image/png',
        url: 'https://example.com/screen.png',
      },
      { type: 'text', text: 'What is in this image?' },
    ],
  });

  assert.equal(response.status, 202);
  assert.equal(h.queue.turns.length, 1);
});

test('receipts under message.metadata.uploads reach the model as a reminder listing only this session own sandbox paths', async () => {
  await using h = await harness();
  const sessionId = randomUUID();
  const receipt = (await (
    await upload(h.app, sessionId, { filename: 'pixel.png' })
  ).json()) as UploadReceipt;
  const fileId = posix.basename(receipt.path);
  const outsideDirectory = {
    path: '/etc/passwd',
    name: 'passwd',
    mediaType: 'text/plain',
    size: 1,
  };
  const otherOwner = {
    ...receipt,
    path: `${UPLOAD_DIRECTORY}/owner-2/${sessionId}/${fileId}`,
  };
  const otherSession = {
    ...receipt,
    path: `${UPLOAD_DIRECTORY}/${OWNER}/${randomUUID()}/${fileId}`,
  };
  const traversal = {
    ...receipt,
    path: `${UPLOAD_DIRECTORY}/${OWNER}/${sessionId}/../../../secret.png`,
  };
  const withoutSize = {
    path: receipt.path,
    name: receipt.name,
    mediaType: receipt.mediaType,
  };

  const clip = (await (
    await upload(h.app, sessionId, {
      body: MP4_HEADER,
      contentType: 'video/mp4',
      filename: 'clip.mp4',
    })
  ).json()) as UploadReceipt;

  const attached = await turn(h.app, sessionId, {
    parts: [{ type: 'text', text: 'What is in [Image #1] and [Video #2]?' }],
    metadata: {
      uploads: [
        outsideDirectory,
        receipt,
        otherOwner,
        otherSession,
        traversal,
        withoutSize,
        clip,
      ],
    },
  });
  assert.equal(attached.status, 202);
  await h.queue.runNext();
  const attachedText = promptedUserText(h.model, 0);
  const plain = await turn(h.app, sessionId, {
    parts: [{ type: 'text', text: 'Thanks' }],
  });
  assert.equal(plain.status, 202);
  await h.queue.runNext();
  const plainText = promptedUserText(h.model, 1);

  assert.match(attachedText, /^What is in \[Image #1\] and \[Video #2\]\?\n/);
  const reminder = /<system-reminder>(?<body>[^]*)<\/system-reminder>/.exec(
    attachedText,
  )?.groups?.body;
  assert.equal(
    reminder,
    [
      'The user attached the files listed below for this turn; read images by path with the readFile tool when needed (convert HEIC and extract video frames with sandbox commands first), and [Image #N], [Video #N], or [Audio #N] in the message refers to the Nth listed file.',
      `- ${receipt.path} (pixel.png, image/png, ${PNG_PIXEL.byteLength} bytes)`,
      `- ${clip.path} (clip.mp4, video/mp4, ${MP4_HEADER.byteLength} bytes)`,
    ].join('\n'),
  );
  assert.equal(plainText, 'Thanks');
});

test('publish_upload adopts a file the agent rendered into the session and the GET route serves it', async () => {
  const sessionId = randomUUID();
  const scope = `${UPLOAD_DIRECTORY}/${OWNER}/${sessionId}`;
  const rendered = `${scope}/render/reel.mp4`;
  await using h = await harness({
    script: [
      toolCallChunks('publish_upload', {
        path: rendered,
        name: 'Highlight reel',
      }),
      textChunks('Published.'),
    ],
  });
  await writeSandboxFile(h.fs, rendered, MP4_HEADER);

  const response = await turn(h.app, sessionId, {
    parts: [{ type: 'text', text: 'Publish the reel.' }],
  });
  assert.equal(response.status, 202);
  await h.queue.runNext();

  assert.equal(h.model.doStreamCalls.length, 2);
  const result = h.model.doStreamCalls[1]?.prompt
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .find(
      (part) =>
        part.type === 'tool-result' && part.toolName === 'publish_upload',
    );
  assert.ok(result?.type === 'tool-result' && result.output.type === 'json');
  const published = result.output.value as unknown as PublishedUpload;
  const fileId = published.fileId;
  assert.match(fileId, /^[0-9a-f-]{36}\.mp4$/);
  assert.deepEqual(published, {
    fileId,
    path: `${scope}/${fileId}`,
    mediaType: 'video/mp4',
    name: 'Highlight reel',
    href: `/session/${sessionId}/uploads/${fileId}`,
    url: `${PUBLIC_URL}/session/${sessionId}/uploads/${fileId}`,
  });
  assert.deepEqual(
    await storedBytes(h.fs, OWNER, sessionId, fileId),
    MP4_HEADER,
  );
  const served = await request(h.app, new URL(published.url ?? '').pathname, {
    headers: { range: 'bytes=0-7' },
  });
  assert.equal(served.status, 206);
  assert.deepEqual(
    Buffer.from(await served.arrayBuffer()),
    MP4_HEADER.subarray(0, 8),
  );

  const again = await h.uploads.publish(
    { userId: OWNER, sessionId },
    { path: published.path },
  );
  assert.equal(again.fileId, fileId);
  await assert.rejects(
    h.uploads.publish({ userId: OWNER, sessionId }, { path: '/etc/passwd' }),
    /outside this session's uploads directory/,
  );
  await writeSandboxFile(h.fs, `${scope}/render/tool.exe`, MP4_HEADER);
  await assert.rejects(
    h.uploads.publish(
      { userId: OWNER, sessionId },
      { path: `${scope}/render/tool.exe` },
    ),
    /unsupported file extension "exe"/,
  );
  await assert.rejects(
    h.uploads.publish(
      { userId: OWNER, sessionId },
      { path: `${scope}/render/missing.mp4` },
    ),
    /does not exist in the sandbox/,
  );
  await assert.rejects(
    h.uploads.publish({ userId: 'owner-2', sessionId }, { path: rendered }),
    /outside this session's uploads directory/,
  );
});
