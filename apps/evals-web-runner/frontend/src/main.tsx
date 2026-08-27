import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter, redirect } from 'react-router';
import { Toaster } from 'sonner';

import { queryClient } from './app/hooks/query-client.ts';
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
            Component: (await import('./app/routes/runs/RunDetail.tsx'))
              .default,
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
      <Toaster
        theme="system"
        className="toaster group"
        toastOptions={{
          classNames: {
            toast:
              'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
            description: 'group-[.toast]:text-muted-foreground',
            actionButton:
              'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
            cancelButton:
              'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          },
        }}
      />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
