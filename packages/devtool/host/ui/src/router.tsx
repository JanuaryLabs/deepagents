import { createBrowserRouter, redirect } from 'react-router';

import { AppLayout } from './app/layout.tsx';
import { HistoryRoute } from './routes/history.tsx';
import { ScheduledRoute } from './routes/scheduled.tsx';
import { TracesRoute } from './routes/traces.tsx';

export const router = createBrowserRouter([
  {
    Component: AppLayout,
    children: [
      { index: true, loader: () => redirect('/history') },
      {
        path: 'history/:userId?/:chatId?',
        Component: HistoryRoute,
      },
      {
        path: 'history/:userId/:chatId/traces/:traceId?',
        Component: TracesRoute,
      },
      {
        path: 'scheduled',
        Component: ScheduledRoute,
      },
    ],
  },
]);
