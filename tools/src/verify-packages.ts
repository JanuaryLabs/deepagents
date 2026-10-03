import { buildSync } from 'esbuild';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const workspace = resolve(import.meta.dirname, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'deepagents-packages-'));
const packs = join(temporary, 'packs');
const consumer = join(temporary, 'consumer');
const environment = {
  ...process.env,
  npm_config_cache:
    process.env.npm_config_cache ?? join(temporary, 'npm-cache'),
};
mkdirSync(packs);
mkdirSync(consumer);

try {
  const packages = Array.from(
    globSync('packages/**/package.json', {
      cwd: workspace,
      exclude: ['**/node_modules/**', '**/dist/**'],
    }),
    (file) => ({
      directory: dirname(file),
      manifest: JSON.parse(readFileSync(join(workspace, file), 'utf8')),
    }),
  ).filter(({ manifest }) => !manifest.private);
  const dependencies: Record<string, string> = {};
  const imports: string[] = [];
  for (const { directory, manifest } of packages) {
    const raw = JSON.parse(
      execFileSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', packs],
        {
          cwd: join(workspace, directory),
          env: environment,
          encoding: 'utf8',
          timeout: 60_000,
        },
      ),
    );
    const packed = (Array.isArray(raw) ? raw : Object.values(raw))[0];
    const files = new Set<string>(
      packed.files.map((file: { path: string }) => file.path),
    );
    const checkTarget = (target: unknown): void => {
      if (typeof target === 'string') {
        assert.ok(
          target.startsWith('./'),
          `${manifest.name}: invalid export ${target}`,
        );
        if (!target.includes('*'))
          assert.ok(
            files.has(target.slice(2)),
            `${manifest.name}: missing packed export ${target}`,
          );
        else {
          const prefix = target.slice(2).split('*')[0];
          const declarations = [...files].filter(
            (file) => file.startsWith(prefix) && file.endsWith('.d.ts'),
          );
          assert.ok(
            declarations.length,
            `${manifest.name}: empty wildcard ${target}`,
          );
          for (const file of declarations)
            assert.ok(
              files.has(file.replace(/\.d\.ts$/, '.js')),
              `${manifest.name}: missing wildcard JavaScript for ${file}`,
            );
        }
      } else if (target && typeof target === 'object') {
        for (const value of Object.values(target)) checkTarget(value);
      }
    };
    checkTarget(manifest.exports);
    checkTarget(manifest.bin);
    for (const file of files)
      assert.ok(
        !/(?:\.(?:test|spec)\.|\.tsbuildinfo$|\/spec\/)/.test(file),
        `${manifest.name}: ships test/build state ${file}`,
      );
    const declared = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    for (const file of files) {
      if (!/\.(?:[cm]?js|d\.ts)$/.test(file) || file.startsWith('dist/ui/'))
        continue;
      const source = readFileSync(join(workspace, directory, file), 'utf8');
      for (const { fileName: specifier } of ts.preProcessFile(
        source,
        true,
        true,
      ).importedFiles) {
        if (
          specifier.startsWith('.') ||
          specifier.startsWith('#') ||
          isBuiltin(specifier)
        )
          continue;
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        const typesName = `@types/${name.replace(/^@/, '').replace('/', '__')}`;
        assert.ok(
          name === manifest.name ||
            declared[name] ||
            (file.endsWith('.d.ts') && declared[typesName]),
          `${manifest.name}: undeclared ${name} in ${file}`,
        );
      }
    }
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    })) {
      if (name.startsWith('@deepagents/')) {
        const dependency = packages.find(
          ({ manifest }) => manifest.name === name,
        );
        assert.ok(
          dependency,
          `${manifest.name}: non-public dependency ${name}`,
        );
        assert.equal(
          version,
          dependency.manifest.version,
          `${manifest.name}: stale ${name} version`,
        );
      }
    }
    dependencies[manifest.name] = `file:${join(packs, packed.filename)}`;
    for (const key of Object.keys(manifest.exports)) {
      if (key.includes('*') || key.endsWith('.json') || key.endsWith('.css'))
        continue;
      imports.push(manifest.name + (key === '.' ? '' : key.slice(1)));
    }
    console.log(`Packed ${manifest.name}: ${files.size} files`);
  }
  imports.push(
    '@deepagents/toolbox/filesystem.js',
    '@deepagents/orchestrator/deepplan/plan-and-solve.js',
  );
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'deepagents-packed-consumer',
      private: true,
      type: 'module',
      dependencies: {
        ...dependencies,
        '@electric-sql/pglite': '^0.5.4',
        '@duckdb/node-api': '^1.5.5-r.3',
        '@types/node': '^26.1.1',
        '@types/react': '19.2.18',
        '@types/react-dom': '19.2.5',
        ai: '7.0.85',
        react: '19.2.8',
        'react-dom': '19.2.8',
      },
    }),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: consumer,
      env: environment,
      stdio: 'inherit',
      timeout: 300_000,
    },
  );
  writeFileSync(
    join(consumer, 'imports.ts'),
    imports
      .map(
        (name, index) =>
          `import * as entry${index} from ${JSON.stringify(name)};`,
      )
      .join('\n'),
  );
  writeFileSync(
    join(consumer, 'consumer.test.ts'),
    readFileSync(join(workspace, 'tools/src/packed-consumer.test.ts.txt')),
  );
  // Browser consumers use bundler resolution; server entry points also support NodeNext.
  const nodeImports = imports.filter(
    (name) =>
      !name.startsWith('@deepagents/react-') &&
      name !== '@deepagents/devtool-history',
  );
  writeFileSync(
    join(consumer, 'node-imports.ts'),
    nodeImports
      .map(
        (name, index) =>
          `import * as entry${index} from ${JSON.stringify(name)};`,
      )
      .join('\n'),
  );
  for (const nodeNext of [false, true]) {
    const program = ts.createProgram(
      nodeNext
        ? [join(consumer, 'node-imports.ts')]
        : [join(consumer, 'imports.ts'), join(consumer, 'consumer.test.ts')],
      {
        target: ts.ScriptTarget.ESNext,
        module: nodeNext ? ts.ModuleKind.NodeNext : ts.ModuleKind.ESNext,
        moduleResolution: nodeNext
          ? ts.ModuleResolutionKind.NodeNext
          : ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['node'],
        typeRoots: [join(consumer, 'node_modules/@types')],
      },
    );
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => consumer,
        getNewLine: () => '\n',
      }),
    );
  }
  for (const conditions of [[], ['--conditions=development']]) {
    execFileSync(
      process.execPath,
      [...conditions, join(consumer, 'imports.ts')],
      { cwd: consumer, stdio: 'inherit', timeout: 60_000 },
    );
  }
  buildSync({
    stdin: {
      contents: [
        '@deepagents/context/browser',
        '@deepagents/elements',
        '@deepagents/react-genai',
        '@deepagents/react-input/browser',
        '@deepagents/react-formatters',
        '@deepagents/react-shadcn',
        '@deepagents/devtool-history',
      ]
        .map(
          (name, index) =>
            `import * as entry${index} from ${JSON.stringify(name)}; export { entry${index} };`,
        )
        .join('\n'),
      resolveDir: consumer,
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    outdir: join(temporary, 'browser'),
    logLevel: 'error',
  });
  execFileSync(
    process.execPath,
    ['--test', '--test-timeout=60000', join(consumer, 'consumer.test.ts')],
    { cwd: consumer, stdio: 'inherit', timeout: 90_000 },
  );
  execFileSync(join(consumer, 'node_modules/.bin/sql'), ['--help'], {
    cwd: consumer,
    stdio: 'inherit',
    timeout: 15_000,
  });
  console.log(
    `Verified ${packages.length} packed packages and ${imports.length} entry points.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
