import {
  Database,
  FileText,
  FlaskConical,
  GitCompare,
  Play,
  Plus,
} from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '../shadcn/index.ts';

interface NavItem {
  href: string;
  label: string;
  icon: typeof FlaskConical;
}

const navItems: NavItem[] = [
  { href: '/suites', label: 'Suites', icon: FlaskConical },
  { href: '/runs', label: 'Runs', icon: Play },
  { href: '/compare', label: 'Compare', icon: GitCompare },
  { href: '/datasets', label: 'Datasets', icon: Database },
  { href: '/prompts', label: 'Prompts', icon: FileText },
  { href: '/evals/new', label: 'New Eval', icon: Plus },
];

export default function Layout() {
  const location = useLocation();

  return (
    <SidebarProvider defaultOpen>
      <Sidebar variant="inset">
        <SidebarHeader>
          <Link to="/suites" className="px-2 text-lg font-bold">
            Evals Dashboard
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    size="sm"
                    tooltip={item.label}
                    isActive={location.pathname.startsWith(item.href)}
                  >
                    <Link to={item.href}>
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="overflow-auto">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
