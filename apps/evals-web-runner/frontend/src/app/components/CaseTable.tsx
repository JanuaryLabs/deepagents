import { Fragment, useMemo } from 'react';
import {
  type ColumnDef,
  type ExpandedState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useState } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../shadcn/index.ts';
import { formatInputValue, truncate } from '../lib/format.ts';

interface ScoreEntry {
  scorer_name: string;
  score: number;
  reason: string | null;
}

interface CaseWithScores {
  id: string;
  run_id: string;
  idx: number;
  input: unknown;
  output: string | null;
  expected: unknown;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  error: string | null;
  scores: ScoreEntry[];
}

interface CaseTableProps {
  cases: CaseWithScores[];
  scorerNames: string[];
  threshold?: number;
}

function normalizeReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatCaseError(error: string | null): string | null {
  if (!error) return null;
  try {
    const parsed = JSON.parse(error);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const message =
        typeof (parsed as { message?: unknown }).message === 'string'
          ? (parsed as { message: string }).message
          : null;
      const name =
        typeof (parsed as { name?: unknown }).name === 'string'
          ? (parsed as { name: string }).name
          : null;
      if (message) return name ? `${name}: ${message}` : message;
    }
    return JSON.stringify(parsed);
  } catch {
    return error;
  }
}

function formatCaseErrorDetails(error: string | null): string | null {
  if (!error) return null;
  try {
    const parsed = JSON.parse(error);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const stack =
        typeof (parsed as { stack?: unknown }).stack === 'string'
          ? (parsed as { stack: string }).stack
          : null;
      if (stack) return stack;
      return JSON.stringify(parsed, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return error;
  }
}

function fallbackFailureReason(
  caseData: CaseWithScores,
  scorerName: string,
  score: number,
  threshold: number,
): string {
  const expected = truncate(formatInputValue(caseData.expected), 140);
  const output = truncate(caseData.output ?? '', 140);

  if (scorerName === 'exactMatch') {
    return `Output did not exactly match expected. Expected: ${expected}. Output: ${output || '<empty>'}.`;
  }
  if (scorerName === 'includes') {
    return `Output did not include expected text. Expected snippet: ${expected}. Output: ${output || '<empty>'}.`;
  }
  if (scorerName === 'levenshtein') {
    return `Similarity score ${score.toFixed(3)} is below threshold ${threshold.toFixed(3)}. Expected: ${expected}. Output: ${output || '<empty>'}.`;
  }
  if (scorerName === 'jsonMatch') {
    return `Output JSON did not match expected JSON. Expected: ${expected}. Output: ${output || '<empty>'}.`;
  }

  return `Score ${score.toFixed(3)} is below threshold ${threshold.toFixed(3)}. Expected: ${expected}. Output: ${output || '<empty>'}.`;
}

function ExpandedCaseRow({
  caseData,
  scorerNames,
  threshold,
}: {
  caseData: CaseWithScores;
  scorerNames: string[];
  threshold: number;
}) {
  const scoreMap = new Map(
    caseData.scores.map((s) => [s.scorer_name, s]),
  );
  const errorSummary = formatCaseError(caseData.error);
  const errorDetails = formatCaseErrorDetails(caseData.error);

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            Output
          </h4>
          <pre className="bg-muted max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
            {caseData.output ?? '\u2014'}
          </pre>
        </div>
        <div>
          <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            Expected
          </h4>
          <pre className="bg-muted max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
            {caseData.expected != null
              ? formatInputValue(caseData.expected)
              : '\u2014'}
          </pre>
        </div>
      </div>

      {scorerNames.length > 0 && (
        <div>
          <h4 className="text-muted-foreground mb-2 text-xs font-medium uppercase">
            Scorer Results
          </h4>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Scorer</TableHead>
                  <TableHead className="w-20">Score</TableHead>
                  <TableHead className="w-20">Status</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scorerNames.map((name) => {
                  const s = scoreMap.get(name);
                  const score = s?.score ?? 0;
                  const passing = score >= threshold;
                  const reason =
                    normalizeReason(s?.reason) ??
                    (!passing
                      ? fallbackFailureReason(
                          caseData,
                          name,
                          score,
                          threshold,
                        )
                      : null);

                  return (
                    <TableRow key={name}>
                      <TableCell className="font-medium">{name}</TableCell>
                      <TableCell
                        className={`font-mono text-sm ${
                          passing ? 'text-green-600' : 'text-destructive'
                        }`}
                      >
                        {score.toFixed(3)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            passing
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          }`}
                        >
                          {passing ? 'PASS' : 'FAIL'}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-lg text-xs whitespace-pre-wrap">
                        {reason ?? '\u2014'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {errorSummary && (
        <div>
          <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            Runtime Error
          </h4>
          <div className="bg-destructive/10 border-destructive/30 rounded-lg border p-3">
            <p className="text-destructive text-sm font-medium">
              {errorSummary}
            </p>
            {errorDetails && errorDetails !== errorSummary && (
              <pre className="text-destructive/80 mt-2 whitespace-pre-wrap font-mono text-[10px]">
                {errorDetails}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function CaseTable({
  cases,
  scorerNames,
  threshold = 0.5,
}: CaseTableProps) {
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const columns = useMemo<ColumnDef<CaseWithScores>[]>(() => {
    const base: ColumnDef<CaseWithScores>[] = [
      {
        id: 'expand',
        header: '',
        size: 32,
        cell: ({ row }) => (
          <button
            onClick={row.getToggleExpandedHandler()}
            className="text-muted-foreground hover:text-foreground cursor-pointer p-1"
          >
            {row.getIsExpanded() ? '\u25BC' : '\u25B6'}
          </button>
        ),
      },
      {
        accessorKey: 'idx',
        header: '#',
        size: 48,
        cell: ({ getValue }) => (
          <span className="text-muted-foreground">{getValue<number>()}</span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        size: 100,
        cell: ({ row }) => {
          const c = row.original;
          const passed = c.scores.every((s) => s.score >= threshold);
          const status = c.error ? 'error' : passed ? 'pass' : 'fail';
          const label =
            status === 'pass'
              ? 'PASS'
              : status === 'fail'
                ? 'FAIL'
                : 'ERROR';
          return (
            <span
              className={`text-xs font-medium ${
                status === 'pass'
                  ? 'text-green-600'
                  : status === 'fail'
                    ? 'text-destructive'
                    : 'text-yellow-600'
              }`}
            >
              {label}
            </span>
          );
        },
      },
      {
        id: 'input',
        header: 'Input',
        cell: ({ row }) => (
          <span className="block max-w-xs truncate">
            {truncate(formatInputValue(row.original.input))}
          </span>
        ),
      },
      {
        id: 'output',
        header: 'Output',
        cell: ({ row }) => (
          <span className="block max-w-xs truncate">
            {row.original.output ? truncate(row.original.output) : '\u2014'}
          </span>
        ),
      },
      {
        id: 'expected',
        header: 'Expected',
        cell: ({ row }) => (
          <span className="block max-w-xs truncate">
            {row.original.expected != null
              ? truncate(formatInputValue(row.original.expected))
              : '\u2014'}
          </span>
        ),
      },
    ];

    const scorerCols: ColumnDef<CaseWithScores>[] = scorerNames.map(
      (name) => ({
        id: `scorer-${name}`,
        header: name,
        size: 80,
        cell: ({ row }) => {
          const s = row.original.scores.find((sc) => sc.scorer_name === name);
          const score = s?.score ?? 0;
          return (
            <span
              className={`font-mono text-xs ${
                score >= threshold ? 'text-green-600' : 'text-destructive'
              }`}
            >
              {score.toFixed(3)}
            </span>
          );
        },
      }),
    );

    const tail: ColumnDef<CaseWithScores>[] = [
      {
        id: 'latency',
        header: 'Latency',
        size: 80,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.latency_ms}ms
          </span>
        ),
      },
    ];

    return [...base, ...scorerCols, ...tail];
  }, [scorerNames, threshold]);

  const table = useReactTable({
    data: cases,
    columns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowId: (row) => row.id,
  });

  const totalColumns = table.getHeaderGroups()[0]?.headers.length ?? 1;

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <Fragment key={row.id}>
              <TableRow
                className="cursor-pointer"
                onClick={row.getToggleExpandedHandler()}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
              {row.getIsExpanded() && (
                <TableRow>
                  <TableCell colSpan={totalColumns} className="p-0">
                    <ExpandedCaseRow
                      caseData={row.original}
                      scorerNames={scorerNames}
                      threshold={threshold}
                    />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
