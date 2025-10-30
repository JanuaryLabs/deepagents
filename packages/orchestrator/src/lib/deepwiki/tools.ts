import { dynamicTool, jsonSchema, tool } from 'ai';
import FastGlob from 'fast-glob';
import spawn from 'nano-spawn';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import z from 'zod';

import { toState } from '@deepagents/agent';
import { fastembed, nodeSQLite, similaritySearch } from '@deepagents/retrieval';
import * as connectors from '@deepagents/retrieval/connectors';
import { ignorePatterns } from '@deepagents/retrieval/connectors';

export const read_file_tool = tool({
  description: `Use this tool to read a file from the filesystem. Supports reading entire files or specific line ranges.`,
  inputSchema: z.object({
    filePath: z.string().min(1),
    lineStart: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Starting line number (1-indexed). If omitted, reads from the beginning.',
      ),
    lineEnd: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Ending line number (1-indexed). If omitted, reads to the end. Maximum 200 lines can be read at once.',
      ),
  }),
  execute: async ({ filePath, lineStart, lineEnd }, options) => {
    const context = toState<{ repo_path: string }>(options);
    const fullPath = join(context.repo_path, filePath);

    const stats = await stat(fullPath);
    const maxSize = 100 * 1024; // 100 KB

    if (stats.size > maxSize) {
      return `File too large to read (size: ${stats.size} bytes, max: ${maxSize} bytes)`;
    }

    try {
      const content = await readFile(fullPath, 'utf-8');

      // If no line parameters specified, return entire file
      if (!lineStart && !lineEnd) {
        return content;
      }

      const lines = content.split('\n');
      const start = (lineStart ?? 1) - 1; // Convert to 0-indexed
      const end = lineEnd ?? lines.length; // Default to end of file

      // Validate line range
      if (start < 0 || start >= lines.length) {
        return `Invalid lineStart: ${lineStart}. File has ${lines.length} lines.`;
      }

      if (end < start) {
        return `Invalid range: lineEnd (${lineEnd}) must be >= lineStart (${lineStart})`;
      }

      const maxLines = 200;
      const requestedLines = end - start;
      if (requestedLines > maxLines) {
        return `Too many lines requested (${requestedLines}). Maximum is ${maxLines} lines.`;
      }

      return lines.slice(start, end).join('\n');
    } catch (error) {
      console.error('Error reading file:', error);
      return `Error reading file: ${JSON.stringify(error)}`;
    }
  },
});

export const read_dir_tool = tool({
  description: 'Use this tool to list files in a directory.',
  inputSchema: z.object({
    dir_path: z
      .string()
      .min(1)
      .optional()
      .default('./')
      .describe('Relative path to the directory. Defaults to "./"'),
  }),
  execute: async ({ dir_path }, options) => {
    const context = toState<{ repo_path: string }>(options);
    return readdir(join(context.repo_path, dir_path), 'utf-8');
  },
});

export const glob_tool = tool({
  description: `Use this tool to list files in a directory.
			This tool returns only direct files and directories that match the provided glob pattern.
			Make sure not to look for framework generated files, such as ios/android folders in a react native project or .next in a nextjs project and so on.
			`,
  inputSchema: z.object({
    pattern: z.string().min(1).describe('A glob pattern to match files. '),
  }),
  execute: async ({ pattern }, options) => {
    const context = toState<{ repo_path: string }>(options);
    const files = await FastGlob(pattern, {
      dot: true,
      cwd: context.repo_path,
      unique: true,
      deep: 1,
      followSymbolicLinks: false,
      ignore: await ignorePatterns(context.repo_path),
    });
    return files;
  },
});

export const search_files_tool = tool({
  description:
    'Search for files in the repository by name or extension. Returns relative file paths. Avoids framework-generated and ignored paths.',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('A glob pattern to match files.'),
    max_results: z.number().int().positive().max(500).optional().default(100),
    depth: z
      .number()
      .int()
      .describe('Max directory depth to search. defaults to 31.'),
  }),
  execute: async ({ pattern, max_results = 100, depth }, options) => {
    const context = toState<{ repo_path: string }>(options);
    const ignore = await ignorePatterns(context.repo_path);
    const files = await FastGlob(pattern, {
      dot: false,
      cwd: context.repo_path,
      unique: true,
      deep: depth,
      followSymbolicLinks: false,
      ignore,
    });
    return files.slice(0, max_results);
  },
});

export const file_exists_tool = tool({
  description: 'Check if a file exists in the repository.',
  inputSchema: z.object({ filePath: z.string().min(1) }),
  execute: async ({ filePath }, options) => {
    const context = toState<{ repo_path: string }>(options);
    return stat(join(context.repo_path, filePath))
      .then(() => true)
      .catch(() => false);
  },
});

export const search_content_tool = dynamicTool({
  description: `Use this tool to search the content of files in the repository. this tool is backed by a vector database and uses semantic search to find the most relevant snippets of content.`,
  // inputSchema: z.object({
  //   query: z.string().min(1).describe('The search query.'),
  // }),
  inputSchema: jsonSchema({
    additionalProperties: true,
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query.',
      },
    },
    required: ['query'],
  }),
  async execute(input: any, options) {
    if (typeof input.query !== 'string' || input.query.trim().length === 0) {
      return 'Invalid input: "query" must be a non-empty string.';
    }
    try {
      const context = toState<{ repo_path: string }>(options);
      const results = await similaritySearch(input.query, {
        connector: connectors.repo(
          context.repo_path,
          ['.ts', '.tsx', '.md', '.prisma'],
          'never',
        ),

        store: nodeSQLite('deepsearch.sqlite', 384),
        embedder: fastembed(),
      });
      const contents = results.map((it) => ({
        source: relative(context.repo_path, it.document_id),
        snippet: it.content,
        // similarity: it.similarity,
      }));
      return contents
        .map((it) => `File: ${it.source}\n\`\`\`\n${it.snippet}\n\`\`\``)
        .join('\n\n---\n\n');
    } catch (error) {
      console.error('Error in search_content_tool:', error);
      return `Error during content search: ${JSON.stringify(error)}`;
    }
  },
});

export async function repoTree(dir_path: string) {
  const result = await spawn('git', ['ls-tree', '-r', 'HEAD', '--name-only'], {
    cwd: dir_path,
  }).pipe('tree', ['--fromfile']);
  return result.output;
}
