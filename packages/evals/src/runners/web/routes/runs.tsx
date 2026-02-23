import { Hono } from 'hono';
import { raw } from 'hono/html';

import { formatDuration, formatTokens } from '../../../reporters/format.ts';
import type { RunRow } from '../../../store/index.ts';
import { Badge } from '../components/Badge.tsx';
import { Layout } from '../components/Layout.tsx';
import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

app.get('/', (c) => {
  const store = c.get('store');
  const runs = store.listRuns().reverse();
  const suites = store.listSuites();
  const suitesById = new Map(suites.map((suite) => [suite.id, suite]));
  const runningIds = runs
    .filter((r) => r.status === 'running')
    .map((r) => r.id);

  const groups: Array<{
    suiteId: string;
    suiteName: string;
    runs: RunRow[];
  }> = [];
  const groupByKey = new Map<string, (typeof groups)[number]>();
  for (const run of runs) {
    const key = run.suite_id;
    let group = groupByKey.get(key);
    if (!group) {
      group = {
        suiteId: run.suite_id,
        suiteName: suitesById.get(run.suite_id)?.name ?? 'Unknown Suite',
        runs: [],
      };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.runs.push(run);
  }

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
    <Layout title="Runs">
      {runs.length === 0 ? (
        <div class="rounded-lg border-2 border-dashed border-base-content/20 p-12 text-center">
          <p class="text-sm text-base-content/60">No eval runs yet.</p>
          <a href="/evals/new" class="mt-2 inline-block text-sm font-medium link link-primary">
            Run your first eval
          </a>
        </div>
      ) : (
        <>
          <div class="mb-4 flex items-center justify-between">
            <div>
              <p class="text-sm text-base-content/60">
                {runs.length} run{runs.length !== 1 ? 's' : ''}
              </p>
              <p class="text-xs text-base-content/50">
                A suite groups related runs. A run is one execution.
              </p>
            </div>
            <a href="/evals/new" class="btn btn-neutral btn-sm">
              New Eval
            </a>
          </div>

          <div class="space-y-6">
            {groups.map((group) => (
              <section>
                <div class="mb-2 flex items-center justify-between">
                  <h2 class="text-sm font-semibold">
                    <a
                      href={`/suites/${group.suiteId}`}
                      class="link link-primary"
                    >
                      {group.suiteName}
                    </a>
                  </h2>
                  <span class="text-xs text-base-content/50">
                    {group.runs.length} run
                    {group.runs.length === 1 ? '' : 's'}
                  </span>
                </div>

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
                        <th>Mean Scores</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.runs.map((run) => (
                        <tr>
                          <td>
                            <a
                              href={`/runs/${run.id}`}
                              class="link link-primary font-medium"
                            >
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
                          <td class="text-success">
                            {run.summary?.passCount ?? '—'}
                          </td>
                          <td class="text-error">
                            {run.summary?.failCount ?? '—'}
                          </td>
                          <td class="text-xs">
                            {run.summary
                              ? formatDuration(run.summary.totalLatencyMs)
                              : '—'}
                          </td>
                          <td class="text-xs">
                            {run.summary
                              ? formatTokens(
                                  run.summary.totalTokensIn +
                                    run.summary.totalTokensOut,
                                )
                              : '—'}
                          </td>
                          <td class="text-xs max-w-sm">
                            {run.summary &&
                            Object.keys(run.summary.meanScores).length > 0
                              ? Object.entries(run.summary.meanScores)
                                  .map(
                                    ([name, score]) =>
                                      `${name}: ${score.toFixed(3)}`,
                                  )
                                  .join(', ')
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
      {sseScript}
    </Layout>,
  );
});

export default app;
