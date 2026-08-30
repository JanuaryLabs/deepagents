import { type LoaderFunctionArgs, useLoaderData } from 'react-router';

import {
  type HistoryRecord,
  StatusBadge,
  formatTimestamp,
} from '@deepagents/devtool-history';

import { loadRuntime, useHealth } from '../app/runtime-data.ts';

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

export function HistoryRoute() {
  const { conversation } = useLoaderData<typeof loader>();
  return conversation ? (
    <ConversationSummary conversation={conversation} />
  ) : (
    <RuntimeStatus />
  );
}

export function ConversationSummary({
  conversation,
}: {
  conversation: HistoryRecord;
}) {
  return (
    <div className="max-w-2xl p-8">
      <div className="flex items-start justify-between gap-6 border-b pb-5">
        <div className="min-w-0">
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            Conversation
          </p>
          <h2 className="truncate text-xl font-semibold tracking-tight">
            {conversation.title ?? conversation.chatId}
          </h2>
        </div>
        <StatusBadge status={conversation.status} />
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-5 gap-y-3 py-5 text-sm">
        <dt className="text-muted-foreground">User</dt>
        <dd className="font-mono text-xs">{conversation.userId}</dd>
        <dt className="text-muted-foreground">Chat</dt>
        <dd className="truncate font-mono text-xs">{conversation.chatId}</dd>
        <dt className="text-muted-foreground">Messages</dt>
        <dd>{conversation.messageCount}</dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd>{formatTimestamp(conversation.updatedAt)}</dd>
      </dl>
    </div>
  );
}

export function RuntimeStatus() {
  const health = useHealth();
  return (
    <p className="text-muted-foreground p-8 text-sm">
      {health.isPending
        ? 'Checking development runtime.'
        : health.data
          ? 'Development runtime connected.'
          : 'Development runtime unavailable.'}
    </p>
  );
}
