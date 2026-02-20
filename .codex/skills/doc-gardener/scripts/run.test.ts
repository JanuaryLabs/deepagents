import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runDocGardener } from './run.ts';

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
  const root = mkdtempSync(path.join(tmpdir(), 'doc-gardener-'));

  mkdirSync(path.join(root, 'apps', 'docs', 'app', 'docs', 'agent'), {
    recursive: true,
  });
  mkdirSync(path.join(root, 'packages', 'agent', 'src'), { recursive: true });

  writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n', 'utf8');
  writeFileSync(path.join(root, 'README.md'), '# Root\n', 'utf8');

  structure(root);

  await run('git', ['init'], root);
  await run('git', ['config', 'user.email', 'tests@example.com'], root);
  await run('git', ['config', 'user.name', 'Doc Gardener Tests'], root);
  await run('git', ['add', '.'], root);
  await run('git', ['commit', '-m', 'initial'], root);
  const baseSha = await run('git', ['rev-parse', 'HEAD'], root);

  return { root, baseSha };
}

test('on-demand run detects API drift on changed package', async () => {
  const { root, baseSha } = await initRepo((repoRoot) => {
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      'export function knownExport() { return 1; }\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'README.md'),
      '# agent\nknownExport\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'index.mdx'),
      '# Agent\nknownExport\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'meta.json'),
      JSON.stringify({ title: 'Agent', pages: ['index'] }, null, 2),
      'utf8',
    );
  });

  writeFileSync(
    path.join(root, 'packages', 'agent', 'src', 'index.ts'),
    'export function knownExport() { return 1; }\nexport function newExport() { return 2; }\n',
    'utf8',
  );
  await run('git', ['add', '.'], root);
  await run('git', ['commit', '-m', 'add new export'], root);

  const report = await runDocGardener({
    cwd: root,
    mode: 'on-demand',
    base: baseSha.trim(),
    head: 'HEAD',
    apply: false,
    skipVerify: true,
    reportDir: path.join(root, 'artifacts', 'doc-gardener', 'on-demand'),
  });

  assert.equal(report.mode, 'on-demand');
  assert.ok(
    report.findings.some((finding) => finding.category === 'api-drift'),
  );
  assert.equal(
    existsSync(
      path.join(root, 'artifacts', 'doc-gardener', 'on-demand', 'report.json'),
    ),
    true,
  );
});

test('scheduled run with clean docs can produce no-op success', async () => {
  const { root } = await initRepo((repoRoot) => {
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      'export function knownExport() { return 1; }\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'README.md'),
      '# agent\nknownExport\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'index.mdx'),
      '# Agent\nknownExport\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'meta.json'),
      JSON.stringify({ title: 'Agent', pages: ['index'] }, null, 2),
      'utf8',
    );
  });

  const report = await runDocGardener({
    cwd: root,
    mode: 'scheduled',
    apply: false,
    skipVerify: true,
    reportDir: path.join(root, 'artifacts', 'doc-gardener', 'scheduled-clean'),
  });

  assert.equal(report.exitStatus, 'ok');
  assert.equal(report.findings.length, 0);
  assert.equal(report.unresolved.length, 0);
});

test('scheduled run emits batch PR summary for multiple findings', async () => {
  const { root } = await initRepo((repoRoot) => {
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      'export function knownExport() { return 1; }\nexport function missingExport() { return 1; }\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'README.md'),
      '# agent\nknownExport\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'index.mdx'),
      '# Agent\nknownExport\n[Broken](/docs/agent/does-not-exist)\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'meta.json'),
      JSON.stringify({ title: 'Agent', pages: ['index'] }, null, 2),
      'utf8',
    );
  });

  const reportDir = path.join(
    root,
    'artifacts',
    'doc-gardener',
    'scheduled-multi',
  );
  const report = await runDocGardener({
    cwd: root,
    mode: 'scheduled',
    apply: false,
    skipVerify: true,
    reportDir,
  });

  assert.ok(report.findings.length >= 2);
  const md = readFileSync(path.join(reportDir, 'report.md'), 'utf8');
  assert.match(md, /Batch PR Summary/);
  assert.match(md, /agent:/);
});

test('autofix corrects meta drift and broken links', async () => {
  const { root } = await initRepo((repoRoot) => {
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      'export function knownExport() { return 1; }\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'README.md'),
      '# agent\nknownExport\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'index.mdx'),
      '# Agent\n[Readme](./guide)\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'guide.mdx'),
      '# Guide\nDetails\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'meta.json'),
      JSON.stringify(
        { title: 'Agent', pages: ['index', 'missing-page'] },
        null,
        2,
      ),
      'utf8',
    );
  });

  const report = await runDocGardener({
    cwd: root,
    mode: 'scheduled',
    apply: true,
    skipVerify: true,
    reportDir: path.join(root, 'artifacts', 'doc-gardener', 'autofix'),
  });

  const meta = JSON.parse(
    readFileSync(
      path.join(root, 'apps', 'docs', 'app', 'docs', 'agent', 'meta.json'),
      'utf8',
    ),
  ) as {
    pages: string[];
  };
  const indexContent = readFileSync(
    path.join(root, 'apps', 'docs', 'app', 'docs', 'agent', 'index.mdx'),
    'utf8',
  );

  assert.ok(meta.pages.includes('guide'));
  assert.ok(!meta.pages.includes('missing-page'));
  assert.match(indexContent, /\[Readme\]\(\.\/guide\.mdx\)/);
  assert.ok(report.fixesApplied.length >= 2);
});

test('autofix preserves sectioned meta ordering and directory pages', async () => {
  const { root } = await initRepo((repoRoot) => {
    mkdirSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'recipes'),
      { recursive: true },
    );
    mkdirSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'orchestrator'),
      { recursive: true },
    );

    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'src', 'index.ts'),
      'export function knownExport() { return 1; }\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'packages', 'agent', 'README.md'),
      '# agent\nknownExport\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'index.mdx'),
      '# Agent\n',
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'guide.mdx'),
      '# Guide\n',
      'utf8',
    );
    writeFileSync(
      path.join(
        repoRoot,
        'apps',
        'docs',
        'app',
        'docs',
        'agent',
        'recipes',
        'index.mdx',
      ),
      '# Recipes\n',
      'utf8',
    );
    writeFileSync(
      path.join(
        repoRoot,
        'apps',
        'docs',
        'app',
        'docs',
        'orchestrator',
        'index.mdx',
      ),
      '# Orchestrator\n',
      'utf8',
    );

    writeFileSync(
      path.join(repoRoot, 'apps', 'docs', 'app', 'docs', 'agent', 'meta.json'),
      JSON.stringify(
        {
          title: 'Agent',
          pages: [
            'index',
            '---Guides---',
            'guide',
            '---Recipes---',
            'recipes',
            'missing-page',
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    writeFileSync(
      path.join(
        repoRoot,
        'apps',
        'docs',
        'app',
        'docs',
        'orchestrator',
        'meta.json',
      ),
      JSON.stringify(
        {
          title: 'Orchestrator',
          root: true,
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  const report = await runDocGardener({
    cwd: root,
    mode: 'scheduled',
    apply: true,
    skipVerify: true,
    reportDir: path.join(root, 'artifacts', 'doc-gardener', 'sectioned-meta'),
  });

  const agentMeta = JSON.parse(
    readFileSync(
      path.join(root, 'apps', 'docs', 'app', 'docs', 'agent', 'meta.json'),
      'utf8',
    ),
  ) as {
    pages: string[];
  };
  const orchestratorMeta = JSON.parse(
    readFileSync(
      path.join(
        root,
        'apps',
        'docs',
        'app',
        'docs',
        'orchestrator',
        'meta.json',
      ),
      'utf8',
    ),
  ) as {
    title: string;
    root: boolean;
    pages?: string[];
  };

  assert.equal(report.exitStatus, 'ok');
  assert.equal(report.unresolved.length, 0);
  assert.deepEqual(agentMeta.pages, [
    'index',
    '---Guides---',
    'guide',
    '---Recipes---',
    'recipes',
  ]);
  assert.equal(orchestratorMeta.pages, undefined);
});
