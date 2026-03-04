import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../shadcn/index.ts';
import { formatDuration, formatTokens } from '../lib/format.ts';

interface RunSummary {
  totalCases: number;
  passCount: number;
  failCount: number;
  meanScores: Record<string, number>;
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

interface StatsGridProps {
  summary: RunSummary;
  scorerNames?: string[];
  threshold?: number;
}

export function StatsGrid({
  summary,
  scorerNames = [],
  threshold = 0.5,
}: StatsGridProps) {
  const meanScores = summary.meanScores ?? {};

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-6 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm font-normal">
              Total Cases
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{summary.totalCases}</p>
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
              {summary.passCount}
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
              {summary.failCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm font-normal">
              Latency
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {formatDuration(summary.totalLatencyMs)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm font-normal">
              Tokens In
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {formatTokens(summary.totalTokensIn)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm font-normal">
              Tokens Out
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {formatTokens(summary.totalTokensOut)}
            </p>
          </CardContent>
        </Card>
      </div>

      {scorerNames.length > 0 && (
        <div className="grid grid-cols-6 gap-4">
          {scorerNames.map((name) => {
            const mean = meanScores[name];
            const hasMean = mean != null;
            const passing = hasMean && mean >= threshold;

            return (
              <Card key={name}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-muted-foreground text-sm font-normal">
                    {name}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p
                    className={`font-mono text-lg font-semibold ${
                      !hasMean
                        ? 'text-muted-foreground'
                        : passing
                          ? 'text-green-600'
                          : 'text-destructive'
                    }`}
                  >
                    {hasMean ? mean.toFixed(3) : '\u2014'}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
