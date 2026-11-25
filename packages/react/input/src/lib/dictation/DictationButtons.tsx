import { Button } from '@base-ui/react/button';
import type { ReactElement } from 'react';

import type { DictationState } from './useDictation.ts';

type ButtonRender = NonNullable<Button.Props['render']>;
type ButtonRenderProps = Parameters<
  Extract<ButtonRender, (...args: never[]) => unknown>
>[0];

export type DictationRender<State> =
  ReactElement | ((props: ButtonRenderProps, state: State) => ReactElement);

export type DictationButtonProps<State> = Omit<
  Button.Props,
  'render' | 'onClick'
> & {
  render?: DictationRender<State>;
};

type Controls<State> = {
  state: State;
  start: () => void;
  stop: () => void;
  cancel: () => void;
};

function withState<State>(
  render: DictationRender<State> | undefined,
  state: State,
): Button.Props['render'] {
  return typeof render === 'function'
    ? (props: ButtonRenderProps) => render(props, state)
    : render;
}

/** Starts a dictation (idle or failed) and stops one while it records. */
export function DictationToggleButton<
  State extends Pick<DictationState, 'status'>,
>({
  dictation: { state, start, stop },
  refusesStart,
  render,
  ...props
}: Omit<DictationButtonProps<State>, 'disabled'> & {
  dictation: Controls<State>;
  refusesStart: boolean;
}) {
  const recording = state.status === 'recording';
  const canStart =
    (state.status === 'idle' || state.status === 'failed') && !refusesStart;
  return (
    <Button
      {...props}
      data-status={state.status}
      aria-pressed={recording}
      disabled={!recording && !canStart}
      onClick={recording ? stop : start}
      render={withState(render, state)}
    />
  );
}

/** Ends an active dictation with abort. */
export function DictationCancelButton<
  State extends Pick<DictationState, 'status'>,
>({
  dictation: { state, cancel },
  render,
  disabled,
  ...props
}: DictationButtonProps<State> & { dictation: Controls<State> }) {
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
