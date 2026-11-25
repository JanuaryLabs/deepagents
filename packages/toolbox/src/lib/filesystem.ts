import { type ToolExecutionOptions, tool } from 'ai';
import spawn from 'nano-spawn';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import z from 'zod';

/** Tool context: the repository the file tools read from. */
export type RepoContext = {
  repo_path: string;
};

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
  execute: async (
    { filePath, lineStart, lineEnd },
    { context }: ToolExecutionOptions<RepoContext>,
  ) => {
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
  execute: async (
    { dir_path },
    { context }: ToolExecutionOptions<RepoContext>,
  ) => {
    return readdir(join(context.repo_path, dir_path), 'utf-8');
  },
});

export const file_exists_tool = tool({
  description: 'Check if a file exists in the repository.',
  inputSchema: z.object({ filePath: z.string().min(1) }),
  execute: async (
    { filePath },
    { context }: ToolExecutionOptions<RepoContext>,
  ) => {
    try {
      await stat(join(context.repo_path, filePath));
      return true;
    } catch (error) {
      // No such path, or a parent of it is a file; any other failure is the tool's error.
      if (
        Error.isError(error) &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return false;
      }
      throw error;
    }
  },
});

export async function repoTree(dir_path: string) {
  const result = await spawn('git', ['ls-tree', '-r', 'HEAD', '--name-only'], {
    cwd: dir_path,
  }).pipe('tree', ['--fromfile']);
  return result.output;
}
