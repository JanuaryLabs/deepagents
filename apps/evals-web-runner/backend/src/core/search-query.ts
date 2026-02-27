import { set } from 'lodash-es';

export function createSearch(query: string, columns: readonly string[]) {
  return {
    OR: columns.map((field) =>
      set({}, field.split('.'), {
        contains: query,
        mode: 'insensitive',
      }),
    ),
  } as const;
}
export function createTokenizedSearch(
  query: string,
  columns: readonly string[],
) {
  return {
    OR: columns.map((field) => {
      const tokens = query.trim().split(/\s+/).filter(Boolean);
      return tokens.length > 0
        ? {
            OR: tokens.map((token) =>
              set({}, field.split('.'), {
                contains: token,
                mode: 'insensitive',
              }),
            ),
          }
        : {};
    }),
  } as const;
}

export function createOrderBy(sortBy: string, sortOrder: 'asc' | 'desc') {
  return set({}, sortBy.split('.'), sortOrder) as Record<
    string,
    'asc' | 'desc'
  >;
}
