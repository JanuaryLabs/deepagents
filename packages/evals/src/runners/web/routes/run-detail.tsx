import { Hono } from 'hono';
import { raw } from 'hono/html';

import type { CaseWithScores } from '../../../store/index.ts';
import { Badge } from '../components/Badge.tsx';
import { CaseTable } from '../components/CaseTable.tsx';
import { Layout } from '../components/Layout.tsx';
import { StatsGrid } from '../components/StatsGrid.tsx';
import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

app.get('/:id', (c) => {
  const store = c.get('store');
  const runId = c.req.param('id');
  const run = store.getRun(runId);
  if (!run) {
    return c.text('Run not found', 404);
  }

  const summary = run.summary ?? store.getRunSummary(runId);
  const allCases = store.getFailingCases(runId, Infinity);
  const plainCases = store.getCases(runId);
  const scoredMap = new Map(allCases.map((cs) => [cs.id, cs]));
  const cases: CaseWithScores[] = plainCases.map(
    (cs) => scoredMap.get(cs.id) ?? { ...cs, scores: [] },
  );

  const scorerNames = [
    ...new Set(cases.flatMap((cs) => cs.scores.map((s) => s.scorer_name))),
  ];
  const isRunning = run.status === 'running';
  const runConfig = (run.config ?? {}) as Record<string, unknown>;
  const suite = store.listSuites().find((s) => s.id === run.suite_id);
  if (!suite) {
    return c.text('Suite not found for run', 500);
  }
  const promptLabel =
    typeof runConfig.promptName === 'string' &&
    typeof runConfig.promptVersion === 'number'
      ? `${runConfig.promptName} (v${runConfig.promptVersion})`
      : null;
  const selectedRecords =
    typeof runConfig.recordSelection === 'string' && runConfig.recordSelection
      ? runConfig.recordSelection
      : null;
  const threshold =
    typeof runConfig.threshold === 'number' ? runConfig.threshold : 0.5;

  const sseScript = isRunning
    ? raw(`<script>
(function() {
  var runId = ${JSON.stringify(runId)};
  var completed = ${cases.length};
  var es = new EventSource('/api/runs/' + runId + '/events');

  es.addEventListener('case:scored', function(e) {
    completed++;
    var data = JSON.parse(e.data);
    var count = document.getElementById('case-count');
    if (count) count.textContent = completed + ' / ' + (data.totalCases || '?');

    var bar = document.getElementById('progress-bar');
    if (bar && data.totalCases > 0) {
      bar.value = Math.round((completed / data.totalCases) * 100);
    }
  });

  es.addEventListener('run:end', function() {
    es.close();
    window.location.reload();
  });

  es.onerror = function() { es.close(); };
})();
</script>`)
    : '';

  return c.render(
    <Layout>
      <div class="mb-6 flex items-center justify-between">
        <div>
          <div class="flex items-center gap-3">
            <h1 class="text-2xl font-bold">{run.name}</h1>
            <Badge status={run.status} id="status-badge" />
          </div>
          <p class="mt-1 text-sm text-base-content/60">
            {run.model} &middot; {new Date(run.started_at).toLocaleString()}
          </p>
        </div>
        <div class="breadcrumbs text-sm">
          <ul>
            <li><a href="/suites">Suites</a></li>
            <li>
              <a href={`/suites/${suite.id}`}>{suite.name}</a>
            </li>
            <li>{run.name}</li>
          </ul>
        </div>
      </div>

      {isRunning && (
        <div class="mb-6">
          <div class="mb-1 flex items-center justify-between text-sm text-base-content/60">
            <span>Progress</span>
            <span id="case-count">{cases.length} / ?</span>
          </div>
          <progress id="progress-bar" class="progress progress-primary w-full" value="0" max="100" />
        </div>
      )}

      <div class="mb-8">
        <StatsGrid summary={summary} id="stats-grid" />
      </div>

      <div class="mb-6 overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
        <table class="table table-sm">
          <tbody>
            <tr>
              <th class="w-48">Suite</th>
              <td>
                <a href={`/suites/${suite.id}`} class="link link-primary">
                  {suite.name}
                </a>
              </td>
            </tr>
            <tr>
              <th>Dataset</th>
              <td>
                {typeof runConfig.dataset === 'string' ? runConfig.dataset : '—'}
              </td>
            </tr>
            <tr>
              <th>Prompt Version</th>
              <td>{promptLabel ?? '—'}</td>
            </tr>
            <tr>
              <th>Selected Records</th>
              <td>{selectedRecords ?? 'All records'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">Cases</h2>
        {scorerNames.length > 0 && (
          <p class="text-xs text-base-content/60">Scorers: {scorerNames.join(', ')}</p>
        )}
      </div>
      <p class="mb-3 text-xs text-base-content/60">
        Status meaning: <strong>FAIL (score)</strong> means output missed the threshold;
        <strong> ERROR (runtime)</strong> means the task crashed or timed out.
      </p>

      <CaseTable
        cases={cases}
        scorerNames={scorerNames}
        threshold={threshold}
        tbodyId="cases-tbody"
      />

      {sseScript}
    </Layout>,
  );
});

export default app;
