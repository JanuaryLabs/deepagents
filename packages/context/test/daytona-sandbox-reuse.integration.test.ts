import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

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
  construct?: () => void;
  get: (idOrName: string) => Promise<SandboxStub>;
  create: (params: unknown, options: unknown) => Promise<SandboxStub>;
}

const calls = {
  get: [] as string[],
  create: [] as Array<{ params: unknown; options: unknown }>,
};

let behavior: Behavior;

class FakeDaytona {
  config: unknown;
  constructor(config: unknown) {
    this.config = config;
    behavior.construct?.();
  }
  async get(idOrName: string): Promise<SandboxStub> {
    calls.get.push(idOrName);
    return behavior.get(idOrName);
  }
  async create(params: unknown, options: unknown): Promise<SandboxStub> {
    calls.create.push({ params, options });
    return behavior.create(params, options);
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

describe('createDaytonaSandbox typed-error propagation', () => {
  beforeEach(() => {
    calls.get.length = 0;
    calls.create.length = 0;
    behavior = {
      get: async () => fakeSandbox(),
      create: async () => fakeSandbox(),
    };
  });

  it('propagates a not-found from the attach (sandboxId) path unchanged', async () => {
    behavior.get = async () => {
      throw new DaytonaNotFoundError('no sandbox sb-missing');
    };

    await assert.rejects(
      createDaytonaSandbox({ apiKey: 'k', sandboxId: 'sb-missing' }),
      (error: unknown) => {
        assert.ok(
          error instanceof DaytonaNotFoundError,
          `expected DaytonaNotFoundError, got ${(error as Error).name}`,
        );
        assert.ok(
          !(error instanceof DaytonaCreationError),
          'attach not-found must not be wrapped as DaytonaCreationError',
        );
        return true;
      },
    );
  });

  it('propagates a typed error thrown by the Daytona constructor unchanged', async () => {
    behavior.construct = () => {
      throw new DaytonaAuthenticationError('credentials not found');
    };

    await assert.rejects(
      createDaytonaSandbox({ name: 'dai-chat-1' }),
      (error: unknown) => {
        assert.ok(
          error instanceof DaytonaAuthenticationError,
          `expected DaytonaAuthenticationError, got ${(error as Error).name}`,
        );
        assert.ok(
          !(error instanceof DaytonaCreationError),
          'constructor auth failure must not be masked as DaytonaCreationError',
        );
        return true;
      },
    );
  });

  it('wraps a non-SDK failure from the anonymous create path as DaytonaCreationError', async () => {
    behavior.create = async () => {
      throw new Error('socket hang up');
    };

    await assert.rejects(
      createDaytonaSandbox({ apiKey: 'k', image: 'ubuntu' }),
      (error: unknown) => {
        assert.ok(
          error instanceof DaytonaCreationError,
          `expected DaytonaCreationError, got ${(error as Error).name}`,
        );
        assert.match((error as Error).message, /socket hang up/);
        return true;
      },
    );
  });
});

describe('createDaytonaSandbox name implies get-or-create', () => {
  beforeEach(() => {
    calls.get.length = 0;
    calls.create.length = 0;
    behavior = {
      get: async () => fakeSandbox(),
      create: async () => fakeSandbox(),
    };
  });

  it('attaches to the existing sandbox resolved by name, without creating', async () => {
    behavior.get = async (name) => fakeSandbox({ id: 'sb-existing', name });
    behavior.create = async () => {
      throw new Error('create must not be called when the sandbox exists');
    };

    const sandbox = await createDaytonaSandbox({
      apiKey: 'k',
      name: 'dai-chat-1',
    });

    assert.ok(typeof sandbox.executeCommand === 'function');
    assert.deepStrictEqual(calls.get, ['dai-chat-1']);
    assert.strictEqual(calls.create.length, 0);
  });

  it('starts the resolved sandbox when it is not already started', async () => {
    const stub = fakeSandbox({ id: 'sb-existing', state: 'stopped' });
    behavior.get = async () => stub;

    await createDaytonaSandbox({
      apiKey: 'k',
      name: 'dai-chat-1',
      startTimeout: 5,
    });

    assert.strictEqual(stub.start.mock.callCount(), 1);
    assert.deepStrictEqual(stub.start.mock.calls[0].arguments, [5]);
  });

  it('creates a new sandbox when no sandbox matches the name', async () => {
    behavior.get = async () => {
      throw new DaytonaNotFoundError('dai-chat-1 absent');
    };
    behavior.create = async () => fakeSandbox({ id: 'sb-created' });

    const sandbox = await createDaytonaSandbox({
      apiKey: 'k',
      name: 'dai-chat-1',
      image: 'ubuntu',
      envVars: { FOO: 'bar' },
    });

    assert.ok(typeof sandbox.executeCommand === 'function');
    assert.deepStrictEqual(calls.get, ['dai-chat-1']);
    assert.strictEqual(calls.create.length, 1);
    assert.deepStrictEqual(calls.create[0].params, {
      name: 'dai-chat-1',
      envVars: { FOO: 'bar' },
      image: 'ubuntu',
    });
  });

  it('propagates a non-not-found typed error from the lookup without creating', async () => {
    behavior.get = async () => {
      throw new DaytonaAuthenticationError();
    };
    behavior.create = async () => {
      throw new Error('create must not run after a non-not-found lookup error');
    };

    await assert.rejects(
      createDaytonaSandbox({ apiKey: 'k', name: 'dai-chat-1' }),
      (error: unknown) => {
        assert.ok(
          error instanceof DaytonaAuthenticationError,
          `expected DaytonaAuthenticationError, got ${(error as Error).name}`,
        );
        assert.ok(!(error instanceof DaytonaCreationError));
        return true;
      },
    );
    assert.strictEqual(calls.create.length, 0);
  });

  it('does not delete a named sandbox on dispose by default', async () => {
    const stub = fakeSandbox({ id: 'sb-existing' });
    behavior.get = async () => stub;

    const sandbox = await createDaytonaSandbox({
      apiKey: 'k',
      name: 'dai-chat-1',
    });
    await sandbox.dispose();

    assert.strictEqual(stub.delete.mock.callCount(), 0);
  });

  it('deletes a named sandbox on dispose when deleteOnDispose is overridden', async () => {
    const stub = fakeSandbox({ id: 'sb-existing' });
    behavior.get = async () => stub;

    const sandbox = await createDaytonaSandbox({
      apiKey: 'k',
      name: 'dai-chat-1',
      deleteOnDispose: true,
    });
    await sandbox.dispose();

    assert.strictEqual(stub.delete.mock.callCount(), 1);
  });

  it('rejects a name combined with sandboxId', async () => {
    await assert.rejects(
      createDaytonaSandbox({
        apiKey: 'k',
        name: 'dai-chat-1',
        sandboxId: 'sb-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof DaytonaSandboxError);
        assert.match(
          (error as Error).message,
          /sandboxId.*name|name.*sandboxId/i,
        );
        return true;
      },
    );
    assert.strictEqual(calls.get.length, 0);
  });
});

describe('createDaytonaSandbox anonymous create lifecycle', () => {
  beforeEach(() => {
    calls.get.length = 0;
    calls.create.length = 0;
    behavior = {
      get: async () => fakeSandbox(),
      create: async () => fakeSandbox(),
    };
  });

  it('creates and deletes the sandbox on dispose by default when no name is given', async () => {
    const stub = fakeSandbox({ id: 'sb-anon' });
    behavior.create = async () => stub;

    const sandbox = await createDaytonaSandbox({
      apiKey: 'k',
      image: 'ubuntu',
    });
    await sandbox.dispose();

    assert.strictEqual(calls.get.length, 0);
    assert.strictEqual(calls.create.length, 1);
    assert.strictEqual(stub.delete.mock.callCount(), 1);
  });
});
