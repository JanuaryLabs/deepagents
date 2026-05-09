import type { CommandResult } from 'bash-tool';
import { Bash, defineCommand } from 'just-bash';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBashTool } from '@deepagents/context';
import { createSqlCommandHooks } from '@deepagents/text2sql';

interface CapturedSqlInvocation {
  args: string[];
}

type BashCommandResult = CommandResult & {
  meta?: Record<string, unknown>;
  reminder?: string;
};

type SqlCommandHooks = Pick<
  NonNullable<Parameters<typeof createBashTool>[0]>,
  'onBeforeBashCall' | 'onAfterBashCall'
>;

function isAsyncIterableCommandResult(
  value: unknown,
): value is AsyncIterable<CommandResult> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

async function executeWithSqlHooks(
  command: string,
  hooks: SqlCommandHooks = createSqlCommandHooks({ adapters: {} }),
): Promise<BashCommandResult> {
  const bashEnv = new Bash({
    cwd: '/',
    customCommands: [
      defineCommand('sql', async (args) => ({
        stdout: JSON.stringify({ args } satisfies CapturedSqlInvocation),
        stderr: '',
        exitCode: 0,
      })),
    ],
  });

  const { bash } = await createBashTool({
    sandbox: bashEnv,
    destination: '/',
    ...hooks,
  });
  const execute = bash.execute;
  assert.ok(execute, 'bash tool execution should be available');
  type BashExecuteOptions = Parameters<typeof execute>[1];
  const execOptions: BashExecuteOptions = {
    messages: [],
    toolCallId: 'sql-hooks',
  };

  const result = await execute(
    {
      command,
      reasoning: 'verify sql command behavior through the bash tool',
    },
    execOptions,
  );
  if (isAsyncIterableCommandResult(result)) {
    throw new Error('expected bash command to return a non-streaming result');
  }
  return result as BashCommandResult;
}

function parseCapturedInvocation(stdout: string): CapturedSqlInvocation {
  return JSON.parse(stdout) as CapturedSqlInvocation;
}

describe('createSqlCommandHooks integration', () => {
  it('executes already valid sql run commands through the bash tool', async () => {
    const result = await executeWithSqlHooks(
      `sql run main "SELECT * FROM users WHERE name = 'Bob'"`,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', "SELECT * FROM users WHERE name = 'Bob'"],
    });
  });

  it('repairs malformed sql run quoting before shell execution', async () => {
    const result = await executeWithSqlHooks(
      `sql run main "SELECT * FROM users WHERE name = 'Bob'`,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', "SELECT * FROM users WHERE name = 'Bob'"],
    });
  });

  it('repairs malformed sql validate quoting before shell execution', async () => {
    const result = await executeWithSqlHooks(
      `sql validate main "SELECT * FROM users WHERE name = 'Bob'`,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['validate', 'main', "SELECT * FROM users WHERE name = 'Bob'"],
    });
  });

  it('rewrites SQL backticks so bash does not treat them as command substitutions', async () => {
    const result = await executeWithSqlHooks(
      'sql validate main "SELECT `first_name` FROM users"',
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['validate', 'main', 'SELECT `first_name` FROM users'],
    });
  });

  it('attaches formattedSql meta from the after hook without CLI involvement', async () => {
    const formattedSql = 'SELECT *\nFROM users';
    const formattedRawSql: string[] = [];
    const hooks = createSqlCommandHooks({
      adapters: {
        main: {
          format(sql) {
            formattedRawSql.push(sql);
            return formattedSql;
          },
        },
      },
    });

    const result = await executeWithSqlHooks(
      `sql validate main "SELECT * FROM users"`,
      hooks,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['validate', 'main', 'SELECT * FROM users'],
    });
    assert.deepEqual(formattedRawSql, ['SELECT * FROM users']);
    assert.deepEqual(result.meta, { formattedSql });
  });

  it('attaches formattedSql meta for SQL identifier backticks before rewrite', async () => {
    const formattedRawSql: string[] = [];
    const hooks = createSqlCommandHooks({
      adapters: {
        main: {
          format(sql) {
            formattedRawSql.push(sql);
            return 'SELECT `first_name`\nFROM users';
          },
        },
      },
    });

    const result = await executeWithSqlHooks(
      'sql validate main "SELECT `first_name` FROM users"',
      hooks,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['validate', 'main', 'SELECT `first_name` FROM users'],
    });
    assert.deepEqual(formattedRawSql, ['SELECT `first_name` FROM users']);
    assert.deepEqual(result.meta, {
      formattedSql: 'SELECT `first_name`\nFROM users',
    });
  });

  it('formats the repaired SQL when a malformed sql run command succeeds', async () => {
    const formattedRawSql: string[] = [];
    const hooks = createSqlCommandHooks({
      adapters: {
        main: {
          format(sql) {
            formattedRawSql.push(sql);
            return "SELECT *\nFROM users\nWHERE name = 'Bob'";
          },
        },
      },
    });

    const result = await executeWithSqlHooks(
      `sql run main "SELECT * FROM users WHERE name = 'Bob'`,
      hooks,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', "SELECT * FROM users WHERE name = 'Bob'"],
    });
    assert.deepEqual(formattedRawSql, [
      "SELECT * FROM users WHERE name = 'Bob'",
    ]);
    assert.deepEqual(result.meta, {
      formattedSql: "SELECT *\nFROM users\nWHERE name = 'Bob'",
    });
    assert.match(result.reminder ?? '', /Always run `sql validate/);
  });

  it('blocks raw SQL commands so queries stay behind CLI validation', async () => {
    const result = await executeWithSqlHooks('SELECT * FROM users');

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Direct database querying through bash is blocked/,
    );
    assert.match(result.stderr, /sql validate <db>/);
    assert.match(result.stderr, /sql run <db>/);
  });

  it('blocks direct database clients so read-only and scope checks cannot be bypassed', async () => {
    const result = await executeWithSqlHooks('psql -c "SELECT * FROM users"');

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Direct database querying through bash is blocked/,
    );
  });

  it('blocks non-proxy sql subcommands from model-driven bash', async () => {
    const result = await executeWithSqlHooks('sql ask main "SELECT 1"');

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Direct database querying through bash is blocked/,
    );
  });

  it('does not repair malformed non-sql commands', async () => {
    const result = await executeWithSqlHooks(`echo "sql run main SELECT 1`);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /parse|quote|unterminated|unexpected/i);
  });

  it('handles extra whitespace between subcommand, db, and SQL', async () => {
    const result = await executeWithSqlHooks(
      `sql run  main  "SELECT * FROM users"`,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', 'SELECT * FROM users'],
    });
  });

  it('passes multi-line SQL through to the CLI as a single argument', async () => {
    const result = await executeWithSqlHooks(
      `sql run main "SELECT id\nFROM users\nWHERE active = 1"`,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', 'SELECT id\nFROM users\nWHERE active = 1'],
    });
  });

  it('preserves $-placeholders in double-quoted SQL instead of letting bash expand them', async () => {
    const result = await executeWithSqlHooks(
      `sql run main "SELECT * FROM users WHERE id = $1 AND tenant = $2"`,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: [
        'run',
        'main',
        'SELECT * FROM users WHERE id = $1 AND tenant = $2',
      ],
    });
  });

  it('joins unquoted SQL words into a single CLI argument', async () => {
    const result = await executeWithSqlHooks(
      'sql run main SELECT id FROM users',
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', 'SELECT id FROM users'],
    });
  });

  it('preserves SQL identifier double-quotes inside a single-quoted SQL argument', async () => {
    const result = await executeWithSqlHooks(
      `sql run main 'SELECT "name" FROM users WHERE "age" > 18'`,
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', 'SELECT "name" FROM users WHERE "age" > 18'],
    });
  });

  it('blocks db clients invoked through a bash -c wrapper', async () => {
    const result = await executeWithSqlHooks(`bash -c "psql -c 'SELECT 1'"`);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Direct database querying through bash is blocked/,
    );
  });

  it('blocks db clients smuggled through a shell-interpreter heredoc', async () => {
    const result = await executeWithSqlHooks(
      "sh <<'SCRIPT'\npsql -c 'SELECT 1'\nSCRIPT",
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Direct database querying through bash is blocked/,
    );
  });

  it('blocks db clients invoked through eval', async () => {
    const result = await executeWithSqlHooks(`eval "psql -c 'SELECT 1'"`);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Direct database querying through bash is blocked/,
    );
  });

  it('blocks db clients invoked through env', async () => {
    const result = await executeWithSqlHooks(
      `env PGPASSWORD=secret psql -c 'SELECT 1'`,
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Direct database querying through bash is blocked/,
    );
  });

  it('blocks db clients invoked through the command builtin', async () => {
    const result = await executeWithSqlHooks(`command psql -c 'SELECT 1'`);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Direct database querying through bash is blocked/,
    );
  });

  it('preserves parameter-expansion fallback syntax in double-quoted SQL', async () => {
    const result = await executeWithSqlHooks(
      'sql run main "SELECT * FROM users WHERE id = ${id:-0}"',
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', 'SELECT * FROM users WHERE id = ${id:-0}'],
    });
  });

  it('preserves $()-style command substitution syntax in double-quoted SQL', async () => {
    const result = await executeWithSqlHooks(
      'sql run main "SELECT * FROM logs WHERE host = $(hostname)"',
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', 'SELECT * FROM logs WHERE host = $(hostname)'],
    });
  });

  it('preserves $(()) arithmetic expansion syntax in double-quoted SQL', async () => {
    const result = await executeWithSqlHooks(
      'sql run main "SELECT $((1 + 1)) AS two FROM dual"',
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseCapturedInvocation(result.stdout), {
      args: ['run', 'main', 'SELECT $((1 + 1)) AS two FROM dual'],
    });
  });
});
