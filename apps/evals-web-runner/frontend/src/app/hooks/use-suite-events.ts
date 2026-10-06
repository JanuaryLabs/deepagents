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
        const data = JSON.parse(e.data);
        caseScored({
          runId,
          completed: data.completed,
          totalCases: data.totalCases,
        });
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
