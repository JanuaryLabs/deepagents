import { loadSpec } from '@sdk-it/spec';
import { generate } from '@sdk-it/typescript';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const output = fileURLToPath(new URL('../../.evals-sdk-it/', import.meta.url));
const openapi = fileURLToPath(
  new URL('../../.evals-sdk-it/openapi.json', import.meta.url),
);

await Promise.all(
  ['dist', 'package.json', 'tsconfig.json'].map((file) =>
    rm(new URL(`../../.evals-sdk-it/${file}`, import.meta.url), {
      force: true,
      recursive: true,
    }),
  ),
);
await generate(await loadSpec(openapi), {
  mode: 'full',
  output,
  packageName: '@evals/client',
  readme: false,
  pagination: false,
});

await execFileAsync(process.execPath, [
  fileURLToPath(
    new URL('../../node_modules/typescript/bin/tsc', import.meta.url),
  ),
  '--ignoreConfig',
  '--declaration',
  '--emitDeclarationOnly',
  '--outDir',
  fileURLToPath(new URL('../../.evals-sdk-it/dist', import.meta.url)),
  '--rootDir',
  fileURLToPath(new URL('../../.evals-sdk-it/src', import.meta.url)),
  '--module',
  'ESNext',
  '--moduleResolution',
  'bundler',
  '--target',
  'ESNext',
  '--allowImportingTsExtensions',
  '--skipLibCheck',
  fileURLToPath(new URL('../../.evals-sdk-it/src/index.ts', import.meta.url)),
]);
