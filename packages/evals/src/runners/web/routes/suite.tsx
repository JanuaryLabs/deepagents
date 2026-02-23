import { Hono } from 'hono';
import { raw } from 'hono/html';

import { formatDuration, formatTokens } from '../../../reporters/format.ts';
import type { RunRow, SuiteRow } from '../../../store/index.ts';
import { Badge } from '../components/Badge.tsx';
import { Layout } from '../components/Layout.tsx';
import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

interface SuiteWithRuns {
  suite: SuiteRow;
  runs: RunRow[];
}

function suiteStats(runs: RunRow[]) {
  const completedRuns = runs.filter((r) => r.status === 'completed' && r.summary);

  const totalCases = completedRuns.reduce(
    (sum, run) => sum + (run.summary?.totalCases ?? 0),
    0,
  );
  const totalPass = completedRuns.reduce(
    (sum, run) => sum + (run.summary?.passCount ?? 0),
    0,
  );
  const totalFail = completedRuns.reduce(
    (sum, run) => sum + (run.summary?.failCount ?? 0),
    0,
  );
  const totalLatency = completedRuns.reduce(
    (sum, run) => sum + (run.summary?.totalLatencyMs ?? 0),
    0,
  );
  const totalTokens = completedRuns.reduce(
    (sum, run) =>
      sum + (run.summary?.totalTokensIn ?? 0) + (run.summary?.totalTokensOut ?? 0),
    0,
  );

  return {
    completedRuns,
    totalCases,
    totalPass,
    totalFail,
    totalLatency,
    totalTokens,
  };
}

app.get('/', (c) => {
  const store = c.get('store');
  const suites = store.listSuites();
  const suiteRows: SuiteWithRuns[] = suites.map((suite) => ({
    suite,
    runs: store.listRuns(suite.id).reverse(),
  }));

  return c.render(
    <Layout title="Suites">
      {suiteRows.length === 0 ? (
        <div class="rounded-lg border-2 border-dashed border-base-content/20 p-12 text-center">
          <p class="text-sm text-base-content/60">No suites yet.</p>
          <a href="/evals/new" class="mt-2 inline-block text-sm font-medium link link-primary">
            Run your first eval
          </a>
        </div>
      ) : (
        <>
          <div class="mb-4 flex items-center justify-between">
            <p class="text-sm text-base-content/60">
              {suiteRows.length} suite{suiteRows.length !== 1 ? 's' : ''}
            </p>
            <a href="/evals/new" class="btn btn-neutral btn-sm">
              New Eval
            </a>
          </div>
          <div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
            <table class="table table-zebra table-sm">
              <thead>
                <tr>
                  <th>Suite</th>
                  <th>Runs</th>
                  <th>Running</th>
                  <th>Completed</th>
                  <th>Failed</th>
                  <th>Last Started</th>
                </tr>
              </thead>
              <tbody>
                {suiteRows.map(({ suite, runs }) => {
                  const runningCount = runs.filter((r) => r.status === 'running').length;
                  const completedCount = runs.filter((r) => r.status === 'completed').length;
                  const failedCount = runs.filter((r) => r.status === 'failed').length;
                  const latestStart = runs[0]?.started_at;
                  return (
                    <tr>
                      <td>
                        <a href={`/suites/${suite.id}`} class="link link-primary font-medium">
                          {suite.name}
                        </a>
                        <p class="text-xs text-base-content/50">
                          Created {new Date(suite.created_at).toLocaleString()}
                        </p>
                      </td>
                      <td>{runs.length}</td>
                      <td>
                        {runningCount > 0 ? (
                          <span class="badge badge-info badge-sm">{runningCount}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                      <td>{completedCount}</td>
                      <td>{failedCount}</td>
                      <td class="text-xs text-base-content/60">
                        {latestStart ? new Date(latestStart).toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Layout>,
  );
});

app.get('/:id', (c) => {
  const store = c.get('store');
  const suiteId = c.req.param('id');
  const suite = store.listSuites().find((s) => s.id === suiteId);

  if (!suite) {
    return c.text('Suite not found', 404);
  }

  const runs = store.listRuns(suiteId).reverse();
  const {
    completedRuns,
    totalCases,
    totalPass,
    totalFail,
    totalLatency,
    totalTokens,
  } = suiteStats(runs);
  const runningIds = runs
    .filter((run) => run.status === 'running')
    .map((run) => run.id);

  const sseScript =
    runningIds.length > 0
      ? raw(`<script>
(function() {
  ${JSON.stringify(runningIds)}.forEach(function(runId) {
    var es = new EventSource('/api/runs/' + runId + '/events');
    es.addEventListener('case:scored', function(e) {
      var data = JSON.parse(e.data);
      var bar = document.getElementById('progress-' + runId);
      if (bar && data.totalCases > 0) {
        bar.value = Math.round((data.completed / data.totalCases) * 100);
      }
    });
    es.addEventListener('run:end', function() {
      es.close();
      window.location.reload();
    });
    es.onerror = function() { es.close(); };
  });
})();
</script>`)
      : '';

  return c.render(
    <Layout>
      <div class="mb-6 flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold">{suite.name}</h1>
          <p class="mt-1 text-sm text-base-content/60">
            Suite &middot; {runs.length} run{runs.length !== 1 ? 's' : ''}{' '}
            &middot; Created {new Date(suite.created_at).toLocaleDateString()}
          </p>
        </div>
        <div class="breadcrumbs text-sm">
          <ul>
            <li><a href="/suites">Suites</a></li>
            <li>{suite.name}</li>
          </ul>
        </div>
      </div>

      {completedRuns.length > 0 && (
        <div class="stats shadow mb-8 w-full">
          <div class="stat">
            <div class="stat-title">Total Cases</div>
            <div class="stat-value text-lg">{totalCases}</div>
          </div>
          <div class="stat">
            <div class="stat-title">Passed</div>
            <div class="stat-value text-lg text-success">{totalPass}</div>
          </div>
          <div class="stat">
            <div class="stat-title">Failed</div>
            <div class="stat-value text-lg text-error">{totalFail}</div>
          </div>
          <div class="stat">
            <div class="stat-title">Total Latency</div>
            <div class="stat-value text-lg">{formatDuration(totalLatency)}</div>
          </div>
          <div class="stat">
            <div class="stat-title">Total Tokens</div>
            <div class="stat-value text-lg">{formatTokens(totalTokens)}</div>
          </div>
        </div>
      )}

      {completedRuns.length > 1 && (
        <div class="mb-6">
          <a
            href={`/compare?baseline=${completedRuns[1]?.id}&candidate=${completedRuns[0]?.id}`}
            class="link link-primary text-sm font-medium"
          >
            Compare latest two completed runs
          </a>
        </div>
      )}

      <div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
        <table class="table table-zebra table-sm">
          <thead>
            <tr>
              <th>Run</th>
              <th>Model</th>
              <th>Started</th>
              <th>Status</th>
              <th>Cases</th>
              <th>Pass</th>
              <th>Fail</th>
              <th>Latency</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr>
                <td>
                  <a href={`/runs/${run.id}`} class="link link-primary font-medium">
                    {run.name}
                  </a>
                </td>
                <td class="text-xs">{run.model}</td>
                <td class="text-xs text-base-content/60">
                  {new Date(run.started_at).toLocaleString()}
                </td>
                <td class="min-w-40">
                  <div class="space-y-2">
                    <Badge status={run.status} />
                    {run.status === 'running' && (
                      <progress
                        id={`progress-${run.id}`}
                        class="progress progress-primary w-full"
                        value="0"
                        max="100"
                      />
                    )}
                  </div>
                </td>
                <td>{run.summary?.totalCases ?? '—'}</td>
                <td class="text-success">{run.summary?.passCount ?? '—'}</td>
                <td class="text-error">{run.summary?.failCount ?? '—'}</td>
                <td class="text-xs">
                  {run.summary ? formatDuration(run.summary.totalLatencyMs) : '—'}
                </td>
                <td class="text-xs">
                  {run.summary
                    ? formatTokens(run.summary.totalTokensIn + run.summary.totalTokensOut)
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sseScript}
    </Layout>,
  );
});

export default app;
