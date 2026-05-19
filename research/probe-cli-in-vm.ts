import common from '@rivet-dev/agent-os-common';
import { AgentOs, defineSoftware } from '@rivet-dev/agent-os-core';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const decoder = new TextDecoder();
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliDir = resolve(repoRoot, 'demo/text2sql-cli');

const os = await AgentOs.create({
  software: [
    common,
    defineSoftware({
      type: 'tool',
      name: 'sql-cli',
      packageDir: cliDir,
      requires: ['demo-text2sql-cli', 'pg'],
      bins: { sql: 'demo-text2sql-cli' },
    }),
  ],
});

async function run(label: string, cmd: string) {
  const { pid } = os.spawn('sh', ['-c', cmd], {
    env: { PGUSER: 'postgres', PGPASSWORD: 'postgres' },
  });
  const out: string[] = [];
  const err: string[] = [];
  os.onProcessStdout(pid, (d) => out.push(decoder.decode(d)));
  os.onProcessStderr(pid, (d) => err.push(decoder.decode(d)));
  const code = await os.waitProcess(pid);
  console.log(`\n[${label}] exit=${code}`);
  if (out.length) console.log(`  STDOUT: ${out.join('').trim().slice(0, 400)}`);
  if (err.length) console.log(`  STDERR: ${err.join('').trim().slice(0, 200)}`);
}

// Inspect what `sql` actually is in the VM
await run(
  'readlink sql',
  'ls -la /usr/local/bin 2>&1; echo ---; cat /usr/local/bin/sql 2>&1 | head -10',
);
await run(
  'try direct full-path with fixed argv',
  'node /root/node_modules/demo-text2sql-cli/sql.mjs run pagila "SELECT title FROM film LIMIT 2"',
);
await run(
  'try sql bin form',
  'sql run pagila "SELECT title FROM film LIMIT 2"',
);
await run(
  'try with -- separator',
  'sql -- run pagila "SELECT title FROM film LIMIT 2"',
);

await os.dispose();
