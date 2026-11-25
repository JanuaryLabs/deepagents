import { useComposerContext } from '../ComposerContext.ts';
import {
  type ComposerDictationState,
  useComposerDictation,
} from './ComposerDictationContext.ts';
import {
  type DictationButtonProps,
  DictationCancelButton,
  DictationToggleButton,
} from './DictationButtons.tsx';

export type ComposerDictateProps = DictationButtonProps<ComposerDictationState>;

export type ComposerCancelDictationProps = ComposerDictateProps;

export function ComposerDictate({ disabled, ...props }: ComposerDictateProps) {
  const { disabled: rootDisabled } = useComposerContext('Composer.Dictate');
  const dictation = useComposerDictation('Composer.Dictate');
  const { state } = dictation;
  return (
    <DictationToggleButton
      {...props}
      data-end={state.status === 'finishing' ? state.end : undefined}
      dictation={dictation}
      refusesStart={disabled === true || rootDisabled}
    />
  );
}

export function ComposerCancelDictation(props: ComposerCancelDictationProps) {
  const dictation = useComposerDictation('Composer.CancelDictation');
  return <DictationCancelButton {...props} dictation={dictation} />;
}
