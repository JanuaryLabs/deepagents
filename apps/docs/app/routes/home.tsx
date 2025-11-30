import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { BookIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { baseOptions } from '../layout.shared.tsx';
import { Outlet } from 'react-router';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout
      {...baseOptions()}
      links={[
        {
          icon: <BookIcon />,
          text: 'Docs',
          url: '/docs',
        },
      ]}
    >
      <Outlet/>
    </HomeLayout>
  );
}
