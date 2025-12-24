/**
 * A context fragment containing a name and associated data.
 */
export interface ContextFragment {
  name: string;
  data: FragmentData;
}

/**
 * Fragment data can be a primitive, array, object, or nested fragment.
 */
export type FragmentData =
  | string
  | number
  | boolean
  | ContextFragment
  | FragmentData[]
  | { [key: string]: FragmentData };

/**
 * Type guard to check if data is a ContextFragment.
 */
export function isFragment(data: unknown): data is ContextFragment {
  return (
    typeof data === 'object' &&
    data !== null &&
    'name' in data &&
    'data' in data &&
    typeof (data as ContextFragment).name === 'string'
  );
}

/**
 * A plain object with string keys and FragmentData values.
 */
export type FragmentObject = Record<string, FragmentData>;

/**
 * Type guard to check if data is a plain object (not array, not fragment, not primitive).
 */
export function isFragmentObject(data: unknown): data is FragmentObject {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    !isFragment(data)
  );
}
