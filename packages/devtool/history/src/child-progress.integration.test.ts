import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ChildProgressList,
  type HistoryRecord,
  RuntimeEventsProvider,
} from '@deepagents/devtool-history';
import type { ChildProgress } from '@deepagents/experimental/zukhruf';
import type { OwnerEvent } from '@deepagents/experimental/zukhruf/http';

test('DevTool projects owner events into bounded child rows for the selected project and resyncs on ready', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  class OwnerEventSource extends EventTarget {
    static current: OwnerEventSource;
    closed = false;
    readonly url: string;
    constructor(url: string) {
      super();
      this.url = url;
      OwnerEventSource.current = this;
    }
    close() {
      this.closed = true;
    }
    emit(event: unknown) {
      this.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(event) }),
      );
    }
  }
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    EventSource: { value: OwnerEventSource, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  const child: ChildProgress = {
    chatId: 'child-one',
    treeId: 'project-one',
    parentChatId: 'project-one',
    path: '/root/research',
    declarationName: 'researcher',
    state: 'queued',
    activities: {
      spawn: {
        id: 'spawn-one',
        type: 'spawn',
        at: 1,
        actorPath: '/root',
        targetPath: '/root/research',
        streamId: 'turn-one',
      },
    },
  };
  const other: ChildProgress = {
    ...child,
    chatId: 'child-two',
    treeId: 'project-two',
    parentChatId: 'project-two',
    path: '/root/other',
    activities: {},
  };
  const history: HistoryRecord[] = [child, other].map((entry) => ({
    chatId: entry.treeId,
    userId: 'owner',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    status: { type: 'idle' },
    children: [entry],
  }));
  const render = async (treeId: string) =>
    act(() =>
      root.render(
        createElement(RuntimeEventsProvider, {
          href: '/runtime/events',
          history,
          onEvent: () => {},
          children: createElement(ChildProgressList, { treeId }),
        }),
      ),
    );
  const emit = async (progress: ChildProgress) =>
    act(() =>
      OwnerEventSource.current.emit({
        type: 'change',
        resource: 'conversation',
        id: progress.chatId,
        status: { type: 'idle' },
        child: progress,
      } satisfies OwnerEvent),
    );
  try {
    await render('project-one');
    assert.equal(OwnerEventSource.current.url, '/runtime/events');
    assert.match(container.textContent ?? '', /research/);
    assert.match(container.textContent ?? '', /Queued/);
    assert.doesNotMatch(container.textContent ?? '', /other/);
    await emit({ ...other, state: 'failed' });
    assert.doesNotMatch(container.textContent ?? '', /Failed|other/);
    for (const [index, kind] of (
      ['message', 'followup', 'interrupt', 'completion'] as const
    ).entries()) {
      await emit({
        ...child,
        state: kind === 'interrupt' ? 'interrupted' : 'completed',
        activities: {
          ...child.activities,
          [kind]: {
            id: kind,
            type: kind,
            at: index + 2,
            actorPath: '/root',
            targetPath: child.path,
            streamId: 'turn-two',
          },
        },
      });
      assert.equal(container.querySelectorAll('li').length, 1);
      assert.match(
        container.textContent ?? '',
        new RegExp(
          {
            message: 'Message sent',
            followup: 'Follow-up sent',
            interrupt: 'Interrupt accepted',
            completion: 'Turn finished',
          }[kind],
        ),
      );
    }
    await emit({ ...child, state: 'waitingOnApproval' });
    assert.match(container.textContent ?? '', /Waiting on approval/);
    await emit({ ...child, state: 'waitingOnUserInput' });
    assert.match(container.textContent ?? '', /Waiting on user input/);
    await act(() =>
      OwnerEventSource.current.emit({
        type: 'change',
        resource: 'conversation',
        id: child.chatId,
        status: { type: 'idle' },
        child: { ...child, state: 'invalid' },
      }),
    );
    assert.match(container.textContent ?? '', /Waiting on user input/);
    await act(() =>
      OwnerEventSource.current.emit({
        type: 'change',
        resource: 'conversation',
        id: child.chatId,
        status: { type: 'idle' },
        child: { ...child, activities: { unbounded: {} } },
      }),
    );
    assert.match(container.textContent ?? '', /Waiting on user input/);
    history[0] = {
      ...history[0],
      children: [{ ...child, state: 'completed', activities: {} }],
    };
    await act(() => OwnerEventSource.current.emit({ type: 'ready' }));
    await render('project-one');
    assert.match(container.textContent ?? '', /Completed/);
    assert.doesNotMatch(container.textContent ?? '', /Waiting on/);
    await render('project-two');
    assert.match(container.textContent ?? '', /other/);
    assert.doesNotMatch(container.textContent ?? '', /research/);
    await render('empty-project');
    assert.equal(container.textContent, '');
  } finally {
    await act(() => root.unmount());
    assert.equal(OwnerEventSource.current.closed, true);
    dom.window.close();
    for (const key of [
      'window',
      'document',
      'EventSource',
      'IS_REACT_ACT_ENVIRONMENT',
    ]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
