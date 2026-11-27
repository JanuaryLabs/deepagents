import { cn } from 'cn';
import * as React from 'react';
import { memo } from 'react';

import { useGenaiMessages } from '../i18n/provider.tsx';
import {
  TablePanelStreamdown,
  type TablePanelStreamdownProps,
} from './table-panel-extension.tsx';

// Every block takes the direction of its own text (streamdown's dir="auto"),
// so an English answer in a right-to-left page still reads left to right.
export type ResponseProps = Omit<TablePanelStreamdownProps, 'dir'>;

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class StreamdownErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <RenderFailure error={this.state.error?.message ?? ''} />
        )
      );
    }
    return this.props.children;
  }
}

function RenderFailure({ error }: { error: string }) {
  const t = useGenaiMessages();
  return (
    <div className="text-destructive p-2 text-sm">
      {t('response.renderFailed', { error })}
    </div>
  );
}

export const Response = memo(({ className, ...props }: ResponseProps) => (
  <StreamdownErrorBoundary>
    <TablePanelStreamdown
      className={cn(
        'flex size-full flex-col gap-2 space-y-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
      dir="auto"
      {...props}
    />
  </StreamdownErrorBoundary>
));

Response.displayName = 'Response';
