import { useEffect, useEffectEvent } from 'react';

import { invalidateData } from './use-client.ts';

interface CaseScored {
  runId: string;
  completed: number;
  totalCases: number;
}

interface SuiteEventCallbacks {
  onCaseScored?: (data: CaseScored) => void;
}

/** The data a finished run changes: the run, the runs list and its suite. */
const RUN_END_ENDPOINTS = [
  'GET /runs/{id}',
  'GET /runs',
  'GET /suites/{id}',
] as const;

/** The run's progress that events.route.ts adds to each `case:scored` event. */
function readProgress(
  data: string,
): Pick<CaseScored, 'completed' | 'totalCases'> | undefined {
  const event: unknown = JSON.parse(data);
  if (
    typeof event !== 'object' ||
    event === null ||
    !('completed' in event) ||
    !('totalCases' in event)
  ) {
    return undefined;
  }
  const { completed, totalCases } = event;
  return typeof completed === 'number' && typeof totalCases === 'number'
    ? { completed, totalCases }
    : undefined;
}

export function useSuiteEvents(
  runningRunIds: string[],
  callbacks: SuiteEventCallbacks,
) {
  const caseScored = useEffectEvent((data: CaseScored) =>
    callbacks.onCaseScored?.(data),
  );

  const runIdsKey = runningRunIds.join(',');

  useEffect(() => {
    const runIds = runIdsKey ? runIdsKey.split(',') : [];
    if (runIds.length === 0) return;

    const sources = runIds.map((runId) => {
      const es = new EventSource(`/api/runs/${runId}/events`);

      es.addEventListener('case:scored', (e) => {
        // An event without progress has nothing to show; run:end refreshes the run.
        const progress = readProgress(e.data);
        if (progress) caseScored({ runId, ...progress });
      });

      es.addEventListener('run:end', () => {
        // Refetch every mounted view of these endpoints, whatever their input.
        for (const endpoint of RUN_END_ENDPOINTS) {
          void invalidateData(endpoint);
        }
        es.close();
      });

      es.onerror = () => es.close();

      return es;
    });

    return () => sources.forEach((es) => es.close());
  }, [runIdsKey]);
}
