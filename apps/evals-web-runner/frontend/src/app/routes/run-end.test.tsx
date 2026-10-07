import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';

import { queryClient } from '../hooks/query-client.ts';
import RunDetailPage from './runs/RunDetail.tsx';
import RunListPage from './runs/RunList.tsx';
import SuiteDetailPage from './suites/SuiteDetail.tsx';

/** Stands in for the browser's EventSource; a test sends the events the backend writes. */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {}

  send(event: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
}

const suiteId = 'ed4aff62-ee00-4afb-82a6-e3810cd1052e';
const runId = '1c49bfaa-f232-4067-9966-af4690c64881';

// Shaped like the evals backend's responses (captured from GET /api/runs/{id},
// GET /api/runs and GET /api/suites/{id}) for a run with no cases: a running
// run has no summary and its suite no stats; a completed run carries both.
const config = {
  taskMode: 'http',
  endpointUrl: 'http://localhost:8009/api/sql-agent',
  dataset: 'harvard-metrics.json',
  suiteId,
  suiteName: 'GI',
  model: 'openai/gpt-4.1-nano',
  recordSelection: null,
  scorers: ['exactMatch'],
  inputField: 'question',
  expectedField: 'answer',
  maxConcurrency: 10,
  timeout: 30000,
  trials: 1,
  threshold: 0.5,
};
const suite = { id: suiteId, name: 'GI', created_at: 1772575258732 };

const summary = {
  totalCases: 0,
  passCount: 0,
  failCount: 0,
  meanScores: {},
  totalLatencyMs: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
};

function runRow(finished: boolean) {
  return {
    id: runId,
    suite_id: suiteId,
    name: 'GI [openai/gpt-4.1-nano]',
    model: 'openai/gpt-4.1-nano',
    config,
    started_at: 1772575258733,
    finished_at: finished ? 1772575290000 : null,
    status: finished ? 'completed' : 'running',
    summary: finished ? summary : null,
  };
}

const completedSuiteStats = {
  totalCases: 0,
  totalPass: 0,
  totalFail: 0,
  totalLatency: 0,
  totalTokens: 0,
};

/** What each page's endpoint answers before and after the run ends. */
const pages: Array<{
  name: string;
  path: string;
  route: string;
  Page: ComponentType;
  endpoint: string;
  body: (finished: boolean) => unknown;
}> = [
  {
    name: 'run page',
    path: `/runs/${runId}`,
    route: '/runs/:id',
    Page: RunDetailPage,
    endpoint: `/api/runs/${runId}`,
    body: (finished) => ({
      run: runRow(finished),
      summary,
      cases: [],
      scorerNames: [],
      suite,
      config,
    }),
  },
  {
    name: 'runs list',
    path: '/runs',
    route: '/runs',
    Page: RunListPage,
    endpoint: '/api/runs',
    body: (finished) => ({
      groups: [{ suiteId, suiteName: 'GI', runs: [runRow(finished)] }],
      totalRuns: 1,
    }),
  },
  {
    name: 'suite page',
    path: `/suites/${suiteId}`,
    route: '/suites/:id',
    Page: SuiteDetailPage,
    endpoint: `/api/suites/${suiteId}`,
    body: (finished) => ({
      suite,
      runs: [runRow(finished)],
      stats: finished ? completedSuiteStats : null,
    }),
  },
];

for (const { name, path, route, Page, endpoint, body } of pages) {
  it(`shows the finished run on the ${name} as soon as the run ends`, async () => {
    let finished = false;
    const unexpected: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const pathname = new URL(request.url).pathname;
        if (request.method !== 'GET' || pathname !== endpoint) {
          unexpected.push(`${request.method} ${pathname}`);
          throw new Error(`Unexpected request: ${request.method} ${pathname}`);
        }
        return Response.json(body(finished));
      }),
    );
    vi.stubGlobal('EventSource', FakeEventSource);
    try {
      const router = createMemoryRouter([{ path: route, Component: Page }], {
        initialEntries: [path],
      });
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText('running')).toBeTruthy();
      const [events] = FakeEventSource.instances;
      expect(events.url).toBe(`/api/runs/${runId}/events`);

      finished = true;
      events.send('run:end', { runId, summary });

      // The pages poll every 5s while a run is running; finding the finished
      // run within findByText's 1s means run:end refreshed it.
      expect(await screen.findByText('completed')).toBeTruthy();
      expect(screen.queryByText('running')).toBeNull();
      expect(unexpected).toEqual([]);
    } finally {
      cleanup();
      queryClient.clear();
      FakeEventSource.instances = [];
      vi.unstubAllGlobals();
    }
  });
}
