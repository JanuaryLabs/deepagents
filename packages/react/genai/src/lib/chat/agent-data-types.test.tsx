import type { DataUIPart } from 'ai';
import type { ComponentProps } from 'react';
import { describe, expectTypeOf, it } from 'vitest';

import type { ChatDataTypes } from '@deepagents/context';
import { AgentProvider, useAgentMessages } from '@deepagents/react-genai';

type OnData = NonNullable<ComponentProps<typeof AgentProvider>['onData']>;

describe('AgentProvider data parts', () => {
  it('types onData with the data parts chat() streams', () => {
    const onData: OnData = (part) => {
      if (part.type === 'data-chat-title') {
        expectTypeOf(part.data).toEqualTypeOf<string>();
      }
      // @ts-expect-error no data part is named data-chat-titel
      if (part.type === 'data-chat-titel') return;
    };
    const hostOnData = (part: DataUIPart<ChatDataTypes>) => void part;

    expectTypeOf(hostOnData).toExtend<OnData>();
    expectTypeOf(onData).toBeFunction();
  });

  it('types the messages with the same data parts', () => {
    expectTypeOf<
      Extract<
        ReturnType<
          typeof useAgentMessages
        >['messages'][number]['parts'][number],
        { type: `data-${string}` }
      >
    >().toEqualTypeOf<DataUIPart<ChatDataTypes>>();
  });
});
