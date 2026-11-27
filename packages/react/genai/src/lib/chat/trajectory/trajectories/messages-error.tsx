import { Button } from '@zukhruf/shadcn';

import { Response } from '../../../elements/Response.tsx';
import { useGenaiMessages } from '../../../i18n/provider.tsx';

function RetryBlock({
  onTryAgain,
  error,
}: {
  error: Error;
  onTryAgain: () => void;
}) {
  const t = useGenaiMessages();
  return (
    <div className="mt-3 flex justify-start">
      <div className="max-w-[80%] space-y-2">
        <div className="text-destructive text-sm">
          <Response mode="static">{error.message}</Response>
        </div>
        <Button type="button" onClick={onTryAgain} size="sm" variant="outline">
          {t('chat.retry')}
        </Button>
      </div>
    </div>
  );
}

export function MessagesError({
  error,
  onRetry,
}: {
  error?: Error;
  onRetry?: () => void;
}) {
  if (!error || !onRetry) return null;
  return <RetryBlock onTryAgain={onRetry} error={error} />;
}
