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

  const key = runningRunIds.join(',');

  useEffect(() => {
    if (runningRunIds.length === 0) return;

    const sources = runningRunIds.map((runId) => {
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
  }, [key]);
}
