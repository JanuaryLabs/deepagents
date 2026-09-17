import { parse } from '@iarna/toml';
import {
  type CodexAuth,
  deriveAccountId,
  ensureFreshTokens,
  getTokenExpiry,
  isAccessTokenExpired,
  resolveConfig,
} from '@opencoredev/loginwithchatgpt-core';
import { writeFile as atomicWriteFile } from 'atomically';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lock } from 'proper-lockfile';
import { z } from 'zod';

const nativeLogin = z.looseObject({
  auth_mode: z.literal('chatgpt'),
  tokens: z.looseObject({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    id_token: z.string().optional(),
    account_id: z.string().optional(),
  }),
});
const storageMode = z.enum(['file', 'keyring', 'auto', 'ephemeral']);
const signInMessage =
  'No usable local ChatGPT login. Run `codex login` on this machine.';

type CredentialStore = {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
};

/** Reads Codex's native store without running the Codex agent. */
export async function getLocalCodexAuth(
  signal?: AbortSignal | null,
): Promise<CodexAuth> {
  signal?.throwIfAborted();
  const home = await realpath(
    resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(signInMessage);
    throw error;
  });
  const initial = await snapshot(home);
  if (!isAccessTokenExpired(initial.tokens)) return auth(initial.tokens);

  // Coordinate refreshes across provider instances and worker processes.
  const release = await lock(home, {
    lockfilePath: join(home, '.deepagents-chatgpt.lock'),
    retries: { retries: 20, minTimeout: 50, maxTimeout: 1000 },
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const current = await snapshot(home);
      if (!isAccessTokenExpired(current.tokens)) return auth(current.tokens);
      const config = resolveConfig({
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            signal: AbortSignal.any([
              AbortSignal.timeout(30_000),
              ...(signal ? [signal] : []),
            ]),
          }),
      });
      let fresh;
      try {
        fresh = await ensureFreshTokens(config, current.tokens);
      } catch {
        signal?.throwIfAborted();
        if ((await current.store.read()) !== current.raw) continue;
        // Do not leak token endpoint response bodies through errors or logs.
        throw new Error(
          'Could not refresh the local ChatGPT login. Run `codex login` again.',
        );
      }
      signal?.throwIfAborted();
      // ponytail: the Codex CLI does not share this lock. Detect completed
      // login changes; a single credential owner is needed to eliminate CLI refresh races.
      if ((await current.store.read()) !== current.raw) continue;
      await current.store.write(
        JSON.stringify(
          {
            ...current.value,
            last_refresh: new Date().toISOString(),
            tokens: {
              ...current.value.tokens,
              access_token: fresh.accessToken,
              refresh_token: fresh.refreshToken,
              id_token: fresh.idToken ?? current.value.tokens.id_token,
              account_id: fresh.accountId ?? current.tokens.accountId,
            },
          },
          null,
          2,
        ) + '\n',
      );
      return auth({
        ...fresh,
        accountId: fresh.accountId ?? current.tokens.accountId,
      });
    }
    throw new Error(
      'The local Codex login changed repeatedly during refresh. Retry the request.',
    );
  } finally {
    await release();
  }
}

function auth(tokens: { accessToken: string; accountId: string }): CodexAuth {
  return { accessToken: tokens.accessToken, accountId: tokens.accountId };
}

async function snapshot(home: string) {
  const store = await credentialStore(home);
  const raw = await store.read();
  let json: unknown;
  try {
    json = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    throw new Error(signInMessage);
  }
  const parsed = nativeLogin.safeParse(json);
  if (!parsed.success) throw new Error(signInMessage);
  const value = parsed.data;
  const expiresAt = getTokenExpiry(value.tokens.access_token);
  const accountId =
    value.tokens.account_id ||
    deriveAccountId(value.tokens.id_token) ||
    deriveAccountId(value.tokens.access_token);
  if (expiresAt === undefined || !Number.isFinite(expiresAt) || !accountId)
    throw new Error(signInMessage);
  return {
    store,
    raw,
    value,
    tokens: {
      accessToken: value.tokens.access_token,
      refreshToken: value.tokens.refresh_token,
      idToken: value.tokens.id_token,
      accountId,
      expiresAt,
    },
  };
}

async function credentialStore(home: string): Promise<CredentialStore> {
  const configuration = await readOptionalFile(join(home, 'config.toml'));
  let mode: z.infer<typeof storageMode>;
  try {
    mode = storageMode.parse(
      configuration
        ? (parse(configuration).cli_auth_credentials_store ?? 'file')
        : 'file',
    );
  } catch {
    throw new Error(
      'Cannot read cli_auth_credentials_store from the local Codex config.toml.',
    );
  }
  if (mode === 'ephemeral') {
    throw new Error(
      'Codex uses ephemeral credentials, which cannot be shared. Run `codex login` with a persistent credential store.',
    );
  }
  const authPath = join(home, 'auth.json');
  const file: CredentialStore = {
    read: () => readOptionalFile(authPath),
    write: (value) => atomicWriteFile(authPath, value, { mode: 0o600 }),
  };
  if (mode === 'file') return file;

  const { AsyncEntry } = await import('@napi-rs/keyring');
  const account = `cli|${createHash('sha256').update(home).digest('hex').slice(0, 16)}`;
  const entry = new AsyncEntry('Codex Auth', account, {
    linux: { store: 'secret-service' },
  });
  const keyring: CredentialStore = {
    read: () => entry.getPassword(),
    write: (value) => entry.setPassword(value),
  };
  if (mode === 'keyring') return keyring;
  return (await keyring.read()) === undefined ? file : keyring;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}
