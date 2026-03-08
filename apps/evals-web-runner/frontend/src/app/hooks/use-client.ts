// eslint-disable-next-line @nx/enforce-module-boundaries
import { type Endpoints as ApiEndpoints, Client } from '@evals/client';
import {
  type MutationFunctionContext,
  QueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
  useMutation,
  useMutationState,
  useQuery,
} from '@tanstack/react-query';

export type Endpoints = ApiEndpoints;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

export const client = new Client({
  baseUrl: `${import.meta.env.VITE_API_URL}/api`,
});

type DataEndpoints = {
  [K in keyof Endpoints]: K extends `${'GET'} ${string}` ? K : never;
}[keyof Endpoints];

type MutationEndpoints = {
  [K in keyof Endpoints]: K extends `${'POST' | 'PUT' | 'PATCH' | 'DELETE'} ${string}`
    ? K
    : never;
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
  input?: Endpoints[E]['input'],
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
    queryFn: () => client.request(endpoint, input ?? ({} as never)),
  });
}

type WithMutationFn<E extends keyof Endpoints> = Omit<
  UseMutationOptions<Endpoints[E]['output'], Endpoints[E]['error'], unknown>,
  'mutationFn' | 'mutationKey'
> & {
  invalidate?: DataEndpoints[];
  mutationFn: (
    dispatch: (input: Endpoints[E]['input']) => Promise<Endpoints[E]['output']>,
    context: MutationFunctionContext,
  ) => Promise<Endpoints[E]['output'] | undefined>;
};
type WithoutMutationFn<E extends keyof Endpoints> = Omit<
  UseMutationOptions<
    Endpoints[E]['output'],
    Endpoints[E]['error'],
    Endpoints[E]['input']
  >,
  'mutationFn' | 'mutationKey'
> & {
  invalidate?: DataEndpoints[];
};

type ActionOptions<E extends MutationEndpoints> =
  | WithMutationFn<E>
  | WithoutMutationFn<E>
  | undefined;

type ActionVariables<
  E extends MutationEndpoints,
  TOptions extends ActionOptions<E>,
> = TOptions extends WithMutationFn<E> ? void : Endpoints[E]['input'];

/**
 * A hook to perform an action on the API with a custom mutation function.
 * The `mutate` function from the result will not take any arguments.
 * The `mutationFn` receives a `dispatch` function that you can call to trigger the API request.
 *
 * @param endpoint - The API endpoint to perform the action on (e.g. 'POST /payments').
 * @param options - Options for the mutation, including a custom `mutationFn`.
 * @returns The mutation result.
 *
 * @example
 * // Create a new payment with a custom function
 * const { mutate, isPending } = useAction('POST /payments', {
 *   mutationFn: (dispatch) => dispatch({ amount: 1000, date: '2023-01-01' }),
 *   onSuccess: () => console.log('Payment created!'),
 * });
 *
 * @example
 * // Perform logic before and after the mutation
 * const { mutate, isPending } = useAction('POST /payments', {
 *  mutationFn: async (dispatch) => {
 *   // Perform some logic before the mutation
 *   await dispatch({ amount: 1000, date: '2023-01-01' });
 *   // Perform some logic after the mutation
 *   console.log('Payment created!');
 *  },
 * });
 *
 * // later in the code
 * mutate();
 */
/**
 * A hook to perform an action on the API.
 * The `mutate` function expects endpoint input unless a custom `mutationFn`
 * is supplied, in which case it takes no arguments.
 */
export function useAction<
  E extends MutationEndpoints,
  TOptions extends ActionOptions<E> = undefined,
>(
  endpoint: E,
  options?: TOptions,
): UseMutationResult<
  Endpoints[E]['output'],
  Endpoints[E]['error'],
  ActionVariables<E, TOptions>
> {
  return useMutation<
    Endpoints[E]['output'],
    Endpoints[E]['error'],
    Endpoints[E]['input'],
    unknown
  >({
    ...options,
    meta: { endpoint },
    mutationKey: [endpoint],
    mutationFn: async (input, context) => {
      if (options && 'mutationFn' in options && options.mutationFn) {
        return options.mutationFn(
          (input) => client.request(endpoint, input),
          context,
        ) as Promise<Endpoints[E]['output']>;
      }
      return (await client.request(endpoint, input)) as Endpoints[E]['output'];
    },
    onSuccess: async (data, variables, onMutateResult, context) => {
      for (const endpoint of options?.invalidate ?? []) {
        await invalidateData(endpoint);
      }
      return options?.onSuccess?.(data, variables, onMutateResult, context);
    },
  }) as UseMutationResult<
    Endpoints[E]['output'],
    Endpoints[E]['error'],
    ActionVariables<E, TOptions>
  >;
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
  input?: Endpoints[E]['input'],
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
    queryFn: () => client.request(endpoint, input ?? ({} as never)),
  });
}

export function invalidateData(endpoint: DataEndpoints): Promise<void> {
  return queryClient.invalidateQueries({
    predicate(query) {
      return query.meta?.endpoint === endpoint;
    },
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
