import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [reportPath, ...testArguments] = process.argv.slice(2);

if (!reportPath) {
  throw new Error('A JUnit report path is required');
}

const report = resolve(reportPath);
await mkdir(dirname(report), { recursive: true });

const child = spawn(
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

child.once('error', (error) => {
  throw error;
});

const exitCode = await new Promise<number>((resolveExitCode) => {
  child.once('exit', (code, signal) => {
    resolveExitCode(code ?? (signal ? 1 : 0));
  });
});

process.exitCode = exitCode;
