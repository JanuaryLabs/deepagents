import { cleanup, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { useSuiteEvents } from './use-suite-events.ts';

/** Stands in for the browser's EventSource; a test sends the events the backend writes. */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onerror: (() => void) | null = null;
  readonly #closed = new AbortController();

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  get closed() {
    return this.#closed.signal.aborted;
  }

  close() {
    this.#closed.abort();
  }

  send(event: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
}

/** A `case:scored` event as events.route.ts writes it: the engine's event plus the run's progress. */
function caseScored(progress: Record<string, unknown>) {
  return {
    runId: 'run-1',
    index: 0,
    input: { question: 'What is 2 + 2?' },
    output: '4',
    expected: '4',
    scores: { exactMatch: { score: 1 } },
    latencyMs: 812,
    tokensIn: 41,
    tokensOut: 3,
    ...progress,
  };
}

it('skips a case:scored event without numeric progress and reports the next one', () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  const onCaseScored = vi.fn();
  try {
    renderHook(() => useSuiteEvents(['run-1'], { onCaseScored }));
    const [source] = FakeEventSource.instances;
    expect(source.url).toBe('/api/runs/run-1/events');

    source.send('case:scored', caseScored({ completed: 1 }));
    source.send('case:scored', caseScored({ completed: '1', totalCases: 3 }));
    source.send('case:scored', caseScored({ completed: 1, totalCases: '3' }));
    expect(onCaseScored).not.toHaveBeenCalled();
    expect(source.closed).toBe(false);

    source.send('case:scored', caseScored({ completed: 2, totalCases: 3 }));
    expect(onCaseScored).toHaveBeenCalledTimes(1);
    expect(onCaseScored).toHaveBeenCalledWith({
      runId: 'run-1',
      completed: 2,
      totalCases: 3,
    });
  } finally {
    cleanup();
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
  }
});
