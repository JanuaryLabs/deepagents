import { Button } from '@deepagents/react-shadcn';

import { Response } from '../../../elements/Response.tsx';

function RetryBlock({
  onTryAgain,
  error,
}: {
  error: Error | null;
  onTryAgain: () => void;
}) {
  return (
    <div className="mt-3 flex justify-start">
      <div className="max-w-[80%] space-y-2">
        <div className="text-destructive text-sm">
          <Response mode="static">
            {error instanceof Error
              ? error.message
              : 'An error occurred. Please try again.'}
          </Response>
        </div>
        <Button type="button" onClick={onTryAgain} size="sm" variant="outline">
          Try Again
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
