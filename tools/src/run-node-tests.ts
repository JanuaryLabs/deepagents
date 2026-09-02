import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [reportPath, ...testArguments] = process.argv.slice(2);

if (!reportPath) {
  throw new Error('A JUnit report path is required');
}

const report = resolve(reportPath);
mkdirSync(dirname(report), { recursive: true });

const child = spawnSync(
  process.execPath,
  [
    '--test',
    '--no-warnings',
    '--test-reporter=spec',
    '--test-reporter=junit',
    '--test-reporter-destination=stdout',
    `--test-reporter-destination=${report}`,
    ...testArguments,
  ],
  { stdio: 'inherit' },
);

if (child.error) throw child.error;

process.exitCode = child.status ?? (child.signal ? 1 : 0);
