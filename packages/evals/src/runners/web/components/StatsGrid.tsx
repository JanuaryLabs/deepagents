import type { FC } from 'hono/jsx';
import type { RunSummary } from '../../../store/index.ts';
import { formatDuration, formatTokens } from '../../../reporters/format.ts';

export const StatsGrid: FC<{ summary: RunSummary; id?: string }> = ({ summary, id }) => (
  <div id={id} class="stats shadow w-full">
    <div class="stat">
      <div class="stat-title">Total Cases</div>
      <div class="stat-value text-lg" id="stat-total">{summary.totalCases}</div>
    </div>
    <div class="stat">
      <div class="stat-title">Passed</div>
      <div class="stat-value text-lg text-success" id="stat-pass">{summary.passCount}</div>
    </div>
    <div class="stat">
      <div class="stat-title">Failed</div>
      <div class="stat-value text-lg text-error" id="stat-fail">{summary.failCount}</div>
    </div>
    <div class="stat">
      <div class="stat-title">Latency</div>
      <div class="stat-value text-lg" id="stat-latency">{formatDuration(summary.totalLatencyMs)}</div>
    </div>
    <div class="stat">
      <div class="stat-title">Tokens In</div>
      <div class="stat-value text-lg" id="stat-tokens-in">{formatTokens(summary.totalTokensIn)}</div>
    </div>
    <div class="stat">
      <div class="stat-title">Tokens Out</div>
      <div class="stat-value text-lg" id="stat-tokens-out">{formatTokens(summary.totalTokensOut)}</div>
    </div>
  </div>
);
