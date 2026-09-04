import { type CSSProperties, useCallback, useState } from 'react';
import {
  type LoaderFunctionArgs,
  Outlet,
  useLoaderData,
  useRevalidator,
} from 'react-router';

import {
  type RuntimeEvent,
  RuntimeEventsProvider,
  isConversationEvent,
} from '@deepagents/devtool-history';
import {
  SIDEBAR_COOKIE_NAME,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@deepagents/react-shadcn';

import { loadRuntime, queryClient } from './runtime-data.ts';
import { DevtoolSidebar, NewChatButton } from './sidebar.tsx';

export function loader({ request }: LoaderFunctionArgs) {
  return loadRuntime(request.signal);
}

function getSidebarStateFromCookie() {
  const cookie = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${SIDEBAR_COOKIE_NAME}=`));
  return cookie ? cookie.split('=')[1] === 'true' : true;
}

export function AppLayout() {
  const [sidebarOpen] = useState(getSidebarStateFromCookie);
  const { discovery, history } = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();
  const refreshRuntime = useCallback(
    (event: RuntimeEvent) => {
      if (event.type === 'ready') {
        void revalidate();
        void queryClient.invalidateQueries({ queryKey: ['schedules'] });
        return;
      }
      if (
        event.resource === 'schedule-task' ||
        event.resource === 'schedule-run'
      ) {
        void queryClient.invalidateQueries({
          predicate: ({ queryKey }) =>
            queryKey[0] === 'schedules' &&
            (event.resource === 'schedule-task'
              ? queryKey[1] === 'tasks'
              : queryKey[1] !== 'tasks'),
        });
        return;
      }
      if (!isConversationEvent(event)) return;
      if (
        event.status.type !== 'active' ||
        !history.some(({ chatId }) => chatId === event.id)
      ) {
        void revalidate();
      }
    },
    [history, revalidate],
  );

  return (
    <RuntimeEventsProvider
      href={discovery?.capabilities.events.href}
      onEvent={refreshRuntime}
    >
      <SidebarProvider
        defaultOpen={sidebarOpen}
        className="h-screen min-h-0"
        style={{ '--sidebar-width': '18rem' } as CSSProperties}
      >
        <DevtoolSidebar />
        <SidebarInset className="min-h-0">
          <InsetTitlebar />
          <div className="min-h-0 flex-1 overflow-auto">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </RuntimeEventsProvider>
  );
}

function InsetTitlebar() {
  const { isMobile, state } = useSidebar();
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-2">
      {isMobile || state === 'collapsed' ? (
        <SidebarTrigger aria-label="Open sidebar" title="Open sidebar" />
      ) : null}
      {state === 'collapsed' ? <NewChatButton iconOnly /> : null}
    </div>
  );
}
