import type { ToolUIPart } from 'ai';
import type { ReactNode } from 'react';

import {
  CodeBlock,
  CodeBlockCopyButton,
  type StaticTool,
  type ToolLabel,
} from '@deepagents/react-genai';
import { cn } from '@deepagents/react-shadcn';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string) {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: unknown, key: string) {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

function booleanField(value: unknown, key: string) {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'boolean' ? field : undefined;
}

function isPending(part: ToolUIPart) {
  return (
    part.state !== 'output-available' &&
    part.state !== 'output-error' &&
    part.state !== 'output-denied'
  );
}

function errorText(part: ToolUIPart) {
  if (part.state === 'output-error') return part.errorText;
  if (part.state === 'output-denied') return 'Execution denied.';
  return undefined;
}

function StatusLine({
  children,
  pending = false,
  error = false,
}: {
  children: ReactNode;
  pending?: boolean;
  error?: boolean;
}) {
  return (
    <p
      aria-live={pending ? 'polite' : undefined}
      className={cn(
        'text-xs leading-relaxed',
        pending && 'animate-pulse',
        error ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  );
}

function CodeSection({
  title,
  code,
  language,
  detail,
  error = false,
}: {
  title: string;
  code: string;
  language: string;
  detail?: string;
  error?: boolean;
}) {
  return (
    <section className="space-y-1.5">
      <header className="flex items-baseline justify-between gap-3 px-0.5">
        <h4
          className={cn(
            'text-[10px] font-semibold tracking-[0.08em] uppercase',
            error ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {title}
        </h4>
        {detail && (
          <span className="text-muted-foreground font-mono text-[10px]">
            {detail}
          </span>
        )}
      </header>
      <div className="max-h-64 overflow-auto rounded-md">
        <CodeBlock
          className={cn(
            'border-border/60 rounded-md shadow-none',
            error && 'border-destructive/30',
          )}
          code={code}
          language={language}
          wrap
        >
          <CodeBlockCopyButton
            aria-label={`Copy ${title.toLowerCase()}`}
            className="text-muted-foreground bg-background/90 hover:bg-muted h-6 rounded-md px-2 font-mono text-[10px]"
            size="xs"
            variant="ghost"
          >
            Copy
          </CodeBlockCopyButton>
        </CodeBlock>
      </div>
    </section>
  );
}

function ToolBody({ children }: { children: ReactNode }) {
  return (
    <div className="border-border/60 mb-2 space-y-3 border-l pl-3">
      {children}
    </div>
  );
}

function BashTool({ part }: { part: ToolUIPart }) {
  const command = stringField(part.input, 'command') ?? '';
  const stdout = stringField(part.output, 'stdout') ?? '';
  const stderr = stringField(part.output, 'stderr') ?? '';
  const exitCode = numberField(part.output, 'exitCode');
  const failure = errorText(part);
  const pending = isPending(part);

  return (
    <ToolBody>
      {failure ? (
        <StatusLine error>{failure}</StatusLine>
      ) : pending ? (
        <StatusLine pending>Running command...</StatusLine>
      ) : (
        <StatusLine error={exitCode !== undefined && exitCode !== 0}>
          {exitCode === undefined
            ? 'Command finished.'
            : `Command exited with code ${exitCode}.`}
        </StatusLine>
      )}
      {command && (
        <CodeSection code={command} language="bash" title="Command" />
      )}
      {stdout && (
        <CodeSection code={stdout} language="text" title="Standard output" />
      )}
      {stderr && (
        <CodeSection
          code={stderr}
          error
          language="text"
          title="Standard error"
        />
      )}
      {!pending && !failure && !stdout && !stderr && (
        <StatusLine>The command produced no output.</StatusLine>
      )}
    </ToolBody>
  );
}

function toolOutputText(output: unknown) {
  if (typeof output === 'string') return output;
  if (!isRecord(output)) return undefined;
  if (
    (output.type === 'text' || output.type === 'error-text') &&
    typeof output.value === 'string'
  ) {
    return output.value;
  }
  if (output.type !== 'content' || !Array.isArray(output.value)) {
    return undefined;
  }

  const text = output.value
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === 'text' && typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n');
  return text || undefined;
}

function toolOutputFiles(output: unknown) {
  if (!isRecord(output) || output.type !== 'content') return [];
  if (!Array.isArray(output.value)) return [];

  return output.value.flatMap((item) => {
    if (!isRecord(item) || item.type !== 'file') return [];
    const mediaType =
      typeof item.mediaType === 'string' ? item.mediaType : 'file';
    const filename =
      typeof item.filename === 'string' ? item.filename : 'Attachment';
    return [`${filename} · ${mediaType}`];
  });
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  css: 'css',
  csv: 'csv',
  html: 'html',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  py: 'python',
  sh: 'bash',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

function languageFromPath(path: string) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'text';
}

function readRange(input: unknown) {
  const offset = numberField(input, 'offset');
  const limit = numberField(input, 'limit');
  if (offset === undefined && limit === undefined) return undefined;
  const start = offset ?? 1;
  return limit === undefined ? `${start}+` : `${start}-${start + limit - 1}`;
}

function ReadFileTool({ part }: { part: ToolUIPart }) {
  const path = stringField(part.input, 'path') ?? '';
  const content = toolOutputText(part.output);
  const attachments = toolOutputFiles(part.output);
  const outputError =
    isRecord(part.output) && part.output.type === 'error-text'
      ? toolOutputText(part.output)
      : undefined;
  const failure = errorText(part) ?? outputError;
  const pending = isPending(part);
  const range = readRange(part.input);

  return (
    <ToolBody>
      {failure ? (
        <StatusLine error>{failure}</StatusLine>
      ) : pending ? (
        <StatusLine pending>Reading {path || 'file'}...</StatusLine>
      ) : content !== undefined ? (
        content ? (
          <CodeSection
            code={content}
            detail={range ? `lines ${range}` : undefined}
            language={languageFromPath(path)}
            title="File contents"
          />
        ) : (
          <StatusLine>The file is empty.</StatusLine>
        )
      ) : attachments.length > 0 ? (
        <div className="space-y-1">
          <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.08em] uppercase">
            File content
          </p>
          {attachments.map((attachment) => (
            <p key={attachment} className="text-foreground/80 text-xs">
              {attachment}
            </p>
          ))}
        </div>
      ) : (
        <StatusLine>File content is unavailable.</StatusLine>
      )}
    </ToolBody>
  );
}

function WriteFileTool({ part }: { part: ToolUIPart }) {
  const path = stringField(part.input, 'path') ?? '';
  const content = stringField(part.input, 'content') ?? '';
  const exitCode = numberField(part.output, 'exitCode');
  const stderr = stringField(part.output, 'stderr') ?? '';
  const stdout = stringField(part.output, 'stdout') ?? '';
  const success = booleanField(part.output, 'success');
  const failure = errorText(part);
  const pending = isPending(part);
  const failed = !!failure || success === false || (exitCode ?? 0) !== 0;

  return (
    <ToolBody>
      {pending ? (
        <StatusLine pending>Writing {path || 'file'}...</StatusLine>
      ) : failed ? (
        <StatusLine error>
          {failure || stderr || stdout || `Failed to write ${path || 'file'}.`}
        </StatusLine>
      ) : (
        <StatusLine>File written.</StatusLine>
      )}
      {content ? (
        <CodeSection
          code={content}
          language={languageFromPath(path)}
          title="Written content"
        />
      ) : (
        <StatusLine>The file content is empty.</StatusLine>
      )}
    </ToolBody>
  );
}

function bashLabel(part: ToolUIPart): ToolLabel {
  const command = stringField(part.input, 'command');
  const reasoning = stringField(part.input, 'reasoning');
  const exitCode = numberField(part.output, 'exitCode');
  return {
    name: 'Bash',
    args: command ? { cmd: command.slice(0, 80) } : undefined,
    detail: reasoning,
    isError:
      part.state === 'output-error' ||
      part.state === 'output-denied' ||
      (exitCode !== undefined && exitCode !== 0),
  };
}

function fileLabel(
  part: ToolUIPart,
  name: 'ReadFile' | 'WriteFile',
): ToolLabel {
  const path = stringField(part.input, 'path');
  const range = name === 'ReadFile' ? readRange(part.input) : undefined;
  const exitCode = numberField(part.output, 'exitCode');
  return {
    name,
    args:
      path || range
        ? { ...(path ? { path } : {}), ...(range ? { lines: range } : {}) }
        : undefined,
    isError:
      part.state === 'output-error' ||
      part.state === 'output-denied' ||
      booleanField(part.output, 'success') === false ||
      (exitCode !== undefined && exitCode !== 0) ||
      (isRecord(part.output) && part.output.type === 'error-text'),
  };
}

export const bashTool = {
  component: BashTool,
  label: bashLabel,
  static: true,
} satisfies StaticTool;

export const readFileTool = {
  component: ReadFileTool,
  label: (part) => fileLabel(part, 'ReadFile'),
  static: true,
} satisfies StaticTool;

export const writeFileTool = {
  component: WriteFileTool,
  label: (part) => fileLabel(part, 'WriteFile'),
  static: true,
} satisfies StaticTool;
