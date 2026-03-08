import { toPng } from 'html-to-image';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { useData } from '../hooks/use-client.ts';
import { formatDuration, formatTokens } from '../lib/format.ts';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../shadcn/index.ts';
import type { ChartConfig } from '../shadcn/lib/ui/chart.tsx';

const RUN_COLORS = [
  'hsl(221, 83%, 53%)',
  'hsl(142, 71%, 45%)',
  'hsl(0, 84%, 60%)',
  'hsl(38, 92%, 50%)',
  'hsl(262, 83%, 58%)',
  'hsl(172, 66%, 50%)',
  'hsl(330, 81%, 60%)',
  'hsl(45, 93%, 47%)',
];

interface RunSummary {
  totalCases: number;
  passCount: number;
  failCount: number;
  meanScores: Record<string, number>;
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

interface CompareRun {
  id: string;
  name: string;
  model: string;
  summary: RunSummary;
}

interface CompareResponse {
  runs: CompareRun[];
  scorerNames: string[];
  caseDiffs: Array<{
    index: number;
    scores: Record<string, Record<string, number>>;
  }>;
}

export function SuiteComparison({
  suiteId,
  runIds,
}: {
  suiteId: string;
  runIds: string[];
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const [capturing, setCapturing] = useState(false);

  const { data, isLoading, error } = useData(
    'GET /suites/{id}/compare',
    { id: suiteId, runIds: runIds.join(',') },
    { enabled: runIds.length >= 2 },
  );

  const handleCopyAsImage = useCallback(async () => {
    if (!captureRef.current) return;
    setCapturing(true);
    try {
      const dataUrl = await toPng(captureRef.current, { pixelRatio: 2 });
      const res = await fetch(dataUrl);
      const blob = await res.blob();

      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob }),
        ]);
        toast.success('Copied comparison as image');
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'comparison.png';
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Downloaded comparison as image');
      }
    } catch {
      toast.error('Failed to capture comparison');
    } finally {
      setCapturing(false);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-destructive text-sm">
        {error instanceof Error ? error.message : 'Failed to load comparison.'}
      </p>
    );
  }

  if (!data) return null;

  const comparison = data as unknown as CompareResponse;
  const showRadar = comparison.scorerNames.length >= 3;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={capturing}
          onClick={handleCopyAsImage}
        >
          {capturing ? 'Capturing…' : 'Copy as Image'}
        </Button>
      </div>
      <div ref={captureRef} className="space-y-8">
        <SummaryCards runs={comparison.runs} />
        <div
          className={`grid gap-6 ${showRadar ? 'grid-cols-2' : 'grid-cols-1'}`}
        >
          <ScorerBarChart
            runs={comparison.runs}
            scorerNames={comparison.scorerNames}
          />
          {showRadar && (
            <ScorerRadarChart
              runs={comparison.runs}
              scorerNames={comparison.scorerNames}
            />
          )}
        </div>
        <CostBarChart runs={comparison.runs} />
        <CaseScoreTable
          runs={comparison.runs}
          scorerNames={comparison.scorerNames}
          caseDiffs={comparison.caseDiffs}
        />
      </div>
    </div>
  );
}

function SummaryCards({ runs }: { runs: CompareRun[] }) {
  const bestPass = Math.max(...runs.map((r) => r.summary.passCount));
  const bestLatency = Math.min(...runs.map((r) => r.summary.totalLatencyMs));

  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(${runs.length}, 1fr)` }}
    >
      {runs.map((run, i) => {
        const passRate =
          run.summary.totalCases > 0
            ? ((run.summary.passCount / run.summary.totalCases) * 100).toFixed(
                1,
              )
            : '0';
        const isBestPass = run.summary.passCount === bestPass;
        const isBestLatency = run.summary.totalLatencyMs === bestLatency;

        return (
          <Card key={run.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                <span
                  className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: RUN_COLORS[i % RUN_COLORS.length] }}
                />
                {run.name}
              </CardTitle>
              <p className="text-muted-foreground text-xs">{run.model}</p>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pass Rate</span>
                <span
                  className={isBestPass ? 'font-semibold text-green-600' : ''}
                >
                  {passRate}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Latency</span>
                <span
                  className={
                    isBestLatency ? 'font-semibold text-green-600' : ''
                  }
                >
                  {formatDuration(run.summary.totalLatencyMs)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tokens</span>
                <span>
                  {formatTokens(
                    run.summary.totalTokensIn + run.summary.totalTokensOut,
                  )}
                </span>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function buildChartConfig(runs: CompareRun[]): ChartConfig {
  const config: ChartConfig = {};
  runs.forEach((run, i) => {
    config[run.id] = {
      label: `${run.name} (${run.model})`,
      color: RUN_COLORS[i % RUN_COLORS.length],
    };
  });
  return config;
}

function ScorerBarChart({
  runs,
  scorerNames,
}: {
  runs: CompareRun[];
  scorerNames: string[];
}) {
  const chartConfig = useMemo(() => buildChartConfig(runs), [runs]);

  const chartData = useMemo(() => {
    return scorerNames.map((scorer) => {
      const entry: Record<string, unknown> = { scorer };
      for (const run of runs) {
        entry[run.id] = run.summary.meanScores[scorer] ?? 0;
      }
      return entry;
    });
  }, [runs, scorerNames]);

  if (scorerNames.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Mean Scores by Scorer
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="scorer" tick={{ fontSize: 12 }} />
            <YAxis domain={[0, 1]} tick={{ fontSize: 12 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            {runs.map((run, i) => (
              <Bar
                key={run.id}
                dataKey={run.id}
                fill={RUN_COLORS[i % RUN_COLORS.length]}
                radius={[4, 4, 0, 0]}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function ScorerRadarChart({
  runs,
  scorerNames,
}: {
  runs: CompareRun[];
  scorerNames: string[];
}) {
  const chartConfig = useMemo(() => buildChartConfig(runs), [runs]);

  const chartData = useMemo(() => {
    return scorerNames.map((scorer) => {
      const entry: Record<string, unknown> = { scorer };
      for (const run of runs) {
        entry[run.id] = run.summary.meanScores[scorer] ?? 0;
      }
      return entry;
    });
  }, [runs, scorerNames]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Scorer Overview (Radar)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <RadarChart data={chartData}>
            <PolarGrid />
            <PolarAngleAxis dataKey="scorer" tick={{ fontSize: 11 }} />
            <PolarRadiusAxis domain={[0, 1]} tick={{ fontSize: 10 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            {runs.map((run, i) => (
              <Radar
                key={run.id}
                dataKey={run.id}
                stroke={RUN_COLORS[i % RUN_COLORS.length]}
                fill={RUN_COLORS[i % RUN_COLORS.length]}
                fillOpacity={0.15}
              />
            ))}
          </RadarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function CostBarChart({ runs }: { runs: CompareRun[] }) {
  const chartConfig = useMemo(() => buildChartConfig(runs), [runs]);

  const chartData = useMemo(() => {
    const metrics = [
      { metric: 'Latency (ms)', key: 'totalLatencyMs' as const },
      { metric: 'Tokens In', key: 'totalTokensIn' as const },
      { metric: 'Tokens Out', key: 'totalTokensOut' as const },
    ];
    return metrics.map(({ metric, key }) => {
      const entry: Record<string, unknown> = { metric };
      for (const run of runs) {
        entry[run.id] = run.summary[key];
      }
      return entry;
    });
  }, [runs]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Cost Comparison</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[250px] w-full">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="metric" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            {runs.map((run, i) => (
              <Bar
                key={run.id}
                dataKey={run.id}
                fill={RUN_COLORS[i % RUN_COLORS.length]}
                radius={[4, 4, 0, 0]}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function CaseScoreTable({
  runs,
  scorerNames,
  caseDiffs,
}: {
  runs: CompareRun[];
  scorerNames: string[];
  caseDiffs: CompareResponse['caseDiffs'];
}) {
  if (caseDiffs.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Per-Case Scores ({caseDiffs.length} cases)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-h-[500px] overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="bg-background sticky left-0 z-10">
                  #
                </TableHead>
                {scorerNames.map((scorer) => (
                  <TableHead
                    key={scorer}
                    colSpan={runs.length}
                    className="text-center"
                  >
                    {scorer}
                  </TableHead>
                ))}
              </TableRow>
              <TableRow>
                <TableHead className="bg-background sticky left-0 z-10" />
                {scorerNames.map((scorer) =>
                  runs.map((run, i) => (
                    <TableHead key={`${scorer}-${run.id}`} className="text-xs">
                      <span
                        className="mr-1 inline-block h-2 w-2 rounded-full"
                        style={{
                          backgroundColor: RUN_COLORS[i % RUN_COLORS.length],
                        }}
                      />
                      {run.name}
                    </TableHead>
                  )),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {caseDiffs.map((diff) => (
                <TableRow key={diff.index}>
                  <TableCell className="text-muted-foreground bg-background sticky left-0 z-10">
                    {diff.index}
                  </TableCell>
                  {scorerNames.map((scorer) => {
                    const scorerScores = diff.scores[scorer] ?? {};
                    const values = runs.map((r) => scorerScores[r.id] ?? 0);
                    const maxVal = Math.max(...values);

                    return runs.map((run) => {
                      const val = scorerScores[run.id] ?? 0;
                      const isBest = values.length > 1 && val === maxVal;
                      return (
                        <TableCell
                          key={`${scorer}-${run.id}`}
                          className={`font-mono text-xs ${isBest ? 'font-semibold text-green-600' : 'text-muted-foreground'}`}
                        >
                          {val.toFixed(3)}
                        </TableCell>
                      );
                    });
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
