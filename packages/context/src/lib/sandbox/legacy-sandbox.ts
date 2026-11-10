import {
  type Experimental_SandboxFileStat,
  type Experimental_SandboxProcess,
  type Experimental_SandboxRunOptions,
  type Experimental_SandboxSpawnOptions,
  type Experimental_SandboxSpawnOptionsWithStdin,
  type Experimental_SandboxSpawnOptionsWithoutStdin,
  type Experimental_WritableSandboxProcess,
  extractLines,
} from '@ai-sdk/provider-utils';

import { FILE_STAT_TYPES, bufferEncoding } from './container-session.ts';
import { shellQuote } from './shell-quote.ts';
import type { DisposableSandbox, LegacySandbox } from './types.ts';

function commandInScope({
  command,
  workingDirectory,
  env,
}: Experimental_SandboxRunOptions): string {
  const exports = Object.entries(env ?? {}).map(
    ([name, value]) => `export ${name}=${shellQuote(value)}; `,
  );
  const directory =
    workingDirectory === undefined
      ? ''
      : `cd -- ${shellQuote(workingDirectory)} && `;
  return `${exports.join('')}${directory}${command}`;
}

function unported(method: string): never {
  throw new Error(`${method} is not available until this backend is ported.`);
}

/**
 * Presents a backend still on the old contract as a session, so one tool serves
 * ported and unported backends while they move one at a time. Implements what
 * package code calls today. Deleted with the last port.
 */
export function fromLegacySandbox(legacy: LegacySandbox): DisposableSandbox {
  const readBinaryFile: DisposableSandbox['readBinaryFile'] = async ({
    path,
  }) => {
    try {
      return await legacy.readFile(path, { encoding: 'binary' });
    } catch (error) {
      if (await legacy.exists(path)) throw error;
      return null;
    }
  };

  const writeBinaryFile: DisposableSandbox['writeBinaryFile'] = ({
    path,
    content,
  }) => legacy.writeFiles([{ path, content: Buffer.from(content) }]);

  function spawn(
    options: Experimental_SandboxSpawnOptionsWithStdin,
  ): Promise<Experimental_WritableSandboxProcess>;
  function spawn(
    options: Experimental_SandboxSpawnOptionsWithoutStdin,
  ): Promise<Experimental_SandboxProcess>;
  function spawn(
    options: Experimental_SandboxSpawnOptions,
  ): Promise<Experimental_SandboxProcess | Experimental_WritableSandboxProcess>;
  async function spawn(
    options: Experimental_SandboxSpawnOptions,
  ): Promise<Experimental_SandboxProcess> {
    if (options.stdin) throw new Error('This sandbox has no writable stdin.');
    if (!legacy.spawn) throw new Error('This sandbox cannot spawn processes.');
    const killer = new AbortController();
    const { abortSignal } = options;
    const child = await legacy.spawn(commandInScope(options), {
      signal: abortSignal
        ? AbortSignal.any([abortSignal, killer.signal])
        : killer.signal,
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      wait: async () => {
        const { code } = await child.exit;
        abortSignal?.throwIfAborted();
        return { exitCode: code ?? 1 };
      },
      kill: async () => killer.abort(),
    };
  }

  return {
    description: 'Commands run through bash -lc.',
    run: (options) =>
      legacy.executeCommand(
        commandInScope(options),
        options.abortSignal ? { signal: options.abortSignal } : undefined,
      ),
    spawn,
    readBinaryFile,
    readFile: async (options) => {
      const bytes = await readBinaryFile(options);
      return bytes && new Blob([Buffer.from(bytes)]).stream();
    },
    readTextFile: async ({ startLine, endLine, encoding, ...options }) => {
      const bytes = await readBinaryFile(options);
      if (!bytes) return null;
      return extractLines({
        text: Buffer.from(bytes).toString(bufferEncoding(encoding)),
        startLine,
        endLine,
      });
    },
    writeBinaryFile,
    writeFile: async ({ path, content }) =>
      writeBinaryFile({
        path,
        content: new Uint8Array(await new Response(content).arrayBuffer()),
      }),
    writeTextFile: ({ path, content, encoding }) =>
      writeBinaryFile({
        path,
        content: Buffer.from(content, bufferEncoding(encoding)),
      }),
    stat: async ({ path }): Promise<Experimental_SandboxFileStat | null> => {
      const quoted = shellQuote(path);
      const { stdout } = await legacy.executeCommand(
        `if [ -d ${quoted} ]; then echo directory 0; elif [ -f ${quoted} ]; then echo file $(wc -c < ${quoted}); elif [ -e ${quoted} ]; then echo other 0; fi`,
      );
      const [printed, size] = stdout.trim().split(' ');
      if (!printed) return null;
      const type = FILE_STAT_TYPES.find((known) => known === printed);
      if (!type) {
        throw new Error(`Failed to stat "${path}": unknown type "${printed}"`);
      }
      return { type, size: Number(size) };
    },
    listDirectory: () => unported('listDirectory'),
    deleteFile: () => unported('deleteFile'),
    dispose: () => legacy.dispose(),
    [Symbol.asyncDispose]: () => legacy.dispose(),
  };
}
