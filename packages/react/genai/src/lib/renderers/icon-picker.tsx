import * as LucideIcons from 'lucide-react';
import React, { useMemo, useState } from 'react';

type Icons = {
  name: string;
  friendly_name: string;
  Component: React.FC<React.ComponentPropsWithoutRef<'svg'>>;
};

export const useIconPicker = (): {
  search: string;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  icons: Icons[];
} => {
  const icons: Icons[] = useMemo(
    () =>
      Object.entries(LucideIcons)
        .filter(([, IconComponent]) => typeof IconComponent === 'function')
        .map(([iconName, IconComponent]) => ({
          name: iconName,
          friendly_name: iconName.match(/[A-Z][a-z]+/g)?.join(' ') ?? iconName,

          Component: IconComponent as React.FC<
            React.ComponentPropsWithoutRef<'svg'>
          >,
        })),
    [],
  );

  // these lines can be removed entirely if you're not using the controlled component approach
  const [search, setSearch] = useState('');
  //   memoize the search functionality
  const filteredIcons = useMemo(() => {
    return icons.filter((icon) => {
      if (search === '') {
        return true;
      } else if (icon.name.toLowerCase().includes(search.toLowerCase())) {
        return true;
      } else {
        return false;
      }
    });
  }, [icons, search]);

  return { search, setSearch, icons: filteredIcons };
};

export const IconRenderer = ({
  icon,
  ...rest
}: {
  icon: string;
} & React.ComponentPropsWithoutRef<'svg'>) => {
  const IconComponent = LucideIcons[
    icon as keyof typeof LucideIcons
  ] as React.FC<React.ComponentPropsWithoutRef<'svg'>>;

  if (!IconComponent || typeof IconComponent !== 'function') {
    return null;
  }

  return <IconComponent data-slot="icon" {...rest} />;
};
