import { QueryClientProvider } from '@tanstack/react-query';
import { ClockProvider } from '@zukhruf/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { queryClient } from './app/runtime-data.ts';
import { router } from './router.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('The DevTool page has no #root element.');

createRoot(root).render(
  <StrictMode>
    <ClockProvider clock={globalThis}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ClockProvider>
  </StrictMode>,
);
