import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { apiFetch } from '../../api.ts';
import { RunStatusBadge } from '../../components/RunStatusBadge.tsx';
import { useSuiteEvents } from '../../hooks/use-suite-events.ts';
import { formatDuration, formatTokens } from '../../lib/format.ts';
import {
  Button,
  Progress,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
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

interface RunRow {
  id: string;
  suite_id: string;
  name: string;
  model: string;
  started_at: number;
  status: string;
  summary: RunSummary | null;
}

interface RunGroup {
  suiteId: string;
  suiteName: string;
  runs: RunRow[];
}

interface RunsResponse {
  groups: RunGroup[];
  totalRuns: number;
}

function useRuns() {
  return useQuery({
    queryKey: ['runs'],
    queryFn: () => apiFetch<RunsResponse>('/runs'),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (
        data?.groups.some((g) => g.runs.some((r) => r.status === 'running'))
      ) {
        return 5000;
      }
      return false;
    },
  });
}

export default function RunListPage() {
  const { data, isLoading } = useRuns();
  const queryClient = useQueryClient();
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});

  const runningIds = useMemo(
    () =>
      data?.groups.flatMap((g) =>
        g.runs.filter((r) => r.status === 'running').map((r) => r.id),
      ) ?? [],
    [data?.groups],
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
      queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!data || data.totalRuns === 0) {
    return (
      <div className="p-8">
        <div className="rounded-lg border-2 border-dashed p-12 text-center">
          <p className="text-muted-foreground text-sm">No eval runs yet.</p>
          <Link
            to="/evals/new"
            className="text-primary mt-2 inline-block text-sm font-medium hover:underline"
          >
            Run your first eval
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Runs</h1>
          <p className="text-muted-foreground text-sm">
            {data.totalRuns} run{data.totalRuns !== 1 ? 's' : ''}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/evals/new">New Eval</Link>
        </Button>
      </div>

      <div className="space-y-6">
        {data.groups.map((group) => (
          <section key={group.suiteId}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                <Link
                  to={`/suites/${group.suiteId}`}
                  className="text-primary hover:underline"
                >
                  {group.suiteName}
                </Link>
              </h2>
              <span className="text-muted-foreground text-xs">
                {group.runs.length} run{group.runs.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Cases</TableHead>
                    <TableHead>Pass</TableHead>
                    <TableHead>Fail</TableHead>
                    <TableHead>Latency</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Mean Scores</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.runs.map((run) => (
                    <TableRow key={run.id}>
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
                      <TableCell>
                        {run.summary?.totalCases ?? '\u2014'}
                      </TableCell>
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
                              run.summary.totalTokensIn +
                                run.summary.totalTokensOut,
                            )
                          : '\u2014'}
                      </TableCell>
                      <TableCell className="max-w-sm text-xs">
                        {run.summary &&
                        Object.keys(run.summary.meanScores).length > 0
                          ? Object.entries(run.summary.meanScores)
                              .map(
                                ([name, score]) =>
                                  `${name}: ${score.toFixed(3)}`,
                              )
                              .join(', ')
                          : '\u2014'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
