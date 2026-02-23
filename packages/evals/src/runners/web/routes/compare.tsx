import { Hono } from 'hono';
import { raw } from 'hono/html';

import { compareRuns } from '../../../comparison/index.ts';
import { ComparisonTable } from '../components/ComparisonTable.tsx';
import { Layout } from '../components/Layout.tsx';
import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

app.get('/', (c) => {
  const store = c.get('store');
  const baseline = c.req.query('baseline');
  const candidate = c.req.query('candidate');

  const runs = store.listRuns().reverse();
  const completedRuns = runs.filter((r) => r.status === 'completed');

  if (!baseline || !candidate) {
    return c.render(
      <Layout title="Compare Runs">
        <form method="get" action="/compare" class="max-w-lg space-y-4">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Baseline Run</legend>
            <select
              name="baseline"
              required
              class="select select-sm w-full"
            >
              <option value="">Select a run...</option>
              {completedRuns.map((r) => (
                <option value={r.id}>
                  {r.name} — {r.model} (
                  {new Date(r.started_at).toLocaleDateString()})
                </option>
              ))}
            </select>
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Candidate Run</legend>
            <select
              name="candidate"
              required
              class="select select-sm w-full"
            >
              <option value="">Select a run...</option>
              {completedRuns.map((r) => (
                <option value={r.id}>
                  {r.name} — {r.model} (
                  {new Date(r.started_at).toLocaleDateString()})
                </option>
              ))}
            </select>
          </fieldset>
          <button type="submit" class="btn btn-neutral btn-sm">
            Compare
          </button>
        </form>

        {raw(`<script>
document.addEventListener('submit', function(e) {
  var btn = e.target.querySelector('button[type="submit"]');
  if (btn) {
    btn.disabled = true;
    var spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-sm';
    btn.prepend(spinner);
  }
});
</script>`)}
      </Layout>,
    );
  }

  const baselineRun = store.getRun(baseline);
  const candidateRun = store.getRun(candidate);

  if (!baselineRun || !candidateRun) {
    return c.text('One or both runs not found.', 404);
  }

  const result = compareRuns(store, baseline, candidate);

  return c.render(
    <Layout>
      <div class="mb-6">
        <h1 class="text-2xl font-bold">Run Comparison</h1>
        <p class="mt-1 text-sm text-base-content/60">
          <span class="font-medium">{baselineRun.name}</span> (
          {baselineRun.model}){' vs '}
          <span class="font-medium">{candidateRun.name}</span> (
          {candidateRun.model})
        </p>
      </div>
      <ComparisonTable result={result} />
    </Layout>,
  );
});

export default app;
