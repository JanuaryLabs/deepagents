import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';

import { RunStatusBadge } from '../../components/RunStatusBadge.tsx';
import { SuiteComparison } from '../../components/SuiteComparison.tsx';
import { useAction, useData } from '../../hooks/use-client.ts';
import { useSuiteEvents } from '../../hooks/use-suite-events.ts';
import { formatDuration, formatTokens } from '../../lib/format.ts';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Progress,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shadcn/index.ts';

interface SuiteRow {
  id: string;
  name: string;
  created_at: number;
}

interface RunSummary {
  totalCases: number;
  passCount: number;
  failCount: number;
  meanScores: Record<string, number>;
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

interface RunRow {
  id: string;
  suite_id: string;
  name: string;
  model: string;
  config: Record<string, unknown> | null;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'completed' | 'failed';
  summary: RunSummary | null;
}

export default function SuiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useData(
    'GET /suites/{id}',
    { id: id! },
    {
      enabled: !!id,
      refetchInterval: (query) => {
        const data = query.state.data;
        if (data?.runs.some((r) => r.status === 'running')) return 5000;
        return false;
      },
    },
  );
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [showComparison, setShowComparison] = useState(false);

  const [progressMap, setProgressMap] = useState<Record<string, number>>({});

  const runningIds = useMemo(
    () =>
      data?.runs.filter((r) => r.status === 'running').map((r) => r.id) ?? [],
    [data?.runs],
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
      queryClient.invalidateQueries({ queryKey: ['suite', id] });
    },
  });

  const renameMutation = useAction('PATCH /suites/{id}', {
    invalidate: ['GET /suites', 'GET /suites/{id}'],
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
        <p className="text-muted-foreground">Suite not found.</p>
      </div>
    );
  }

  const { suite, runs, stats } = data;
  const completedRuns = runs.filter((r) => r.status === 'completed');

  function startEditing() {
    setEditName(suite.name);
    setIsEditing(true);
  }

  function handleRename(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = editName.trim();
    if (trimmed && trimmed !== suite.name) {
      renameMutation.mutate({ name: trimmed, id: suite.id });
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
              <BreadcrumbPage>{suite.name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="flex items-start justify-between">
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
              <h1
                className="cursor-pointer text-2xl font-bold decoration-dashed underline-offset-4 hover:underline"
                onClick={startEditing}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && startEditing()}
              >
                {suite.name}
              </h1>
            )}
            <p className="text-muted-foreground mt-1 text-sm">
              Suite &middot; {runs.length} run{runs.length !== 1 ? 's' : ''}{' '}
              &middot; Created{' '}
              {new Date(suite.created_at).toLocaleDateString()}
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link
              to={`/evals/new?suiteId=${suite.id}${runs[0] ? `&from=${runs[0].id}` : ''}`}
            >
              Add Run
            </Link>
          </Button>
        </div>
      </div>

      {stats && (
        <div className="mb-8 grid grid-cols-5 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-normal">
                Total Cases
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-semibold">{stats.totalCases}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-normal">
                Passed
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-semibold text-green-600">
                {stats.totalPass}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-normal">
                Failed
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-destructive text-lg font-semibold">
                {stats.totalFail}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-normal">
                Total Latency
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-semibold">
                {formatDuration(stats.totalLatency)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-normal">
                Total Tokens
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-semibold">
                {formatTokens(stats.totalTokens)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {selectedRunIds.size >= 2 && (
        <div className="mb-4 flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => setShowComparison((prev) => !prev)}
          >
            {showComparison ? 'Hide Comparison' : `Compare ${selectedRunIds.size} Runs`}
          </Button>
          {showComparison && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelectedRunIds(new Set());
                setShowComparison(false);
              }}
            >
              Clear Selection
            </Button>
          )}
        </div>
      )}

      {showComparison && selectedRunIds.size >= 2 && (
        <div className="mb-8">
          <SuiteComparison
            suiteId={suite.id}
            runIds={[...selectedRunIds]}
          />
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {completedRuns.length > 1 && (
                <TableHead className="w-10" />
              )}
              <TableHead>Run</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Cases</TableHead>
              <TableHead>Pass</TableHead>
              <TableHead>Fail</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>Tokens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const isCompleted = run.status === 'completed';
              const isSelected = selectedRunIds.has(run.id);

              function toggleRun() {
                setSelectedRunIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(run.id)) {
                    next.delete(run.id);
                  } else {
                    next.add(run.id);
                  }
                  return next;
                });
              }

              return (
                <TableRow key={run.id}>
                  {completedRuns.length > 1 && (
                    <TableCell>
                      {isCompleted && (
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={toggleRun}
                        />
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    <Link
                      to={`/runs/${run.id}`}
                      className="text-primary font-medium hover:underline"
                    >
                      {run.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{run.model}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(run.started_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="min-w-40">
                    <div className="space-y-2">
                      <RunStatusBadge status={run.status} />
                      {run.status === 'running' && (
                        <Progress value={progressMap[run.id] ?? 0} />
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{run.summary?.totalCases ?? '\u2014'}</TableCell>
                  <TableCell className="text-green-600">
                    {run.summary?.passCount ?? '\u2014'}
                  </TableCell>
                  <TableCell className="text-destructive">
                    {run.summary?.failCount ?? '\u2014'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {run.summary
                      ? formatDuration(run.summary.totalLatencyMs)
                      : '\u2014'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {run.summary
                      ? formatTokens(
                          run.summary.totalTokensIn + run.summary.totalTokensOut,
                        )
                      : '\u2014'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
