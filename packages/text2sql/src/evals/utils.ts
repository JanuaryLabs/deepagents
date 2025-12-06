/**
 * Eval utilities for filtering and debugging
 */

interface DataItem<TInput, TExpected = unknown> {
  input: TInput;
  expected?: TExpected;
}

/**
 * Filter data based on EVAL_INDEX environment variable.
 * When EVAL_INDEX is set, only return the item at that index.
 *
 * Usage in eval files:
 * ```ts
 * import { filterByIndex } from '../utils';
 *
 * evalite('My Eval', {
 *   data: () => filterByIndex(myData.map(item => ({ input: item.input, expected: item.expected }))),
 *   // ...
 * });
 * ```
 */
export function filterByIndex<TInput, TExpected>(
  data: DataItem<TInput, TExpected>[],
): DataItem<TInput, TExpected>[] {
  const indexStr = process.env['EVAL_INDEX'];

  if (!indexStr) {
    return data;
  }

  const index = parseInt(indexStr, 10);

  if (isNaN(index) || index < 0 || index >= data.length) {
    console.warn(
      `\x1b[33m⚠ EVAL_INDEX=${indexStr} is out of range (0-${data.length - 1}), running all tests\x1b[0m`,
    );
    return data;
  }

  console.log(
    `\x1b[36m🎯 Running single test at index ${index}\x1b[0m`,
  );

  return [data[index]];
}

/**
 * Get the current eval index from environment, or null if not set
 */
export function getEvalIndex(): number | null {
  const indexStr = process.env['EVAL_INDEX'];
  if (!indexStr) return null;

  const index = parseInt(indexStr, 10);
  return isNaN(index) ? null : index;
}
