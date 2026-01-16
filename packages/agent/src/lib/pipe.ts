import { type UIMessage, createUIMessageStream, generateId } from 'ai';

import { Agent } from './agent.ts';
import { execute } from './swarm.ts';

export type Pipeable<I, O> =
  | Agent<unknown, I, O>
  | StreamFunction<I, O>
  | StringFunction<I, O>;

type InitialState = { messages: UIMessage[] };

type InOf<IS, P> =
  P extends Agent<unknown, infer I, infer O>
    ? IS & I & O
    : P extends StreamFunction<infer I, infer O>
      ? IS & I & O
      : P extends StringFunction<infer I, infer O>
        ? IS & I & O
        : IS;

type InitialInput<P> =
  P extends Agent<unknown, infer I>
    ? I
    : P extends StreamFunction<infer I>
      ? I
      : P extends StringFunction<infer I>
        ? I
        : unknown;

export type StreamFunction<StateIn, StateOut = StateIn> = (
  state: StateIn,
  setState: (state: StateOut) => void,
) =>
  | ReturnType<typeof createUIMessageStream>
  | Promise<ReturnType<typeof createUIMessageStream>>;

export type StringFunction<StateIn, StateOut = StateIn> = (
  state: StateIn,
  setState: (state: StateOut) => void,
) => string | Promise<string>;

export function pipe<IS, P1 extends Pipeable<any, any>>(
  state: IS & InitialInput<P1>,
  p1: P1,
): () => ReturnType<typeof createUIMessageStream>;
export function pipe<
  IS,
  P1 extends Pipeable<any, any>,
  P2 extends Pipeable<InOf<IS, P1>, any>,
>(
  state: IS & InitialInput<P1>,
  p1: P1,
  p2: P2,
): () => ReturnType<typeof createUIMessageStream>;
export function pipe<
  IS extends InitialState,
  P1 extends Pipeable<any, any>,
  P2 extends Pipeable<InOf<IS, P1>, any>,
  P3 extends Pipeable<InOf<InOf<IS, P1>, P2>, any>,
>(
  state: IS & InitialInput<P1>,
  p1: P1,
  p2: P2,
  p3: P3,
): () => ReturnType<typeof createUIMessageStream>;
export function pipe(
  state: InitialState,
  ...processes: Array<Pipeable<any, any>>
) {
  return () => {
    return createUIMessageStream({
      originalMessages: state.messages,
      generateId,
      onError(error) {
        console.error('Error in pipe execution:', error);
        return ' An error occurred during processing. ';
      },
      execute: async ({ writer }) => {
        for (const it of processes) {
          if (it instanceof Agent) {
            const result = await execute(it, state.messages, state);
            writer.merge(
              result.toUIMessageStream({
                generateMessageId: generateId,
                originalMessages: state.messages,
                onFinish: async ({
                  responseMessage,
                }: {
                  responseMessage: UIMessage;
                }) => {
                  state.messages.push(responseMessage);
                },
              }),
            );
            await result.consumeStream();
          } else {
            const output = await it(state, (newState) => {
              Object.assign(
                state as Record<string, unknown>,
                newState as Record<string, unknown>,
              );
            });

            if (typeof output === 'string') {
              writer.write({
                id: generateId(),
                type: 'text-start',
              });
              writer.write({
                id: generateId(),
                type: 'text-delta',
                delta: output,
              });
              writer.write({
                id: generateId(),
                type: 'text-end',
              });
            } else {
              writer.merge(output);
            }
          }
        }
      },
    });
  };
}
