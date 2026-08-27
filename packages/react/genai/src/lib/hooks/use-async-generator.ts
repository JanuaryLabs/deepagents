import { useState } from 'react';

export type OnClickYieldResult = {
  loading: boolean;
  error?: unknown;
};

export function useAsyncGenerator() {
  const [state, setState] = useState<OnClickYieldResult>({
    loading: false,
    error: null,
  });

  const execute = async (generator: AsyncGenerator<OnClickYieldResult>) => {
    try {
      setState({ loading: true, error: null });
      for await (const value of generator) {
        setState(value);
      }
    } catch (error) {
      setState({ loading: false, error });
    } finally {
      setState((prev) => ({ ...prev, loading: false }));
    }
  };

  return { ...state, execute };
}
