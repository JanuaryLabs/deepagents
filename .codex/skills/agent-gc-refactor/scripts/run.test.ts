import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runAgentGcRefactor } from './run.ts';

const execFileAsync = promisify(execFile);

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd });
  return `${stdout}${stderr}`.trim();
}

async function initRepo(
  structure: (repoRoot: string) => void,
): Promise<{ root: string; baseSha: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-gc-refactor-'));

  mkdirSync(path.join(root, 'packages', 'agent', 'src'), { recursive: true });
  mkdirSync(path.join(root, 'packages', 'context', 'src'), { recursive: true });

  structure(root);

  await run('git', ['init'], root);
  await run('git', ['config', 'user.email', 'tests@example.com'], root);
  await run('git', ['config', 'user.name', 'Agent GC Tests'], root);
  await run('git', ['add', '.'], root);
  await run('git', ['commit', '-m', 'initial'], root);
  const baseSha = await run('git', ['rev-parse', 'HEAD'], root);

  return { root, baseSha };
}

test('on-demand run detects typing issues in changed file', async () => {
  const { root, baseSha } = await initRepo((repoRoot) => {
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      'export const value = 1;\n',
      'utf8',
    );
  });

  writeFileSync(
    path.join(root, 'packages', 'agent', 'src', 'index.ts'),
    'export const value = (1 as unknown);\n',
    'utf8',
  );
  await run('git', ['add', '.'], root);
  await run('git', ['commit', '-m', 'introduce any cast'], root);

  const report = await runAgentGcRefactor({
    cwd: root,
    mode: 'on-demand',
    base: baseSha.trim(),
    head: 'HEAD',
    apply: false,
    skipVerify: true,
    reportDir: path.join(root, 'artifacts', 'agent-gc-refactor', 'on-demand'),
  });

  assert.equal(report.mode, 'on-demand');
  assert.ok(report.findings.some((finding) => finding.category === 'typing'));
});

test('scheduled run can produce no findings on clean code', async () => {
  const { root } = await initRepo((repoRoot) => {
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      'export function safe() { return 1; }\n',
      'utf8',
    );
  });

  const report = await runAgentGcRefactor({
    cwd: root,
    mode: 'scheduled',
    apply: false,
    skipVerify: true,
    reportDir: path.join(
      root,
      'artifacts',
      'agent-gc-refactor',
      'scheduled-clean',
    ),
  });

  assert.equal(report.findings.length, 0);
  assert.equal(report.exitStatus, 'ok');
});

test('scheduled run emits batch summary with multiple principle findings', async () => {
  const { root } = await initRepo((repoRoot) => {
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      [
        "import { x } from '@deepagents/context';",
        'function sleep(ms: number) { return ms; }',
        'export const unsafe = (v: unknown) => JSON.parse(v as string);',
      ].join('\n') + '\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'other.ts'),
      'function sleep(ms: number) { return ms; }\n',
      'utf8',
    );
  });

  const reportDir = path.join(
    root,
    'artifacts',
    'agent-gc-refactor',
    'scheduled-multi',
  );
  const report = await runAgentGcRefactor({
    cwd: root,
    mode: 'scheduled',
    apply: false,
    skipVerify: true,
    reportDir,
  });

  assert.ok(
    report.findings.some((finding) => finding.category === 'boundaries'),
  );
  assert.ok(report.findings.some((finding) => finding.category === 'reuse'));
  assert.ok(report.findings.some((finding) => finding.category === 'typing'));

  const reportMd = readFileSync(path.join(reportDir, 'report.md'), 'utf8');
  assert.match(reportMd, /Batch PR Summary/);
});

test('autofix applies boundary and typing safe refactors', async () => {
  const { root } = await initRepo((repoRoot) => {
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      [
        "import { x } from '@deepagents/context';",
        'export const unsafe = (v: unknown) => (v as unknown);',
        'const map: Record<string, unknown> = {};',
      ].join('\n') + '\n',
      'utf8',
    );
  });

  const report = await runAgentGcRefactor({
    cwd: root,
    mode: 'scheduled',
    apply: true,
    skipVerify: true,
    reportDir: path.join(root, 'artifacts', 'agent-gc-refactor', 'autofix'),
  });

  const updated = readFileSync(
    path.join(root, 'packages', 'agent', 'src', 'index.ts'),
    'utf8',
  );
  assert.match(updated, /@deepagents\/context/);
  assert.doesNotMatch(updated, /@deepagents\/context\/src/);
  assert.doesNotMatch(updated, /as unknown/);
  assert.match(updated, /as unknown/);
  assert.match(updated, /Record<string, unknown>/);
  assert.ok(report.fixesApplied.length >= 3);
});
