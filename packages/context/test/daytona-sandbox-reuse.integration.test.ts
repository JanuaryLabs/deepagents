import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  DaytonaCreationError,
  DaytonaSandboxError,
  createDaytonaSandbox,
} from '@deepagents/context';

class DaytonaError extends Error {}
class DaytonaNotFoundError extends DaytonaError {
  constructor(message = 'sandbox not found') {
    super(message);
    this.name = 'DaytonaNotFoundError';
  }
}
class DaytonaAuthenticationError extends DaytonaError {
  constructor(message = 'bad credentials') {
    super(message);
    this.name = 'DaytonaAuthenticationError';
  }
}

interface SandboxStub {
  id: string;
  name?: string;
  state?: string;
  start: ReturnType<typeof mock.fn>;
  delete: ReturnType<typeof mock.fn>;
  fs: { downloadFile: () => Promise<Buffer>; uploadFiles: () => Promise<void> };
  process: { executeCommand: () => Promise<{ exitCode: number }> };
}

function fakeSandbox(over: Partial<SandboxStub> = {}): SandboxStub {
  return {
    id: 'sb-fixed',
    start: mock.fn(async () => {}),
    delete: mock.fn(async () => {}),
    fs: {
      downloadFile: async () => Buffer.from(''),
      uploadFiles: async () => {},
    },
    process: {
      executeCommand: async () => ({ exitCode: 0 }),
    },
    ...over,
  };
}

interface Behavior {
  get: (idOrName: string) => Promise<SandboxStub>;
  create: (params: unknown, options: unknown) => Promise<SandboxStub>;
}

interface Calls {
  get: string[];
  create: Array<{ params: unknown; options: unknown }>;
  asyncDispose: number;
}

class FakeDaytona {
  config: unknown;
  readonly calls: Calls = { get: [], create: [], asyncDispose: 0 };
  readonly behavior: Behavior = {
    get: async () => fakeSandbox(),
    create: async () => fakeSandbox(),
  };
  constructor(config: unknown) {
    this.config = config;
  }
  async get(idOrName: string): Promise<SandboxStub> {
    this.calls.get.push(idOrName);
    return this.behavior.get(idOrName);
  }
  async create(params: unknown, options: unknown): Promise<SandboxStub> {
    this.calls.create.push({ params, options });
    return this.behavior.create(params, options);
  }
  async [Symbol.asyncDispose](): Promise<void> {
    this.calls.asyncDispose++;
  }
}

mock.module('@daytona/sdk', {
  namedExports: {
    Daytona: FakeDaytona,
    DaytonaError,
    DaytonaNotFoundError,
    DaytonaAuthenticationError,
  },
});

/**
 * Builds the client through the mocked SDK constructor, as a consumer would, so
 * it carries the SDK's `Daytona` type; the instanceof check exposes the fake's
 * recorded calls. Each test gets its own client, calls, and behavior.
 */
async function fakeDaytona(behavior: Partial<Behavior> = {}) {
  const { Daytona } = await import('@daytona/sdk');
  const client = new Daytona();
  assert.ok(client instanceof FakeDaytona);
  Object.assign(client.behavior, behavior);
  return client;
}

describe('createDaytonaSandbox typed-error propagation', () => {
  it('propagates a not-found from the attach (sandboxId) path unchanged', async () => {
    const client = await fakeDaytona({
      get: async () => {
        throw new DaytonaNotFoundError('no sandbox sb-missing');
      },
    });

    await assert.rejects(
      createDaytonaSandbox(client, { sandboxId: 'sb-missing' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error instanceof DaytonaNotFoundError,
          `expected DaytonaNotFoundError, got ${error.name}`,
        );
        assert.ok(
          !(error instanceof DaytonaCreationError),
          'attach not-found must not be wrapped as DaytonaCreationError',
        );
        return true;
      },
    );
  });

  it('wraps a non-SDK failure from the create path as DaytonaCreationError', async () => {
    const client = await fakeDaytona({
      get: async () => {
        throw new DaytonaNotFoundError('dai-chat-1 absent');
      },
      create: async () => {
        throw new Error('socket hang up');
      },
    });

    await assert.rejects(
      createDaytonaSandbox(client, {
        name: 'dai-chat-1',
        image: 'ubuntu',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error instanceof DaytonaCreationError,
          `expected DaytonaCreationError, got ${error.name}`,
        );
        assert.match(error.message, /socket hang up/);
        return true;
      },
    );
  });

  it('rejects resources without an image', async () => {
    const client = await fakeDaytona();

    await assert.rejects(
      createDaytonaSandbox(client, { resources: { cpu: 2 } }),
      /can only include "resources" when creating from "image"/,
    );
  });

  it('requires a name or a sandboxId', async () => {
    const client = await fakeDaytona();

    await assert.rejects(createDaytonaSandbox(client, {}), (error: unknown) => {
      assert.ok(error instanceof DaytonaSandboxError);
      assert.match(
        error.message,
        /require "name".*or "sandboxId"|name.*sandboxId/i,
      );
      return true;
    });
    assert.strictEqual(client.calls.get.length, 0);
    assert.strictEqual(client.calls.create.length, 0);
  });
});

describe('createDaytonaSandbox name implies get-or-create', () => {
  it('attaches to the existing sandbox resolved by name, without creating', async () => {
    const client = await fakeDaytona({
      get: async (name) => fakeSandbox({ id: 'sb-existing', name }),
      create: async () => {
        throw new Error('create must not be called when the sandbox exists');
      },
    });

    const sandbox = await createDaytonaSandbox(client, {
      name: 'dai-chat-1',
    });

    assert.ok(typeof sandbox.executeCommand === 'function');
    assert.deepStrictEqual(client.calls.get, ['dai-chat-1']);
    assert.strictEqual(client.calls.create.length, 0);
  });

  it('starts the resolved sandbox when it is not already started', async () => {
    const stub = fakeSandbox({ id: 'sb-existing', state: 'stopped' });
    const client = await fakeDaytona({ get: async () => stub });

    await createDaytonaSandbox(client, {
      name: 'dai-chat-1',
      startTimeout: 5,
    });

    assert.strictEqual(stub.start.mock.callCount(), 1);
    assert.deepStrictEqual(stub.start.mock.calls[0].arguments, [5]);
  });

  it('creates a new sandbox when no sandbox matches the name', async () => {
    const client = await fakeDaytona({
      get: async () => {
        throw new DaytonaNotFoundError('dai-chat-1 absent');
      },
      create: async () => fakeSandbox({ id: 'sb-created' }),
    });

    const sandbox = await createDaytonaSandbox(client, {
      name: 'dai-chat-1',
      image: 'ubuntu',
      envVars: { FOO: 'bar' },
    });

    assert.ok(typeof sandbox.executeCommand === 'function');
    assert.deepStrictEqual(client.calls.get, ['dai-chat-1']);
    assert.strictEqual(client.calls.create.length, 1);
    assert.deepStrictEqual(client.calls.create[0].params, {
      name: 'dai-chat-1',
      envVars: { FOO: 'bar' },
      image: 'ubuntu',
    });
  });

  it('replaces a sandbox stuck in an unrecoverable state', async () => {
    const poisoned = fakeSandbox({ id: 'sb-poisoned', state: 'error' });
    const get = mock.fn<Behavior['get']>(async () => {
      throw new DaytonaNotFoundError('gone after delete');
    });
    get.mock.mockImplementationOnce(async () => poisoned);
    const client = await fakeDaytona({
      get,
      create: async () => fakeSandbox({ id: 'sb-fresh' }),
    });

    await createDaytonaSandbox(client, {
      name: 'dai-chat-1',
      image: 'ubuntu',
    });

    assert.strictEqual(poisoned.delete.mock.callCount(), 1);
    assert.strictEqual(client.calls.create.length, 1);
  });

  it('propagates a non-not-found typed error from the lookup without creating', async () => {
    const client = await fakeDaytona({
      get: async () => {
        throw new DaytonaAuthenticationError();
      },
      create: async () => {
        throw new Error(
          'create must not run after a non-not-found lookup error',
        );
      },
    });

    await assert.rejects(
      createDaytonaSandbox(client, { name: 'dai-chat-1' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error instanceof DaytonaAuthenticationError,
          `expected DaytonaAuthenticationError, got ${error.name}`,
        );
        assert.ok(!(error instanceof DaytonaCreationError));
        return true;
      },
    );
    assert.strictEqual(client.calls.create.length, 0);
  });

  it('rejects a name combined with sandboxId', async () => {
    const client = await fakeDaytona();

    await assert.rejects(
      createDaytonaSandbox(client, {
        name: 'dai-chat-1',
        sandboxId: 'sb-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof DaytonaSandboxError);
        assert.match(error.message, /sandboxId.*name|name.*sandboxId/i);
        return true;
      },
    );
    assert.strictEqual(client.calls.get.length, 0);
  });
});

describe('createDaytonaSandbox borrows the client', () => {
  it('leaves both the sandbox and the client untouched on dispose', async () => {
    const stub = fakeSandbox({ id: 'sb-existing' });
    const client = await fakeDaytona({ get: async () => stub });

    const sandbox = await createDaytonaSandbox(client, {
      name: 'dai-chat-1',
    });
    await sandbox.dispose();

    assert.strictEqual(
      stub.delete.mock.callCount(),
      0,
      'dispose must not delete the sandbox — the caller owns its lifecycle',
    );
    assert.strictEqual(
      client.calls.asyncDispose,
      0,
      'a borrowed client must outlive every sandbox built on it',
    );
  });
});
