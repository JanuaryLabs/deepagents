import { useCallback } from 'react';
import {
  type LoaderFunctionArgs,
  generatePath,
  useLoaderData,
  useNavigate,
  useParams,
} from 'react-router';

import type { HistoryRecord } from '@deepagents/devtool-history';
import { TracesView } from '@deepagents/devtool-traces/ui';

import { loadRuntime } from '../app/runtime-data.ts';
import { ConversationSummary, RuntimeStatus } from './history.tsx';

export async function loader({ params, request }: LoaderFunctionArgs) {
  const runtime = await loadRuntime(request.signal);
  return {
    ...runtime,
    conversation:
      runtime.history.find(
        ({ chatId, userId }) =>
          chatId === params.chatId && userId === params.userId,
      ) ?? runtime.history[0],
  };
}

export function TracesRoute() {
  const { conversation, discovery } = useLoaderData<typeof loader>();
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
