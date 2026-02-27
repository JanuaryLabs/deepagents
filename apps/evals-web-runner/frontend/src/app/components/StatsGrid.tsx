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
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export function StatsGrid({ summary }: { summary: RunSummary }) {
  return (
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
  );
}
