import { type CSSProperties, useEffect, useState } from 'react';
import { type LoaderFunctionArgs, Outlet, useRevalidator } from 'react-router';

import {
  SIDEBAR_COOKIE_NAME,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@deepagents/react-shadcn';

import { DevtoolSidebar, NewChatButton } from './sidebar.tsx';
import { loadRuntime } from './runtime-data.ts';

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
  const { revalidate } = useRevalidator();
  useEffect(() => {
    const interval = setInterval(() => void revalidate(), 3_000);
    return () => clearInterval(interval);
  }, [revalidate]);

  return (
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
