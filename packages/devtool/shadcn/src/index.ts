import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export { StatusBadge } from './status-badge.tsx';
export {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from './sidebar.tsx';
export { SIDEBAR_COOKIE_NAME } from './sidebar.tsx';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatTimestamp(value: number | string) {
  return dateTime.format(new Date(value));
}
