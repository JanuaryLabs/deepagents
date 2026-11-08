import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { BookIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';

import { baseOptions } from '../layout.shared.tsx';

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
      <Outlet />
    </HomeLayout>
  );
}
