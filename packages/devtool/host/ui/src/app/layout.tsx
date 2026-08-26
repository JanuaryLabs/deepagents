import { useState } from 'react';
import { Outlet } from 'react-router';

import {
  SIDEBAR_COOKIE_NAME,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@deepagents/devtool-shadcn';

import { DevtoolSidebar } from './sidebar.tsx';

function getSidebarStateFromCookie() {
  const cookie = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${SIDEBAR_COOKIE_NAME}=`));
  return cookie ? cookie.split('=')[1] === 'true' : true;
}

export function AppLayout() {
  const [sidebarOpen] = useState(getSidebarStateFromCookie);
  return (
    <SidebarProvider defaultOpen={sidebarOpen} className="h-screen min-h-0">
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
    <div className="flex h-9 shrink-0 items-center px-2">
      {isMobile || state === 'collapsed' ? (
        <SidebarTrigger aria-label="Open sidebar" title="Open sidebar" />
      ) : null}
    </div>
  );
}
