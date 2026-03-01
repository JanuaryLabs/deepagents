import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';

import '../../api.ts';
import { CaseTable } from '../../components/CaseTable.tsx';
import { RunStatusBadge } from '../../components/RunStatusBadge.tsx';
import { StatsGrid } from '../../components/StatsGrid.tsx';
import { useAction, useData } from '../../hooks/use-client.ts';
import { useSuiteEvents } from '../../hooks/use-suite-events.ts';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Input,
  Progress,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '../../shadcn/index.ts';

interface RunSummary {
  totalCases: number;
  passCount: number;
  failCount: number;
  meanScores: Record<string, number>;
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

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

interface RunRow {
  id: string;
  suite_id: string;
  name: string;
  model: string;
  config: Record<string, unknown> | null;
  started_at: number;
  finished_at: number | null;
  status: string;
  summary: RunSummary | null;
}

interface SuiteRow {
  id: string;
  name: string;
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  // TODO: use "usePolling"
  const { data, isLoading } = useData(
    'GET /runs/{id}',
    { id: id! },
    {
      enabled: !!id,
      refetchInterval: (query) => {
        const data = query.state.data;
        if (data?.run.status === 'running') return 5000;
        return false;
      },
    },
  );
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});

  const runningIds = useMemo(
    () => (data?.run.status === 'running' ? [data.run.id] : []),
    [data?.run.status, data?.run.id],
  );

  useSuiteEvents(runningIds, {
    onCaseScored: ({ runId, completed, totalCases }) => {
      setProgressMap((prev) => ({
        ...prev,
        [runId]:
          totalCases > 0 ? Math.round((completed / totalCases) * 100) : 0,
      }));
    },
    onRunEnd: () => {
      queryClient.invalidateQueries({ queryKey: ['run', id] });
    },
  });

  const renameMutation = useAction('PATCH /runs/{id}', {
    invalidate: ['GET /runs', 'GET /runs/{id}'],
    onSuccess: () => {
      setIsEditing(false);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Run not found.</p>
      </div>
    );
  }

  const { run, summary, scorerNames, suite, config } = data;
  const cases = data.cases as CaseWithScores[];
  const isRunning = run.status === 'running';

  const promptLabel =
    typeof config.promptName === 'string' &&
    typeof config.promptVersion === 'number'
      ? `${config.promptName} (v${config.promptVersion})`
      : null;
  const selectedRecords =
    typeof config.recordSelection === 'string' && config.recordSelection
      ? config.recordSelection
      : null;
  const threshold =
    typeof config.threshold === 'number' ? config.threshold : 0.5;

  function startEditing() {
    setEditName(run.name);
    setIsEditing(true);
  }

  function handleRename(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = editName.trim();
    if (trimmed && trimmed !== run.name) {
      renameMutation.mutate({ name: trimmed, id: run.id });
    } else {
      setIsEditing(false);
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <Breadcrumb className="mb-3">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/suites">Suites</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={`/suites/${suite.id}`}>{suite.name}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{run.name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="flex items-center justify-between">
          <div>
            {isEditing ? (
              <form onSubmit={handleRename} className="flex items-center gap-2">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setIsEditing(false)}
                  className="text-2xl font-bold"
                  autoFocus
                />
                <Button type="submit" size="sm" variant="outline">
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex items-center gap-3">
                <h1
                  className="cursor-pointer text-2xl font-bold decoration-dashed underline-offset-4 hover:underline"
                  onClick={startEditing}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && startEditing()}
                >
                  {run.name}
                </h1>
                <RunStatusBadge status={run.status} />
              </div>
            )}
            <p className="text-muted-foreground mt-1 text-sm">
              {run.model} &middot; {new Date(run.started_at).toLocaleString()}
            </p>
          </div>

          <Button asChild variant="outline" size="sm">
            <Link to={`/evals/new?from=${run.id}`}>Re-run</Link>
          </Button>
        </div>
      </div>

      {isRunning && (
        <div className="mb-6">
          <div className="text-muted-foreground mb-1 flex items-center justify-between text-sm">
            <span>Progress</span>
            <span>
              {cases.length} / {summary.totalCases || '?'}
            </span>
          </div>
          <Progress value={progressMap[run.id] ?? 0} />
        </div>
      )}

      <div className="mb-8">
        <StatsGrid summary={summary} />
      </div>

      <div className="mb-6 rounded-lg border">
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="w-48 font-medium">Suite</TableCell>
              <TableCell>
                <Link
                  to={`/suites/${suite.id}`}
                  className="text-primary hover:underline"
                >
                  {suite.name}
                </Link>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Dataset</TableCell>
              <TableCell>
                {typeof config.dataset === 'string' ? config.dataset : '\u2014'}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Prompt Version</TableCell>
              <TableCell>{promptLabel ?? '\u2014'}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">Selected Records</TableCell>
              <TableCell>{selectedRecords ?? 'All records'}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Cases</h2>
        {scorerNames.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Scorers: {scorerNames.join(', ')}
          </p>
        )}
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        Status meaning: <strong>FAIL (score)</strong> means output missed the
        threshold; <strong>ERROR (runtime)</strong> means the task crashed or
        timed out.
      </p>

      <CaseTable
        cases={cases}
        scorerNames={scorerNames}
        threshold={threshold}
      />
    </div>
  );
}
