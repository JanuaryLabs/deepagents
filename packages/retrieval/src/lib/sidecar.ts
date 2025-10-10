// import { existsSync } from 'node:fs';
// import { readFile } from 'node:fs/promises';
// import { cpus } from 'node:os';
// import { join, relative } from 'node:path';
// import { env, pipeline } from '@huggingface/transformers';
// import Conf from 'conf';
// import * as connectors from './connectors/index.js';
// import { findAllGitRepos } from './connectors/repo.js';
// import { huggingface } from './embedders/huggingface.js';
// import { type IngestionConfig, ingest, splitTypeScript } from './ingest.js';
// import { similaritySearch } from './similiarty-search.js';
// import { nodeSQLite } from './stores/sqlite/node-sqlite.js';
// /**
//  * Common programming language / source code file extensions(excluding config & docs);
//  */
// export const SOURCE_CODE_EXTENSIONS = [
//   // C / C++
//   '.c',
//   '.h',
//   '.cpp',
//   '.cc',
//   '.cxx',
//   '.hpp',
//   '.hh',
//   '.hxx',
//   // C#
//   '.cs',
//   // Go
//   '.go',
//   // Rust
//   '.rs',
//   // Java / Kotlin
//   '.java',
//   '.kt',
//   '.kts',
//   // Swift / Objective-C
//   '.swift',
//   '.m',
//   '.mm',
//   // D / Zig
//   '.d',
//   '.zig',
//   // Python / Ruby / Perl / PHP
//   '.py',
//   '.rb',
//   '.pl',
//   '.php',
//   // Lua
//   '.lua',
//   // Shell / PowerShell
//   '.sh',
//   '.bash',
//   '.ps1',
//   // R
//   '.r',
//   // JavaScript / TypeScript / Variants
//   '.js',
//   '.mjs',
//   '.cjs',
//   '.jsx',
//   '.js',
//   '.jsx',
//   // Framework single-file components
//   '.vue',
//   '.svelte',
//   // Styles (often processed, count as code)
//   '.css',
//   '.scss',
//   '.sass',
//   '.less',
//   '.styl',
//   // Functional / JVM ecosystem
//   '.hs',
//   '.scala',
//   '.clj',
//   '.cljs',
//   '.cljc',
//   '.ml',
//   '.mli',
//   '.fs',
//   '.fsx',
//   '.erl',
//   // Elixir
//   '.ex',
//   '.exs',
//   // Data/service interface code
//   '.sql',
//   '.proto',
//   '.thrift',
//   '.graphql',
//   '.gql',
//   // Dart
//   '.dart',
//   // Build / scripts
//   '.gradle',
//   '.gradle.kts',
//   '.cmake',
//   // Misc (Makefiles have no extension; omitted)
// ];
// const CPU_COUNT = Math.max(1, cpus().length);
// const DEFAULT_PARALLELISM = Math.min(4, CPU_COUNT);
// function arg(name: string, fallback?: string) {
//   const i = process.argv.indexOf(`--${name}`);
//   return i > -1 ? process.argv[i + 1] : fallback;
// }
// function pong(data: any) {
//   process.stdout.write(JSON.stringify(data) + '\n');
// }
// async function init() {
//   env.allowRemoteModels = false;
//   env.allowLocalModels = true;
//   const modelDir = arg('modelDir')!;
//   const ortDir = arg('ortDir')!;
//   const cacheDir = arg('cacheDir')!;
//   await ensureModelFolder(modelDir);
//   env.cacheDir = cacheDir;
//   // set(env.backends.onnx, 'wasm.wasmPaths', ortDir);
//   return { modelDir, ortDir };
// }
// const config = new Conf<{ ingestedDirs: { dir: string; updatedAt: string }[] }>(
//   { projectName: 'terminal' },
// );
// async function ensureModelFolder(modelDir: string) {
//   const required = ['config.json', 'tokenizer.json'];
//   for (const f of required) {
//     const p = join(modelDir, f);
//     if (!existsSync(p)) throw new Error(`Model file missing: ${p}`);
//   }
//   const onnx = join(modelDir, 'onnx');
//   if (!existsSync(onnx)) throw new Error(`Missing ONNX dir: ${onnx}`);
// }
// async function ping(
//   commandName: string,
//   generator: (pong: (data: any) => void) => AsyncGenerator<any, void, unknown>,
// ) {
//   const command = process.argv[2];
//   if (command === commandName) {
//     for await (const event of generator(pong)) {
//       pong(event);
//     }
//   }
// }
// ping('discover', async function* () {
//   yield { event: 'start' };
//   const repos = await Array.fromAsync(findAllGitRepos(process.env.HOME!));
//   const dirs: { dir: string; fileCount: number }[] = [];
//   for (const dir of repos) {
//     const fileCount = await Array.fromAsync(
//       await connectors.collectFiles(dir, SOURCE_CODE_EXTENSIONS),
//     ).then((files) => files.length);
//     yield { event: 'progress', data: { dir, fileCount } };
//     dirs.push({ dir, fileCount });
//   }
//   yield {
//     event: 'done',
//     data: dirs,
//   };
// });
// ping('search', async function* () {
//   yield { event: 'start' };
//   const query = arg('query')!;
//   const results = await similaritySearch(
//     query,
//     await ingestConfig(connectors.repo('', SOURCE_CODE_EXTENSIONS, 'never')),
//   );
//   yield {
//     event: 'done',
//     data: results.map((it) => ({
//       ...it,
//       displayName: fileDisplayName(it.document_id),
//     })),
//   };
// });
// function fileDisplayName(path: string) {
//   return '~/' + relative(process.env.HOME!, path);
// }
// ping('indexed_dirs', async function* () {
//   yield { event: 'start' };
//   yield { event: 'done', data: config.get('ingestedDirs', []) || [] };
// });
// ping('ingest', async function* (pong) {
//   const repo = arg('dir')!;
//   yield { event: 'start', data: repo };
//   await ingest(
//     await ingestConfig(connectors.repo(repo, SOURCE_CODE_EXTENSIONS, 'never')),
//     (id) => {
//       pong({ event: 'progress', data: id });
//     },
//   );
//   setIndexedDirs(repo);
//   yield { event: 'done' };
// });
// function setIndexedDirs(...dirs: string[]) {
//   const ingestedDirs = config.get('ingestedDirs', []);
//   dirs.forEach((it) =>
//     ingestedDirs.push({ dir: it, updatedAt: new Date().toISOString() }),
//   );
//   config.set('ingestedDirs', Array.from(new Set(ingestedDirs)));
// }
// ping('read_file', async function* () {
//   const filePath = arg('filePath')!;
//   yield { event: 'start', data: filePath };
//   const content = await readFile(filePath, 'utf-8');
//   yield {
//     event: 'done',
//     data: {
//       path: filePath,
//       content,
//       displayName: fileDisplayName(filePath),
//     },
//   };
// });
// ping('auto_index', async function* (pong) {
//   const repos = await Array.fromAsync(findAllGitRepos(process.env.HOME!));
//   yield { event: 'start', data: repos.length };
//   for (const repo of repos) {
//     await indexRepository(repo, pong);
//     setIndexedDirs(repo);
//   }
//   yield { event: 'done' };
// });
// ping('auto_index_parallelize', autoIndexParallelGenerator);
// async function indexRepository(repo: string, pong: (data: any) => void) {
//   pong({ event: 'indexing', data: { repo } });
//   await ingest(
//     await ingestConfig(connectors.repo(repo, SOURCE_CODE_EXTENSIONS, 'never')),
//     (id) => {
//       pong({
//         event: 'progress',
//         data: {
//           repo,
//           fileName: fileDisplayName(id),
//         },
//       });
//     },
//   );
//   pong({ event: 'indexed', data: { repo } });
// }
// async function* autoIndexParallelGenerator(pong: (data: any) => void) {
//   const repos = await Array.fromAsync(findAllGitRepos(process.env.HOME!));
//   yield { event: 'start', data: repos.length };
//   if (!repos.length) {
//     yield { event: 'done' };
//     return;
//   }
//   const queue = [...repos];
//   const completed: string[] = [];
//   const workerCount = resolveConcurrency(queue.length);
//   let error: unknown;
//   try {
//     await Promise.all(
//       Array.from({ length: workerCount }, async () => {
//         while (true) {
//           const repo = queue.shift();
//           if (!repo) break;
//           try {
//             await indexRepository(repo, pong);
//             completed.push(repo);
//           } catch (err) {
//             queue.length = 0;
//             throw err;
//           }
//         }
//       }),
//     );
//   } catch (err) {
//     error = err;
//   } finally {
//     if (completed.length) {
//       setIndexedDirs(...completed);
//     }
//   }
//   if (error) throw error;
//   yield { event: 'done' };
// }
// function resolveConcurrency(total: number) {
//   const concurrencyArg = arg('concurrency');
//   const parsed = concurrencyArg ? Number.parseInt(concurrencyArg, 10) : NaN;
//   if (!Number.isNaN(parsed) && parsed > 0) {
//     return Math.min(Math.max(parsed, 1), total);
//   }
//   return Math.min(Math.max(DEFAULT_PARALLELISM, 1), total);
// }
// async function ingestConfig(
//   connector: connectors.Connector,
// ): Promise<IngestionConfig> {
//   const { modelDir } = await init();
//   const extractor = await pipeline('feature-extraction', modelDir, {
//     dtype: 'q8',
//     local_files_only: true,
//   });
//   const hf = huggingface(() => extractor);
//   // Adapter to ensure embeddings are plain number[] for downstream types
//   const embedderAdapter = async (documents: string[]) => {
//     const { embeddings, dimensions } = await hf(documents);
//     return {
//       dimensions,
//       embeddings: embeddings.map((e) =>
//         Array.isArray(e) ? e : Array.from(e as Float32Array),
//       ),
//     };
//   };
//   return {
//     connector: connector,
//     store: nodeSQLite(384),
//     splitter: splitTypeScript,
//     embedder: embedderAdapter,
//   };
// }
