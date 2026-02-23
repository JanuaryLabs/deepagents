import type { FC } from 'hono/jsx';
import type { ComparisonResult } from '../../../comparison/index.ts';

function deltaClass(change: string): string {
  if (change === 'improved') return 'text-success';
  if (change === 'regressed') return 'text-error';
  return 'text-base-content/40';
}

function formatDelta(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(3)}`;
}

export const ComparisonTable: FC<{ result: ComparisonResult }> = ({ result }) => {
  const scorerNames = Object.keys(result.scorerSummaries);

  return (
    <div class="space-y-8">
      {result.regression.regressed && (
        <div role="alert" class="alert alert-error">
          <span class="text-sm font-medium">Regression detected</span>
          <ul class="mt-1 text-sm">
            {Object.entries(result.regression.details)
              .filter(([, d]) => d.exceeds)
              .map(([name, d]) => (
                <li>{name}: {formatDelta(d.meanDelta)}</li>
              ))}
          </ul>
        </div>
      )}

      <div>
        <div class="divider">Scorer Summaries</div>
        <div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
          <table class="table table-zebra table-sm">
            <thead>
              <tr>
                <th>Scorer</th>
                <th>Mean Delta</th>
                <th>Improved</th>
                <th>Regressed</th>
                <th>Unchanged</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result.scorerSummaries).map(([name, s]) => (
                <tr>
                  <td class="font-medium">{name}</td>
                  <td class={`font-mono ${s.meanDelta > 0 ? 'text-success' : s.meanDelta < 0 ? 'text-error' : 'text-base-content/40'}`}>
                    {formatDelta(s.meanDelta)}
                  </td>
                  <td class="text-success">{s.improvedCount}</td>
                  <td class="text-error">{s.regressedCount}</td>
                  <td class="text-base-content/40">{s.unchangedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div class="divider">Cost Delta</div>
        <div class="stats shadow w-full">
          <div class="stat">
            <div class="stat-title">Latency</div>
            <div class="stat-value text-lg font-mono">{formatDelta(result.costDelta.latencyDeltaMs)}ms</div>
          </div>
          <div class="stat">
            <div class="stat-title">Tokens In</div>
            <div class="stat-value text-lg font-mono">{formatDelta(result.costDelta.tokenInDelta)}</div>
          </div>
          <div class="stat">
            <div class="stat-title">Tokens Out</div>
            <div class="stat-value text-lg font-mono">{formatDelta(result.costDelta.tokenOutDelta)}</div>
          </div>
        </div>
      </div>

      <div>
        <div class="divider">Case Diffs ({result.totalCasesCompared} cases)</div>
        <div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
          <table class="table table-zebra table-pin-rows table-sm">
            <thead>
              <tr>
                <th>#</th>
                {scorerNames.map((name) => (
                  <>
                    <th>{name} (base)</th>
                    <th>{name} (cand)</th>
                    <th>{name} (delta)</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.caseDiffs.map((diff) => (
                <tr>
                  <td class="text-base-content/60">{diff.index}</td>
                  {scorerNames.map((name) => {
                    const d = diff.scorerDeltas[name];
                    if (!d) return <><td>—</td><td>—</td><td>—</td></>;
                    return (
                      <>
                        <td class="font-mono text-base-content/70">{d.baseline.toFixed(3)}</td>
                        <td class="font-mono text-base-content/70">{d.candidate.toFixed(3)}</td>
                        <td class={`font-mono ${deltaClass(d.change)}`}>{formatDelta(d.delta)}</td>
                      </>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
