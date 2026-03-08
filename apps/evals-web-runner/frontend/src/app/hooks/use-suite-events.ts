import { useEffect, useRef } from 'react';

interface SuiteEventCallbacks {
  onCaseScored?: (data: {
    runId: string;
    completed: number;
    totalCases: number;
  }) => void;
  onRunEnd?: (runId: string) => void;
}

export function useSuiteEvents(
  runningRunIds: string[],
  callbacks: SuiteEventCallbacks,
) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const runIdsKey = runningRunIds.join(',');

  useEffect(() => {
    const runIds = runIdsKey ? runIdsKey.split(',') : [];
    if (runIds.length === 0) return;

    const sources = runIds.map((runId) => {
      const es = new EventSource(`/api/runs/${runId}/events`);

      es.addEventListener('case:scored', (e) => {
        const data = JSON.parse(e.data);
        callbacksRef.current.onCaseScored?.({
          runId,
          completed: data.completed,
          totalCases: data.totalCases,
        });
      });

      es.addEventListener('run:end', () => {
        callbacksRef.current.onRunEnd?.(runId);
        es.close();
      });

      es.onerror = () => es.close();

      return es;
    });

    return () => sources.forEach((es) => es.close());
  }, [runIdsKey]);
}
