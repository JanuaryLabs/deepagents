import * as React from 'react';
import { memo } from 'react';

import { cn } from '@deepagents/react-shadcn';

import {
  TablePanelStreamdown,
  type TablePanelStreamdownProps,
} from './table-panel-extension.tsx';

export type ResponseProps = TablePanelStreamdownProps;

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
          <div className="text-destructive p-2 text-sm">
            Failed to render content: {this.state.error?.message}
          </div>
        )
      );
    }
    return this.props.children;
  }
}

export const Response = memo(({ className, ...props }: ResponseProps) => (
  <StreamdownErrorBoundary>
    <TablePanelStreamdown
      className={cn(
        'size-full space-y-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
      {...props}
    />
  </StreamdownErrorBoundary>
));

Response.displayName = 'Response';
