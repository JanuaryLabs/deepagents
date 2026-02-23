import type { FC } from 'hono/jsx';
import type { RunRow } from '../../../store/index.ts';
import { Badge } from './Badge.tsx';
import { formatDuration, formatTokens } from '../../../reporters/format.ts';

export const RunCard: FC<{ run: RunRow }> = ({ run }) => {
  const date = new Date(run.started_at).toLocaleString();
  const scores = run.summary?.meanScores ?? {};

  return (
    <a href={`/runs/${run.id}`} class="card card-border bg-base-100 card-sm hover:shadow-md transition-all">
      <div class="card-body">
        <div class="flex items-start justify-between">
          <div>
            <h3 class="text-sm font-semibold">{run.name}</h3>
            <p class="mt-1 text-xs text-base-content/60">{run.model}</p>
          </div>
          <Badge status={run.status} />
        </div>

        {run.status === 'running' && (
          <div class="mt-3">
            <progress
              id={`progress-${run.id}`}
              class="progress progress-primary w-full"
              value="0"
              max="100"
            />
          </div>
        )}

        {run.summary && (
          <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/60">
            <span>
              <span class="text-success font-medium">{run.summary.passCount}</span>
              {' / '}
              <span class="text-error font-medium">{run.summary.failCount}</span>
              {' pass/fail'}
            </span>
            <span>{formatDuration(run.summary.totalLatencyMs)}</span>
            <span>{formatTokens(run.summary.totalTokensIn + run.summary.totalTokensOut)} tokens</span>
          </div>
        )}

        {Object.keys(scores).length > 0 && (
          <div class="mt-2 flex flex-wrap gap-2">
            {Object.entries(scores).map(([name, score]) => (
              <span class="badge badge-ghost badge-sm">
                {name}: {score.toFixed(3)}
              </span>
            ))}
          </div>
        )}

        <p class="mt-3 text-xs text-base-content/40">{date}</p>
      </div>
    </a>
  );
};
