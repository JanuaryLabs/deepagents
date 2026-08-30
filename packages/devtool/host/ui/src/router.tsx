import { createBrowserRouter, redirect } from 'react-router';

import { AppLayout, loader as appLoader } from './app/layout.tsx';
import {
  ChatRoute,
  loader as chatLoader,
  shouldRevalidate as shouldRevalidateChat,
} from './routes/chat.tsx';
import { HistoryRoute, loader as historyLoader } from './routes/history.tsx';
import {
  ScheduledRoute,
  loader as scheduledLoader,
} from './routes/scheduled.tsx';
import { TracesRoute, loader as tracesLoader } from './routes/traces.tsx';

export const router = createBrowserRouter(
  [
    {
      id: 'app',
      Component: AppLayout,
      loader: appLoader,
      children: [
        { index: true, loader: () => redirect('/history') },
        {
          path: 'chat/:sessionId?',
          Component: ChatRoute,
          loader: chatLoader,
          shouldRevalidate: shouldRevalidateChat,
        },
        {
          path: 'history/:userId?/:chatId?',
          Component: HistoryRoute,
          loader: historyLoader,
        },
        {
          path: 'history/:userId/:chatId/traces/:traceId?',
          Component: TracesRoute,
          loader: tracesLoader,
        },
        { path: 'scheduled', loader: () => redirect('/scheduled/tasks') },
        {
          path: 'scheduled/tasks/:taskId?',
          Component: ScheduledRoute,
          loader: scheduledLoader,
        },
        {
          path: 'scheduled/tasks/:taskId/runs/:runId',
          Component: ScheduledRoute,
          loader: scheduledLoader,
        },
        {
          path: 'scheduled/review/:runId?',
          Component: ScheduledRoute,
          loader: scheduledLoader,
        },
      ],
    },
  ],
  { basename: new URL(document.baseURI).pathname.replace(/\/$/, '') },
);
