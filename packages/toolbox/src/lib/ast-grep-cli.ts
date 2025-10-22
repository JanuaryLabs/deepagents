// import { tool } from 'ai';
// import path from 'node:path';
// import { promises as fs } from 'node:fs';
// import { spawn } from 'node:child_process';
// import { createRequire } from 'node:module';
// import { z } from 'zod';

// const DEFAULT_MAX_RESULTS = 50;
// const DEFAULT_CONTEXT_LINES = 2;

// type LanguageSpec = string | { language: string; globs?: string[] };
// type NormalizedRange = {
//   start: { line: number; column: number };
//   end: { line: number; column: number };
// };

// interface CliRawMatch {
//   absolutePath: string;
//   relativePath: string;
//   language: string;
//   range: NormalizedRange;
//   snippet?: string;
//   lines?: string;
// }

// interface MatchContext {
//   startLine: number;
//   code: string;
//   highlight: {
//     startLineOffset: number;
//     endLineOffset: number;
//   };
// }

// interface MatchResult {
//   file: string;
//   language: string;
//   range: NormalizedRange;
//   snippet?: string;
//   context?: MatchContext;
//   previewLine?: string;
// }

// const languageSpecSchema: z.ZodType<LanguageSpec> = z.union([
//   z.string().min(1),
//   z.object({
//     language: z.string().min(1),
//     globs: z.array(z.string().min(1)).optional(),
//   }),
// ]);

// const noIgnoreOptions = z.enum([
//   'hidden',
//   'dot',
//   'exclude',
//   'global',
//   'parent',
//   'vcs',
// ]);

// const strictnessOptions = z.enum([
//   'cst',
//   'smart',
//   'ast',
//   'relaxed',
//   'signature',
//   'template',
// ]);

// export const astGrepCliInputSchema = z
//   .object({
//     pattern: z.string().min(1).optional(),
//     selector: z.string().min(1).optional(),
//     strictness: strictnessOptions.optional(),
//     language: z.string().min(1).optional(),
//     languages: z
//       .array(languageSpecSchema)
//       .min(1)
//       .optional(),
//     languageGlobs: z.array(z.string().min(1)).optional(),
//     globs: z.array(z.string().min(1)).optional(),
//     paths: z.array(z.string().min(1)).default(['.']),
//     root: z.string().min(1).optional(),
//     followSymlinks: z.boolean().default(false),
//     noIgnore: z.array(noIgnoreOptions).default([]),
//     threads: z.number().int().min(0).max(64).optional(),
//     contextLines: z.number().int().min(0).max(20).default(DEFAULT_CONTEXT_LINES),
//     includeSnippet: z.boolean().default(true),
//     maxResults: z
//       .number()
//       .int()
//       .min(1)
//       .max(200)
//       .default(DEFAULT_MAX_RESULTS),
//   })
//   .superRefine((value, ctx) => {
//     const languages: LanguageSpec[] = [];
//     if (value.languages?.length) {
//       languages.push(...value.languages);
//     }
//     if (value.language) {
//       languages.push(value.language);
//     }
//     if (!languages.length) {
//       ctx.addIssue({
//         code: z.ZodIssueCode.custom,
//         message: 'Provide `language` or `languages` to select an ast-grep parser.',
//         path: ['language'],
//       });
//     }

//     if (!value.pattern) {
//       ctx.addIssue({
//         code: z.ZodIssueCode.custom,
//         message: 'Provide a `pattern` to search for.',
//         path: ['pattern'],
//       });
//     }
//   });

// type AstGrepCliInput = z.infer<typeof astGrepCliInputSchema>;

// export const ast_grep_cli = tool({
//   name: 'ast_grep_cli',
//   description:
//     'Run ast-grep CLI searches. Supply a structural pattern, language, and paths to inspect. Returns JSON-formatted matches.',
//   inputSchema: astGrepCliInputSchema,
//   execute: async (input) => {
//     const root = resolveRoot(input.root);
//     const targetPaths = await resolvePaths(root, input.paths);
//     const languageSpecs = normalizeLanguageSpecs(input);
//     const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
//     const includeSnippet = input.includeSnippet ?? true;
//     const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES;
//     const fileCache = new Map<string, string[]>();

//     const rawMatches: CliRawMatch[] = [];
//     let totalMatches = 0;

//     const binary = await getAstGrepBinary();

//     for (const spec of languageSpecs) {
//       const { matches, total } = await runAstGrepCliForLanguage({
//         binary,
//         input,
//         language: spec.language,
//         languageGlobs: spec.globs,
//         root,
//         paths: targetPaths,
//         maxCollect: Math.max(0, maxResults - rawMatches.length),
//       });

//       rawMatches.push(...matches.slice(0, Math.max(0, maxResults - rawMatches.length)));
//       totalMatches += total;
//     }

//     const matches: MatchResult[] = [];
//     for (const match of rawMatches.slice(0, maxResults)) {
//       const context = await buildContext(
//         match.absolutePath,
//         match.range,
//         contextLines,
//         fileCache,
//       );
//       matches.push({
//         file: match.relativePath,
//         language: match.language,
//         range: match.range,
//         snippet: includeSnippet ? match.snippet : undefined,
//         context,
//         previewLine: match.lines,
//       });
//     }

//     return {
//       totalMatches,
//       returned: matches.length,
//       truncated: totalMatches > matches.length,
//       matches,
//     };
//   },
// });

// interface RunCliOptions {
//   binary: string;
//   input: AstGrepCliInput;
//   language: string;
//   languageGlobs?: string[];
//   root: string;
//   paths: string[];
//   maxCollect: number;
// }

// async function runAstGrepCliForLanguage(options: RunCliOptions) {
//   const {
//     binary,
//     input,
//     language,
//     languageGlobs,
//     root,
//     paths,
//     maxCollect,
//   } = options;

//   const args = buildCliArgs({
//     input,
//     language,
//     languageGlobs,
//     paths,
//     root,
//   });

//   const collected: CliRawMatch[] = [];
//   let total = 0;
//   let stdoutBuffer = '';
//   let stderrBuffer = '';

//   await new Promise<void>((resolve, reject) => {
//     const proc = spawn(binary, args, {
//       cwd: root,
//       stdio: ['ignore', 'pipe', 'pipe'],
//       env: { ...process.env, NO_COLOR: '1' },
//     });

//     proc.stdout.on('data', (chunk: Buffer) => {
//       stdoutBuffer += chunk.toString();
//       let newlineIndex: number;
//       while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
//         const line = stdoutBuffer.slice(0, newlineIndex).trim();
//         stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
//         if (!line) continue;
//         try {
//           const parsed = JSON.parse(line) as CliMatchPayload;
//           total += 1;
//           if (collected.length < maxCollect) {
//             const normalized = normalizeCliMatch(parsed, language, root);
//             collected.push(normalized);
//           }
//         } catch (err) {
//           reject(
//             new Error(
//               `Failed to parse ast-grep JSON output: ${(err as Error).message}. Line content: ${line}`,
//             ),
//           );
//           proc.kill();
//           return;
//         }
//       }
//     });

//     proc.stderr.on('data', (chunk: Buffer) => {
//       stderrBuffer += chunk.toString();
//     });

//     proc.on('error', (err) => reject(err));

//     proc.on('close', (code) => {
//       if (stdoutBuffer.trim().length) {
//         try {
//           const parsed = JSON.parse(stdoutBuffer.trim()) as CliMatchPayload;
//           total += 1;
//           if (collected.length < maxCollect) {
//             const normalized = normalizeCliMatch(parsed, language, root);
//             collected.push(normalized);
//           }
//         } catch (err) {
//           reject(
//             new Error(
//               `Failed to parse final ast-grep JSON output: ${
//                 (err as Error).message
//               }. Line content: ${stdoutBuffer.trim()}`,
//             ),
//           );
//           return;
//         }
//       }

//       if (code && code !== 0) {
//         reject(
//           new Error(
//             stderrBuffer
//               ? `ast-grep exited with code ${code}: ${stderrBuffer.trim()}`
//               : `ast-grep exited with code ${code}`,
//           ),
//         );
//         return;
//       }

//       if (stderrBuffer.trim().length) {
//         reject(new Error(stderrBuffer.trim()));
//         return;
//       }

//       resolve();
//     });
//   });

//   return { matches: collected, total };
// }

// interface CliMatchPayload {
//   text?: string;
//   file: string;
//   language?: string;
//   lines?: string;
//   range: {
//     start: { line: number; column: number };
//     end: { line: number; column: number };
//   };
// }

// function normalizeCliMatch(match: CliMatchPayload, fallbackLanguage: string, root: string) {
//   const filename = match.file;
//   const absolute = path.isAbsolute(filename) ? filename : path.resolve(root, filename);
//   const relative = path.relative(root, absolute) || path.basename(absolute);

//   return {
//     absolutePath: absolute,
//     relativePath: relative,
//     language: match.language ?? fallbackLanguage,
//     range: toNormalizedRange(match.range),
//     snippet: match.text,
//     lines: match.lines,
//   };
// }

// function buildCliArgs({
//   input,
//   language,
//   languageGlobs,
//   paths,
//   root,
// }: {
//   input: AstGrepCliInput;
//   language: string;
//   languageGlobs?: string[];
//   paths: string[];
//   root: string;
// }) {
//   const pattern = input.pattern;
//   if (!pattern) {
//     throw new Error('ast-grep CLI requires a pattern to execute.');
//   }

//   const langArg = language.trim();

//   const args: string[] = [
//     'run',
//     '--pattern',
//     pattern,
//     '--lang',
//     langArg,
//     '--json=stream',
//     '--color=never',
//   ];

//   if (input.selector) {
//     args.push('--selector', input.selector);
//   }
//   if (input.strictness) {
//     args.push('--strictness', input.strictness);
//   }
//   if (input.followSymlinks) {
//     args.push('--follow');
//   }
//   if (input.threads && input.threads > 0) {
//     args.push('--threads', String(input.threads));
//   }

//   const globs = dedupeStrings([
//     ...(input.globs ?? []),
//     ...(input.languageGlobs ?? []),
//     ...(languageGlobs ?? []),
//   ]);

//   for (const glob of globs) {
//     args.push('--globs', glob);
//   }

//   for (const option of input.noIgnore ?? []) {
//     args.push('--no-ignore', option);
//   }

//   const relativePaths = paths.map((absolute) => {
//     const relative = path.relative(root, absolute);
//     if (!relative || relative === '') {
//       return '.';
//     }
//     return relative.startsWith('..') ? absolute : relative;
//   });

//   if (!relativePaths.length) {
//     relativePaths.push('.');
//   }

//   args.push(...relativePaths);

//   return args;
// }

// async function getAstGrepBinary() {
//   if (cachedBinaryPath) {
//     return cachedBinaryPath;
//   }

//   const require = createRequire(import.meta.url);
//   const pkgPath = require.resolve('@ast-grep/cli/package.json');
//   const dir = path.dirname(pkgPath);
//   const candidates = ['ast-grep', 'ast-grep.exe', 'ast-grep.cmd', 'sg'];

//   for (const candidate of candidates) {
//     const candidatePath = path.join(dir, candidate);
//     try {
//       await fs.access(candidatePath);
//       cachedBinaryPath = candidatePath;
//       return candidatePath;
//     } catch {
//       continue;
//     }
//   }

//   throw new Error('Unable to locate ast-grep CLI binary. Ensure @ast-grep/cli is installed.');
// }

// let cachedBinaryPath: string | null = null;

// function resolveRoot(root?: string) {
//   if (!root) {
//     return process.cwd();
//   }
//   return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
// }

// async function resolvePaths(root: string, paths: string[]) {
//   const resolved: string[] = [];
//   const missing: string[] = [];

//   for (const entry of paths) {
//     const candidate = entry.trim();
//     if (!candidate) continue;
//     const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
//     try {
//       await fs.access(absolute);
//       resolved.push(absolute);
//     } catch {
//       missing.push(candidate);
//     }
//   }

//   if (!resolved.length) {
//     throw new Error(
//       `No valid search paths found. Verified paths: ${paths.join(', ') || '(none)'}`,
//     );
//   }

//   if (missing.length) {
//     throw new Error(
//       `The following search paths could not be accessed: ${missing.join(', ')}`,
//     );
//   }

//   return resolved;
// }

// function normalizeLanguageSpecs(input: AstGrepCliInput) {
//   const specs: Array<{ language: string; globs?: string[] }> = [];

//   if (input.languages?.length) {
//     for (const spec of input.languages) {
//       if (typeof spec === 'string') {
//         specs.push({ language: spec });
//       } else {
//         specs.push({
//           language: spec.language,
//           globs: spec.globs,
//         });
//       }
//     }
//   }

//   if (input.language) {
//     specs.push({
//       language: input.language,
//       globs: input.languageGlobs,
//     });
//   }

//   const seen = new Map<string, { language: string; globs?: string[] }>();
//   for (const spec of specs) {
//     const key = `${spec.language}::${(spec.globs ?? []).join(',')}`;
//     if (!seen.has(key)) {
//       seen.set(key, spec);
//     }
//   }

//   if (!seen.size) {
//     throw new Error('No target languages provided to ast-grep CLI tool.');
//   }

//   return Array.from(seen.values());
// }

// async function buildContext(
//   absolutePath: string,
//   range: NormalizedRange,
//   contextLines: number,
//   cache: Map<string, string[]>,
// ): Promise<MatchContext | undefined> {
//   if (contextLines <= 0) {
//     return undefined;
//   }

//   const lines = await getFileLines(absolutePath, cache);
//   const startIndex = Math.max(0, range.start.line - 1 - contextLines);
//   const endIndex = Math.min(lines.length - 1, range.end.line - 1 + contextLines);
//   const code = lines.slice(startIndex, endIndex + 1);

//   return {
//     startLine: startIndex + 1,
//     code: code.join('\n'),
//     highlight: {
//       startLineOffset: range.start.line - 1 - startIndex,
//       endLineOffset: range.end.line - 1 - startIndex,
//     },
//   };
// }

// async function getFileLines(absolutePath: string, cache: Map<string, string[]>) {
//   const cached = cache.get(absolutePath);
//   if (cached) {
//     return cached;
//   }
//   const content = await fs.readFile(absolutePath, 'utf8');
//   const lines = content.split(/\r?\n/);
//   cache.set(absolutePath, lines);
//   return lines;
// }

// function toNormalizedRange(range: { start: { line: number; column: number }; end: { line: number; column: number } }) {
//   return {
//     start: {
//       line: range.start.line + 1,
//       column: range.start.column + 1,
//     },
//     end: {
//       line: range.end.line + 1,
//       column: range.end.column + 1,
//     },
//   };
// }

// function dedupeStrings(values: string[]) {
//   const seen = new Set<string>();
//   const result: string[] = [];
//   for (const value of values) {
//     if (!seen.has(value)) {
//       seen.add(value);
//       result.push(value);
//     }
//   }
//   return result;
// }
