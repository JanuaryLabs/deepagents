// import {
//   Lang,
//   type NapiConfig,
//   type Range,
//   type Rule,
//   type SgNode,
//   findInFiles,
// } from '@ast-grep/napi';
// import { tool } from 'ai';
// import { promises as fs } from 'node:fs';
// import path from 'node:path';
// import { z } from 'zod';

// const DEFAULT_MAX_RESULTS = 50;
// const DEFAULT_CONTEXT_LINES = 2;

// type MatcherLike = string | Record<string, unknown>;
// type LanguageSpec = string | { language: string; globs?: string[] };
// type NormalizedRange = {
//   start: { line: number; column: number };
//   end: { line: number; column: number };
// };

// interface RawMatch {
//   absolutePath: string;
//   relativePath: string;
//   language: string;
//   snippet?: string;
//   range: NormalizedRange;
//   captures?: Record<string, string | string[]>;
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
//   range: {
//     start: { line: number; column: number };
//     end: { line: number; column: number };
//   };
//   snippet?: string;
//   captures?: Record<string, string | string[]>;
//   context?: MatchContext;
// }

// const matcherLikeSchema = z.union([
//   z.string().min(1),
//   z.record(z.string(), z.unknown()),
// ]);

// const languageSpecSchema: z.ZodType<LanguageSpec> = z.union([
//   z.string().min(1),
//   z.object({
//     language: z.string().min(1),
//     globs: z.array(z.string().min(1)).optional(),
//   }),
// ]);

// export const astGrepInputSchema = z
//   .object({
//     pattern: z.string().min(1).optional(),
//     rule: matcherLikeSchema.optional(),
//     matcher: matcherLikeSchema.optional(),
//     kind: z.string().min(1).optional(),
//     regex: z.string().min(1).optional(),
//     strictness: z
//       .enum(['cst', 'smart', 'ast', 'relaxed', 'signature'])
//       .optional(),
//     constraints: z.record(z.string(), z.unknown()).optional(),
//     utils: z.record(z.string(), z.unknown()).optional(),
//     language: z.string().min(1).optional(),
//     languages: z.array(languageSpecSchema).min(1).optional(),
//     languageGlobs: z.array(z.string().min(1)).optional(),
//     paths: z.array(z.string().min(1)).default(['.']),
//     root: z.string().min(1).optional(),
//     captures: z.array(z.string().min(1)).default([]),
//     contextLines: z
//       .number()
//       .int()
//       .min(0)
//       .max(20)
//       .default(DEFAULT_CONTEXT_LINES),
//     includeSnippet: z.boolean().default(true),
//     maxResults: z.number().int().min(1).max(200).default(DEFAULT_MAX_RESULTS),
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
//         message:
//           'Provide `language` or `languages` so ast-grep knows which parser to use.',
//         path: ['language'],
//       });
//     }

//     const hasRule =
//       Boolean(value.pattern) ||
//       Boolean(value.rule) ||
//       Boolean(value.matcher) ||
//       Boolean(value.regex) ||
//       Boolean(value.kind);
//     if (!hasRule) {
//       ctx.addIssue({
//         code: z.ZodIssueCode.custom,
//         message:
//           'Provide at least one rule definition via `pattern`, `rule`, `matcher`, `regex`, or `kind`.',
//         path: ['pattern'],
//       });
//     }
//   });

// type AstGrepInput = z.infer<typeof astGrepInputSchema>;

// export const ast_grep = tool({
//   name: 'ast_grep',
//   description:
//     'Perform structural AST searches using ast-grep patterns. Provide a pattern or rule plus target language(s) and file paths.',
//   inputSchema: astGrepInputSchema,
//   execute: async (input) => {
//     const root = resolveRoot(input.root);
//     const targetPaths = await resolvePaths(root, input.paths);
//     const languages = normalizeLanguageSpecs(input);
//     const matcherConfig = buildMatcherConfig(input);
//     const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;

//     const fileCache = new Map<string, string[]>();
//     const rawMatches: RawMatch[] = [];
//     let totalMatches = 0;

//     for (const target of languages) {
//       const { language, globs } = target;
//       const lang = resolveLanguage(language);
//       const matcher = cloneMatcher(matcherConfig);
//       if (!matcher.language) {
//         matcher.language = language;
//       }

//       const config = buildFindConfig(
//         targetPaths,
//         matcher,
//         globs ?? input.languageGlobs,
//       );

//       await findInFiles(lang, config, (err, nodes) => {
//         if (err) throw err;

//         for (const node of nodes) {
//           totalMatches += 1;
//           if (rawMatches.length >= maxResults) {
//             continue;
//           }

//           const filename = node.getRoot().filename();
//           const absolutePath = path.isAbsolute(filename)
//             ? filename
//             : path.resolve(root, filename);
//           const relativePath =
//             path.relative(root, absolutePath) || path.basename(absolutePath);
//           const range = extractRange(node.range());
//           const snippet = input.includeSnippet ? node.text() : undefined;
//           const captures = collectCaptures(node, input.captures);

//           rawMatches.push({
//             absolutePath,
//             relativePath,
//             language,
//             range,
//             snippet,
//             captures: Object.keys(captures).length > 0 ? captures : undefined,
//           });
//         }
//       });
//     }

//     const matches: MatchResult[] = [];
//     for (const match of rawMatches) {
//       const context = await buildContext(
//         match.absolutePath,
//         match.range,
//         input.contextLines,
//         fileCache,
//       );
//       matches.push({
//         file: match.relativePath,
//         language: match.language,
//         range: match.range,
//         snippet: match.snippet,
//         captures: match.captures,
//         context,
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
//     const absolute = path.isAbsolute(candidate)
//       ? candidate
//       : path.resolve(root, candidate);
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

// function normalizeLanguageSpecs(input: AstGrepInput) {
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

//   return Array.from(seen.values());
// }

// function buildMatcherConfig(input: AstGrepInput): NapiConfig {
//   let base: NapiConfig | undefined;

//   if (typeof input.matcher !== 'undefined') {
//     base = normalizeMatcherLike(input.matcher);
//   } else if (typeof input.rule !== 'undefined') {
//     base = normalizeMatcherLike(input.rule);
//   }

//   if (!base) {
//     base = { rule: {} };
//   }

//   const rule: Rule = { ...(base.rule ?? {}), ...input } as Rule;

//   if (!Object.keys(rule).length) {
//     throw new Error(
//       'Ast-grep matcher requires at least one rule attribute (pattern, kind, regex, etc).',
//     );
//   }

//   let result: NapiConfig = {
//     ...base,
//     rule,
//   };

//   if (input.constraints) {
//     result = {
//       ...result,
//       constraints: { ...result.constraints, ...input.constraints },
//     };
//   }
//   if (input.utils) {
//     result = {
//       ...result,
//       utils: { ...result.utils, ...input.utils },
//     };
//   }

//   if ('transform' in result) {
//     const { transform, ...rest } = result as NapiConfig & {
//       transform?: unknown;
//     };
//     result = rest;
//   }

//   return result;
// }

// function normalizeMatcherLike(source: MatcherLike): NapiConfig {
//   if (typeof source === 'string') {
//     return { rule: { pattern: source } };
//   }
//   if (isNapiConfig(source)) {
//     return {
//       ...source,
//       rule: { ...(source.rule ?? {}) },
//     };
//   }
//   return { rule: { ...source } };
// }

// function buildFindConfig(
//   paths: string[],
//   matcher: NapiConfig,
//   languageGlobs?: string[],
// ) {
//   const config: Parameters<typeof findInFiles>[1] = {
//     paths,
//     matcher,
//   };
//   if (languageGlobs?.length) {
//     config.languageGlobs = languageGlobs;
//   }
//   return config;
// }

// function resolveLanguage(language: string) {
//   const normalized = language.trim();
//   const alias = normalized.toLowerCase();

//   const map: Record<string, Lang> = {
//     html: Lang.Html,
//     javascript: Lang.JavaScript,
//     js: Lang.JavaScript,
//     typescript: Lang.TypeScript,
//     ts: Lang.TypeScript,
//     tsx: Lang.Tsx,
//     jsx: Lang.Tsx,
//     css: Lang.Css,
//   };

//   return map[alias] ?? normalized;
// }

// function cloneMatcher(config: NapiConfig): NapiConfig {
//   const globalClone = (globalThis as { structuredClone?: <T>(value: T) => T })
//     .structuredClone;
//   const cloneFn = globalClone;

//   if (typeof cloneFn === 'function') {
//     return cloneFn(config);
//   }
//   return JSON.parse(JSON.stringify(config));
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
//   const endIndex = Math.min(
//     lines.length - 1,
//     range.end.line - 1 + contextLines,
//   );
//   const context = lines.slice(startIndex, endIndex + 1);

//   return {
//     startLine: startIndex + 1,
//     code: context.join('\n'),
//     highlight: {
//       startLineOffset: range.start.line - 1 - startIndex,
//       endLineOffset: range.end.line - 1 - startIndex,
//     },
//   };
// }

// async function getFileLines(
//   absolutePath: string,
//   cache: Map<string, string[]>,
// ) {
//   const cached = cache.get(absolutePath);
//   if (cached) {
//     return cached;
//   }
//   const content = await fs.readFile(absolutePath, 'utf8');
//   const lines = content.split(/\r?\n/);
//   cache.set(absolutePath, lines);
//   return lines;
// }

// function collectCaptures(node: SgNode, captures: string[]) {
//   const result: Record<string, string | string[]> = {};
//   if (!captures.length) {
//     return result;
//   }

//   for (const capture of captures) {
//     const name = capture.startsWith('$') ? capture : `$${capture}`;
//     try {
//       const matches = node.getMultipleMatches(name) ?? [];
//       if (!matches.length) {
//         continue;
//       }

//       const values = matches.map((item) => item.text());
//       result[name] = values.length === 1 ? values[0] : values;
//     } catch {
//       // Ignore captures that are not present in the current match
//     }
//   }

//   return result;
// }

// function isNapiConfig(candidate: MatcherLike): candidate is NapiConfig {
//   return (
//     typeof candidate === 'object' && candidate !== null && 'rule' in candidate
//   );
// }

// function extractRange(range: Range): NormalizedRange {
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
