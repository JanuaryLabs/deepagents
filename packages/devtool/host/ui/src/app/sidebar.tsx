import { CalendarClockIcon, HistoryIcon, SquarePenIcon } from 'lucide-react';
import { useCallback } from 'react';
import {
  NavLink,
  generatePath,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router';

import {
  History,
  type HistoryRecord,
  HistoryStatusIcon,
} from '@deepagents/devtool-history';
import {
  Button,
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
} from '@deepagents/react-shadcn';

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
      </SidebarHeader>
      <SidebarContent>
        <PrimaryNavigation />
        <RunsNavigation />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

export function NewChatButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const navigate = useNavigate();
  const startNewChat = () =>
    navigate(`/chat?draft=${encodeURIComponent(crypto.randomUUID())}`);

  if (iconOnly) {
    return (
      <Button
        aria-label="New chat"
        className="size-7"
        size="icon"
        title="New chat"
        type="button"
        variant="ghost"
        onClick={startNewChat}
      >
        <SquarePenIcon className="size-4" />
      </Button>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={startNewChat} tooltip="New chat">
        <SquarePenIcon />
        <span>New Chat</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function PrimaryNavigation() {
  return (
    <nav aria-label="Devtool views">
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <NewChatButton />
            <SidebarMenuItem>
              <SidebarMenuButton render={<NavLink to="/history" />}>
                <HistoryIcon />
                <span>History</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton render={<NavLink to="/scheduled" />}>
                <CalendarClockIcon />
                <span>Scheduled</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </nav>
  );
}

function RunsNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = useParams();
  const { discovery, history, historyError } = useRuntimeData();
  const selected = location.pathname.startsWith('/chat')
    ? history.find(({ chatId }) => chatId === route.sessionId)
    : selectConversation(history, route);
  const select = useCallback(
    (entry: HistoryRecord) =>
      navigate(generatePath('/chat/:sessionId', { sessionId: entry.chatId })),
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
                  className={cn(
                    'hover:bg-accent rounded-lg transition-colors',
                    active && 'bg-accent',
                  )}
                >
                  <History.ItemTrigger
                    history={entry}
                    className="pb-0 hover:bg-transparent"
                  >
                    <HistoryStatusIcon status={entry.status} />
                    <span className="text-foreground truncate">
                      {entry.title ?? entry.chatId}
                    </span>
                  </History.ItemTrigger>
                  {discovery?.traces ? (
                    <NavLink
                      to={generatePath('/history/:userId/:chatId/traces', {
                        chatId: entry.chatId,
                        userId: entry.userId,
                      })}
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
