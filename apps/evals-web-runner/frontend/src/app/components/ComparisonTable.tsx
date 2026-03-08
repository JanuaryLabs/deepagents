import { Fragment } from 'react';

import type { Endpoints } from '../hooks/use-client.ts';
import { formatDelta } from '../lib/format.ts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../shadcn/index.ts';

type RegressionDetail = { exceeds: boolean; meanDelta: number };
type ComparisonResult = Endpoints['GET /compare']['output']['result'];
type ScorerDelta = {
  baseline: number;
  candidate: number;
  change: 'improved' | 'regressed' | 'unchanged';
  delta: number;
};

function deltaClass(change: string): string {
  if (change === 'improved') return 'text-green-600';
  if (change === 'regressed') return 'text-destructive';
  return 'text-muted-foreground';
}

export function ComparisonTable({ result }: { result: ComparisonResult }) {
  const scorerNames = Object.keys(result.scorerSummaries);
  const regressionDetails = result.regression.details as unknown as Record<
    string,
    RegressionDetail
  >;

  return (
    <div className="space-y-8">
      {result.regression.regressed && (
        <div className="bg-destructive/10 border-destructive/30 rounded-lg border p-4">
          <p className="text-destructive text-sm font-medium">
            Regression detected
          </p>
          <ul className="text-destructive mt-1 text-sm">
            {Object.entries(regressionDetails)
              .filter(([, d]) => d.exceeds)
              .map(([name, d]) => (
                <li key={name}>
                  {name}: {formatDelta(d.meanDelta)}
                </li>
              ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="text-muted-foreground mb-3 text-sm font-medium uppercase">
          Scorer Summaries
        </h3>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scorer</TableHead>
                <TableHead>Mean Delta</TableHead>
                <TableHead>Improved</TableHead>
                <TableHead>Regressed</TableHead>
                <TableHead>Unchanged</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(result.scorerSummaries).map(([name, s]) => (
                <TableRow key={name}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell
                    className={`font-mono ${
                      s.meanDelta > 0
                        ? 'text-green-600'
                        : s.meanDelta < 0
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                    }`}
                  >
                    {formatDelta(s.meanDelta)}
                  </TableCell>
                  <TableCell className="text-green-600">
                    {s.improvedCount}
                  </TableCell>
                  <TableCell className="text-destructive">
                    {s.regressedCount}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.unchangedCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div>
        <h3 className="text-muted-foreground mb-3 text-sm font-medium uppercase">
          Cost Delta
        </h3>
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-normal">
                Latency
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-lg font-semibold">
                {formatDelta(result.costDelta.latencyDeltaMs)}ms
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
              <p className="font-mono text-lg font-semibold">
                {formatDelta(result.costDelta.tokenInDelta)}
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
              <p className="font-mono text-lg font-semibold">
                {formatDelta(result.costDelta.tokenOutDelta)}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <div>
        <h3 className="text-muted-foreground mb-3 text-sm font-medium uppercase">
          Case Diffs ({result.totalCasesCompared} cases)
        </h3>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                {scorerNames.map((name) => (
                  <TableHead key={`${name}-base`} colSpan={3}>
                    {name}
                  </TableHead>
                ))}
              </TableRow>
              <TableRow>
                <TableHead />
                {scorerNames.map((name) => (
                  <Fragment key={name}>
                    <TableHead className="text-xs">Base</TableHead>
                    <TableHead className="text-xs">Cand</TableHead>
                    <TableHead className="text-xs">Delta</TableHead>
                  </Fragment>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.caseDiffs.map((diff) => (
                <TableRow key={diff.index}>
                  <TableCell className="text-muted-foreground">
                    {diff.index}
                  </TableCell>
                  {scorerNames.map((name) => {
                    const deltas = diff.scorerDeltas as unknown as Record<
                      string,
                      ScorerDelta
                    >;
                    const d = deltas[name];
                    if (!d) {
                      return (
                        <Fragment key={name}>
                          <TableCell>{'\u2014'}</TableCell>
                          <TableCell>{'\u2014'}</TableCell>
                          <TableCell>{'\u2014'}</TableCell>
                        </Fragment>
                      );
                    }
                    return (
                      <Fragment key={name}>
                        <TableCell className="text-muted-foreground font-mono">
                          {d.baseline.toFixed(3)}
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono">
                          {d.candidate.toFixed(3)}
                        </TableCell>
                        <TableCell
                          className={`font-mono ${deltaClass(d.change)}`}
                        >
                          {formatDelta(d.delta)}
                        </TableCell>
                      </Fragment>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
