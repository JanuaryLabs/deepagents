/**
 * Fragment type identifier.
 * - 'fragment': Regular context fragment (default)
 * - 'message': Conversation message (user/assistant)
 */
export type FragmentType = 'fragment' | 'message';

/**
 * A context fragment containing a name and associated data.
 */
export interface ContextFragment {
  /**
   * Unique identifier for this fragment.
   * Auto-generated for user/assistant messages, optional for other fragments.
   */
  id?: string;
  name: string;
  data: FragmentData;
  /**
   * Fragment type for categorization.
   * Messages use 'message' type and are handled separately during resolve().
   */
  type?: FragmentType;
  /**
   * When true, this fragment will be persisted to the store on save().
   */
  persist?: boolean;
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

/**
 * Type guard to check if a fragment is a message fragment.
 */
export function isMessageFragment(fragment: ContextFragment): boolean {
  return fragment.type === 'message';
}
