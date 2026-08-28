import { useCallback } from 'react';
import { generatePath, useNavigate, useParams } from 'react-router';

import type { HistoryRecord } from '@deepagents/devtool-history';
import { TracesView } from '@deepagents/devtool-traces/ui';

import { selectConversation, useRuntimeData } from '../app/runtime-data.ts';
import { ConversationSummary, RuntimeStatus } from './history.tsx';

export function TracesRoute() {
  const route = useParams();
  const { discovery, history } = useRuntimeData();
  const conversation = selectConversation(history, route);
  const tracesHref = discovery?.capabilities.traces?.href;
  return conversation && tracesHref ? (
    <ConversationTraces conversation={conversation} href={tracesHref} />
  ) : conversation ? (
    <ConversationSummary conversation={conversation} />
  ) : (
    <RuntimeStatus />
  );
}

function ConversationTraces({
  conversation,
  href,
}: {
  conversation: HistoryRecord;
  href: string;
}) {
  const { traceId } = useParams();
  const navigate = useNavigate();
  const selectTrace = useCallback(
    (nextTraceId: string, replace: boolean) =>
      navigate(
        generatePath('/history/:userId/:chatId/traces/:traceId', {
          chatId: conversation.chatId,
          traceId: nextTraceId,
          userId: conversation.userId,
        }),
        { replace },
      ),
    [conversation.chatId, conversation.userId, navigate],
  );
  return (
    <TracesView
      conversation={conversation}
      href={href}
      traceId={traceId}
      onTraceId={selectTrace}
    />
  );
}
