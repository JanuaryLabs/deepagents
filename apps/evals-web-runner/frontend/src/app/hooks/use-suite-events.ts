import { useEffect, useEffectEvent } from 'react';

interface CaseScored {
  runId: string;
  completed: number;
  totalCases: number;
}

interface SuiteEventCallbacks {
  onCaseScored?: (data: CaseScored) => void;
  onRunEnd?: (runId: string) => void;
}

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
  const runEnded = useEffectEvent((runId: string) =>
    callbacks.onRunEnd?.(runId),
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
        runEnded(runId);
        es.close();
      });

      es.onerror = () => es.close();

      return es;
    });

    return () => sources.forEach((es) => es.close());
  }, [runIdsKey]);
}
