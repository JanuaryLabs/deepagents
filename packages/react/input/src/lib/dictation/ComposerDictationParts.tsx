import { Button } from '@base-ui/react/button';
import type { ReactElement } from 'react';

import { useComposerContext } from '../ComposerContext.ts';
import {
  type DictationState,
  useComposerDictation,
} from './ComposerDictationContext.ts';

type ButtonRender = NonNullable<Button.Props['render']>;
type ButtonRenderProps = Parameters<
  Extract<ButtonRender, (...args: never[]) => unknown>
>[0];

type DictationRender =
  | ReactElement
  | ((props: ButtonRenderProps, state: DictationState) => ReactElement);

export type ComposerDictateProps = Omit<Button.Props, 'render' | 'onClick'> & {
  render?: DictationRender;
};

export type ComposerCancelDictationProps = ComposerDictateProps;

function withState(
  render: DictationRender | undefined,
  state: DictationState,
): Button.Props['render'] {
  return typeof render === 'function'
    ? (props: ButtonRenderProps) => render(props, state)
    : render;
}

export function ComposerDictate({
  render,
  disabled,
  ...props
}: ComposerDictateProps) {
  const { disabled: rootDisabled } = useComposerContext('Composer.Dictate');
  const { state, start, stop } = useComposerDictation('Composer.Dictate');
  const recording = state.status === 'recording';
  const canStart =
    (state.status === 'idle' || state.status === 'failed') &&
    disabled !== true &&
    !rootDisabled;
  return (
    <Button
      {...props}
      data-status={state.status}
      data-end={state.status === 'finishing' ? state.end : undefined}
      aria-pressed={recording}
      disabled={!recording && !canStart}
      onClick={recording ? stop : start}
      render={withState(render, state)}
    />
  );
}

export function ComposerCancelDictation({
  render,
  disabled,
  ...props
}: ComposerCancelDictationProps) {
  const { state, cancel } = useComposerDictation('Composer.CancelDictation');
  const active =
    state.status === 'starting' ||
    state.status === 'recording' ||
    state.status === 'finishing';
  return (
    <Button
      {...props}
      data-status={state.status}
      disabled={!active || disabled === true}
      onClick={cancel}
      render={withState(render, state)}
    />
  );
}
