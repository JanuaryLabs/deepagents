import { CalendarClockIcon, HistoryIcon } from 'lucide-react';
import { useCallback } from 'react';
import {
  NavLink,
  generatePath,
  useNavigate,
  useParams,
} from 'react-router';

import {
  History,
  type HistoryRecord,
  HistoryStatusIcon,
} from '@deepagents/devtool-history';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  cn,
} from '@deepagents/devtool-shadcn';

import { selectConversation, useRuntimeData } from './runtime-data.ts';

export function DevtoolSidebar() {
  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarHeader>
        <div className="flex h-8 items-center justify-between gap-2 px-2">
          <span className="text-sm font-semibold">Zukhruf Devtool</span>
          <SidebarTrigger
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          />
        </div>
        <PrimaryNavigation />
      </SidebarHeader>
      <SidebarContent>
        <RunsNavigation />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

function PrimaryNavigation() {
  return (
    <nav aria-label="Devtool views">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild>
            <NavLink to="/history">
              <HistoryIcon />
              <span>History</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton asChild>
            <NavLink to="/scheduled">
              <CalendarClockIcon />
              <span>Scheduled</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </nav>
  );
}

function RunsNavigation() {
  const navigate = useNavigate();
  const route = useParams();
  const { discovery, history, historyError } = useRuntimeData();
  const selected = selectConversation(history, route);
  const select = useCallback(
    (entry: HistoryRecord) =>
      navigate(
        generatePath('/history/:userId/:chatId', {
          chatId: entry.chatId,
          userId: entry.userId,
        }),
      ),
    [navigate],
  );

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        <span>Runs</span>
        <span className="ml-auto font-mono">{history.length}</span>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <History.Root activeChatId={selected?.chatId} onSelect={select}>
          {historyError && history.length === 0 ? (
            <History.Empty>Runs unavailable</History.Empty>
          ) : history.length === 0 ? (
            <History.Empty>No conversations yet</History.Empty>
          ) : (
            history.map((entry) => {
              const active = selected?.chatId === entry.chatId;
              return (
                <History.Item
                  key={`${entry.userId}:${entry.chatId}`}
                  className={cn(active && 'bg-accent rounded-lg')}
                >
                  <History.ItemTrigger history={entry} className="pb-0">
                    <HistoryStatusIcon status={entry.status} />
                    <span className="text-foreground truncate">
                      {entry.title ?? entry.chatId}
                    </span>
                  </History.ItemTrigger>
                  {discovery?.traces ? (
                    <NavLink
                      to={generatePath(
                        '/history/:userId/:chatId/traces',
                        {
                          chatId: entry.chatId,
                          userId: entry.userId,
                        },
                      )}
                      className={({ isActive }) =>
                        cn(
                          'text-muted-foreground hover:text-foreground ml-8 block px-2 pb-1.5 text-[0.6875rem]',
                          isActive && 'text-foreground',
                        )
                      }
                    >
                      Traces
                    </NavLink>
                  ) : null}
                </History.Item>
              );
            })
          )}
        </History.Root>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
