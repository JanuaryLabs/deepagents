import { AlertCircle, RefreshCw } from 'lucide-react';
import * as React from 'react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@deepagents/react-shadcn';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  code: string;
  onRetry?: (errorMessage: string) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class DynamicUIErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  handleRetry = () => {
    const errorMessage = this.state.error?.message || 'Unknown error';
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.(errorMessage);
  };

  override render() {
    if (this.state.hasError) {
      return (
        <DynamicUIError
          error={this.state.error}
          code={this.props.code}
          onRetry={this.props.onRetry ? this.handleRetry : undefined}
        />
      );
    }

    return this.props.children;
  }
}

export function DynamicUIError({
  error,
  code,
  onRetry,
}: {
  error: Error | null;
  code: string;
  onRetry?: () => void;
}) {
  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardHeader>
        <CardTitle className="text-destructive flex items-center gap-2">
          <AlertCircle className="size-5" />
          Failed to render dynamic UI
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {error?.message || 'Unknown error occurred'}
          </AlertDescription>
        </Alert>

        <details className="text-sm">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
            View generated code
          </summary>
          <pre className="bg-muted mt-2 max-h-48 overflow-auto rounded-md p-3 text-xs">
            <code>{code}</code>
          </pre>
        </details>
      </CardContent>
      {onRetry && (
        <CardFooter>
          <Button variant="outline" onClick={onRetry} className="gap-2">
            <RefreshCw className="size-4" />
            Ask AI to fix this
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
