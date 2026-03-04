import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, redirect, RouterProvider } from 'react-router';

import { queryClient } from './app/hooks/use-client.ts';
import { Toaster } from './app/shadcn/index.ts';

import ComparePage from './app/routes/compare/ComparePage.tsx';
import DatasetDetail from './app/routes/datasets/DatasetDetail.tsx';
import DatasetList from './app/routes/datasets/DatasetList.tsx';
import NewEvalPage from './app/routes/evals/NewEvalPage.tsx';
import Layout from './app/routes/Layout.tsx';
import PromptsPage from './app/routes/prompts/PromptsPage.tsx';
import RunDetail from './app/routes/runs/RunDetail.tsx';
import RunList from './app/routes/runs/RunList.tsx';
import SuiteDetail from './app/routes/suites/SuiteDetail.tsx';
import SuiteList from './app/routes/suites/SuiteList.tsx';

const router = createBrowserRouter(
  [
    {
      Component: Layout,
      children: [
        { index: true, loader: () => redirect('/suites') },
        { path: 'suites', Component: SuiteList },
        { path: 'suites/:id', Component: SuiteDetail },
        { path: 'runs', Component: RunList },
        { path: 'runs/:id', Component: RunDetail },
        { path: 'compare', Component: ComparePage },
        { path: 'datasets', Component: DatasetList },
        { path: 'datasets/:name', Component: DatasetDetail },
        { path: 'prompts', Component: PromptsPage },
        { path: 'evals/new', Component: NewEvalPage },
      ],
    },
  ],
  {
    basename:
      document
        .querySelector('base')
        ?.getAttribute('href')
        ?.replace(/\/$/, '') || '/',
  },
);

const root = createRoot(document.getElementById('root') as HTMLElement);

root.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Toaster />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
