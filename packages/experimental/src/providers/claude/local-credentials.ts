import { writeFile as atomicWriteFile } from 'atomically';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { z } from 'zod';

const nativeLogin = z.looseObject({
  claudeAiOauth: z.looseObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().finite().positive(),
    scopes: z
      .array(z.string())
      .refine((scopes) => scopes.includes('user:inference')),
  }),
});
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().finite().positive(),
  scope: z.string().optional(),
});
const signInMessage =
  'No usable local Claude login. Run `claude auth login` on this machine.';

/** Reads Claude Code's native store without running the Claude agent. */
export async function getLocalClaudeAuth(
  signal?: AbortSignal | null,
): Promise<string> {
  signal?.throwIfAborted();
  const directory = (
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  ).normalize('NFC');
  const home = await realpath(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error(signInMessage);
      throw error;
    },
  );
  const initial = await snapshot(home, directory);
  if (initial.value.claudeAiOauth.expiresAt > Date.now() + 60_000)
    return initial.value.claudeAiOauth.accessToken;

  const release = await lock(home, {
    lockfilePath: join(home, '.deepagents-claude.lock'),
    retries: { retries: 20, minTimeout: 50, maxTimeout: 1000 },
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const current = await snapshot(home, directory);
      const tokens = current.value.claudeAiOauth;
      if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
      let fresh;
      try {
        const response = await globalThis.fetch(
          'https://platform.claude.com/v1/oauth/token',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'refresh_token',
              refresh_token: tokens.refreshToken,
              client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
              scope: tokens.scopes.join(' '),
            }),
            signal: AbortSignal.any([
              AbortSignal.timeout(30_000),
              ...(signal ? [signal] : []),
            ]),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Token refresh rejected');
        }
        fresh = tokenResponse.parse(await response.json());
      } catch {
        signal?.throwIfAborted();
        if ((await current.store.read()) !== current.raw) continue;
        throw new Error(
          'Could not refresh the local Claude login. Run `claude auth login` again.',
        );
      }
      signal?.throwIfAborted();
      // ponytail: the Claude CLI does not share this lock. Detect completed
      // login changes; a single credential owner is needed to eliminate CLI refresh races.
      if ((await current.store.read()) !== current.raw) continue;
      const value = nativeLogin.parse({
        ...current.value,
        claudeAiOauth: {
          ...tokens,
          accessToken: fresh.access_token,
          refreshToken: fresh.refresh_token ?? tokens.refreshToken,
          expiresAt: Date.now() + fresh.expires_in * 1000,
          scopes: fresh.scope?.split(' ') ?? tokens.scopes,
        },
      });
      await current.store.write(JSON.stringify(value, null, 2) + '\n');
      return value.claudeAiOauth.accessToken;
    }
    throw new Error(
      'The local Claude login changed repeatedly during refresh. Retry the request.',
    );
  } finally {
    await release();
  }
}

async function snapshot(home: string, directory: string) {
  const store = await credentialStore(home, directory);
  const raw = await store.read();
  try {
    return { store, raw, value: nativeLogin.parse(JSON.parse(raw ?? 'null')) };
  } catch {
    throw new Error(signInMessage);
  }
}

async function credentialStore(home: string, directory: string) {
  if (process.platform === 'darwin') {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    // Claude namespaces explicitly configured homes, even the default path.
    const suffix = process.env.CLAUDE_CONFIG_DIR
      ? `-${createHash('sha256').update(directory).digest('hex').slice(0, 8)}`
      : '';
    const entry = new AsyncEntry(
      `Claude Code-credentials${suffix}`,
      process.env.USER || userInfo().username,
    );
    const keychain = {
      read: () => entry.getPassword(),
      write: (value: string) => entry.setPassword(value),
    };
    if ((await keychain.read()) !== undefined) return keychain;
  }
  const path = join(home, '.credentials.json');
  return {
    read: () =>
      readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }),
    write: (value: string) => atomicWriteFile(path, value, { mode: 0o600 }),
  };
}
