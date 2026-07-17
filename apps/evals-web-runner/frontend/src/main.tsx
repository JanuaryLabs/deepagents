import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, redirect, RouterProvider } from 'react-router';

import { queryClient } from './app/hooks/query-client.ts';
import { Toaster } from './app/shadcn/index.ts';

import Layout from './app/routes/Layout.tsx';

const router = createBrowserRouter(
  [
    {
      Component: Layout,
      children: [
        { index: true, loader: () => redirect('/suites') },
        {
          path: 'suites',
          lazy: async () => ({
            Component: (await import('./app/routes/suites/SuiteList.tsx'))
              .default,
          }),
        },
        {
          path: 'suites/:id',
          lazy: async () => ({
            Component: (await import('./app/routes/suites/SuiteDetail.tsx'))
              .default,
          }),
        },
        {
          path: 'runs',
          lazy: async () => ({
            Component: (await import('./app/routes/runs/RunList.tsx')).default,
          }),
        },
        {
          path: 'runs/:id',
          lazy: async () => ({
            Component: (await import('./app/routes/runs/RunDetail.tsx')).default,
          }),
        },
        {
          path: 'compare',
          lazy: async () => ({
            Component: (await import('./app/routes/compare/ComparePage.tsx'))
              .default,
          }),
        },
        {
          path: 'datasets',
          lazy: async () => ({
            Component: (await import('./app/routes/datasets/DatasetList.tsx'))
              .default,
          }),
        },
        {
          path: 'datasets/:name',
          lazy: async () => ({
            Component: (await import('./app/routes/datasets/DatasetDetail.tsx'))
              .default,
          }),
        },
        {
          path: 'prompts',
          lazy: async () => ({
            Component: (await import('./app/routes/prompts/PromptsPage.tsx'))
              .default,
          }),
        },
        {
          path: 'evals/new',
          lazy: async () => ({
            Component: (await import('./app/routes/evals/NewEvalPage.tsx'))
              .default,
          }),
        },
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
