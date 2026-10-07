import { Client, type Endpoints } from '@evals/client';
import {
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
  useMutation,
  useMutationState,
  useQuery,
} from '@tanstack/react-query';

import { queryClient } from './query-client.ts';

export type { Endpoints };

// Get the API base URL from <base href> tag or VITE_API_URL
// This enables deployment at any subpath (e.g., /platform)
function getBaseUrl(): string {
  if (import.meta.env.VITE_API_URL && import.meta.env.VITE_API_URL !== '/') {
    return `${import.meta.env.VITE_API_URL}/api`;
  }
  // Read from <base href> to support subdirectory deployments
  const baseHref = document.querySelector('base')?.getAttribute('href') ?? '/';
  // Remove trailing slash and append /api
  const basePath = baseHref.replace(/\/$/, '');
  return `${window.location.origin}${basePath}/api`;
}
export const client = new Client({
  baseUrl: getBaseUrl(),
  fetch: (request) => {
    const teamId = localStorage.getItem('activeTeamId');
    const headers = new Headers(request.headers);
    if (teamId) {
      headers.set('X-Team-Id', teamId);
    }
    return fetch(new Request(request, { headers }), {
      credentials: 'include',
    });
  },
});

type DataEndpoints = {
  [K in keyof Endpoints]: K extends `${'GET'} ${string}` ? K : never;
}[keyof Endpoints];

type MutationEndpoints = {
  [
    K in keyof Endpoints
  ]: K extends `${'POST' | 'PUT' | 'PATCH' | 'DELETE'} ${string}` ? K : never;
}[keyof Endpoints];

/**
 * A hook to fetch data from the API
 * @param endpoint - The API endpoint to fetch from (e.g. 'GET /payments')
 * @param params - Query parameters for the request
 * @param options - Additional options for the query
 * @returns The query result containing data and status
 *
 * @example
 * // Fetch all payments
 * const { data: payments } = useData('GET /payments', {
 *   since: '2023-01-01',
 *   until: '2023-12-31'
 * });
 */
export function useData<E extends DataEndpoints>(
  endpoint: E,
  input: Endpoints[E]['input'],
  options?: Omit<
    UseQueryOptions<
      Endpoints[E]['output'],
      Endpoints[E]['error'],
      Endpoints[E]['output']
    >,
    'queryFn' | 'meta' | 'queryKey'
  >,
): UseQueryResult<Endpoints[E]['output'], Endpoints[E]['error']> {
  return useQuery({
    queryKey: [endpoint, JSON.stringify(input)],
    ...options,
    meta: { endpoint, input },
    queryFn: () => client.request(endpoint, input),
  });
}

export function usePolling<E extends DataEndpoints>(
  endpoint: E,
  input: Endpoints[E]['input'],
  options: {
    interval: number;
    enabled?: boolean;
    shouldStop: (data: Endpoints[E]['output'] | undefined) => boolean;
  },
): UseQueryResult<Endpoints[E]['output'], Endpoints[E]['error']> {
  const enabled = options.enabled ?? true;

  return useData(endpoint, input, {
    enabled,
    retry: false,
    refetchInterval: (query) => {
      if (options.shouldStop(query.state.data)) return false;
      return options.interval;
    },
  });
}

type ActionOptions<E extends keyof Endpoints> = Omit<
  UseMutationOptions<
    Endpoints[E]['output'],
    Endpoints[E]['error'],
    Endpoints[E]['input']
  >,
  'mutationFn' | 'mutationKey'
> & {
  invalidate?: DataEndpoints[];
};

export type UseAction<E extends MutationEndpoints> = UseMutationResult<
  Endpoints[E]['output'],
  Endpoints[E]['error'],
  Endpoints[E]['input']
>;

/**
 * A hook to perform an action on the API.
 * The `mutate` function from the result expects the input for the endpoint.
 *
 * @param endpoint - The API endpoint to perform the action on (e.g. 'POST /payments').
 * @param options - Options for the mutation.
 * @returns The mutation result.
 *
 * @example
 * // Create a new payment
 * const { mutate, isPending } = useAction('POST /payments', {
 *   onSuccess: () => console.log('Payment created!'),
 * });
 *
 * // later in the code
 * mutate({ amount: 1000, date: '2023-01-01' });
 */
export function useAction<E extends MutationEndpoints>(
  endpoint: E,
  options?: ActionOptions<E>,
): UseAction<E> {
  return useMutation<
    Endpoints[E]['output'],
    Endpoints[E]['error'],
    Endpoints[E]['input'],
    unknown
  >({
    ...options,
    mutationKey: [endpoint],
    mutationFn: (input) => client.request(endpoint, input),
    onSuccess: async (data, variables, onMutateResult, context) => {
      for (const endpoint of options?.invalidate ?? []) {
        await invalidateData(endpoint);
      }
      return options?.onSuccess?.(data, variables, data, context);
    },
  });
}

export function useActionState<E extends MutationEndpoints>(endpoint: E) {
  return useMutationState({
    filters: {
      predicate(mutation) {
        return mutation.meta?.endpoint === endpoint;
      },
    },
  });
}

export function fetchData<E extends DataEndpoints>(
  endpoint: E,
  input: Endpoints[E]['input'],
  options?: Omit<
    UseQueryOptions<
      Endpoints[E]['output'],
      Endpoints[E]['error'],
      Endpoints[E]['output']
    >,
    'queryFn' | 'meta' | 'queryKey'
  >,
): Promise<Endpoints[E]['output']> {
  return queryClient.fetchQuery({
    queryKey: [endpoint, JSON.stringify(input)],
    ...options,
    meta: { endpoint, input },
    queryFn: () => client.request(endpoint, input),
  });
}

export function invalidateData(endpoint: DataEndpoints): Promise<void> {
  return queryClient.invalidateQueries({
    predicate(query) {
      return query.meta?.endpoint === endpoint;
    },
  });
}
