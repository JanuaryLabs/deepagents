import { Button } from '@zukhruf/shadcn';
import { APICallError } from 'ai';
import type { ReactNode } from 'react';

import {
  type GenaiTranslate,
  useGenaiMessages,
} from '../../../i18n/provider.tsx';

function errorSentence(error: Error, t: GenaiTranslate) {
  return APICallError.isInstance(error) && error.statusCode === 429
    ? t('chat.errorRateLimited')
    : t('chat.error');
}

export function MessagesError({
  error,
  onRetry,
  children,
}: {
  error?: Error;
  onRetry?: () => void;
  /** Draws the host's own text from the error in place of the catalog sentence. */
  children?: (error: Error) => ReactNode;
}) {
  const t = useGenaiMessages();
  if (!error || !onRetry) return null;
  return (
    <div className="mt-3 flex justify-start">
      <div className="max-w-[80%] space-y-2">
        <div role="alert" className="text-destructive text-sm">
          {children ? children(error) : errorSentence(error, t)}
        </div>
        <Button type="button" onClick={onRetry} size="sm" variant="outline">
          {t('chat.retry')}
        </Button>
      </div>
    </div>
  );
}
