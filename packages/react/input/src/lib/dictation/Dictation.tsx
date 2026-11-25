import { type ReactNode, createContext, use } from 'react';

import {
  type DictationButtonProps,
  DictationCancelButton,
  DictationToggleButton,
} from './DictationButtons.tsx';
import {
  type DictationApi,
  type DictationOptions,
  type DictationState,
  useDictation,
} from './useDictation.ts';

export type DictationRootProps = DictationOptions & { children: ReactNode };

export type DictationToggleProps = DictationButtonProps<DictationState>;

export type DictationCancelProps = DictationToggleProps;

const DictationContext = createContext<{
  dictation: DictationApi;
  disabled: boolean;
} | null>(null);

function useDictationRoot(componentName: string) {
  const root = use(DictationContext);
  if (!root) {
    throw new Error(`${componentName} must be used inside Dictation.Root.`);
  }
  return root;
}

export function useDictationContext(componentName: string): DictationApi {
  return useDictationRoot(componentName).dictation;
}

function DictationRoot({ children, ...options }: DictationRootProps) {
  const dictation = useDictation(options);
  return (
    <DictationContext
      value={{ dictation, disabled: options.disabled === true }}
    >
      {children}
    </DictationContext>
  );
}

function DictationToggle({ disabled, ...props }: DictationToggleProps) {
  const root = useDictationRoot('Dictation.Toggle');
  return (
    <DictationToggleButton
      {...props}
      dictation={root.dictation}
      refusesStart={disabled === true || root.disabled}
    />
  );
}

function DictationCancel(props: DictationCancelProps) {
  const { dictation } = useDictationRoot('Dictation.Cancel');
  return <DictationCancelButton {...props} dictation={dictation} />;
}

export const Dictation = {
  Root: DictationRoot,
  Toggle: DictationToggle,
  Cancel: DictationCancel,
} as const;
