import * as React from 'react';

import { DynamicUIError, DynamicUIErrorBoundary } from './error-boundary.tsx';
import { getScopeKeys, getScopeValues } from './safe-scope.ts';
import { transpileJSX, wrapAsComponent } from './transpiler.ts';

interface DynamicRendererProps {
  code: string;
  onRetry?: (errorMessage: string) => void;
}

type EvalResult =
  | { success: true; Component: React.ComponentType }
  | { success: false; error: string };

function evalCode(code: string): EvalResult {
  try {
    const transpileResult = transpileJSX(code);

    if (!transpileResult.success) {
      return {
        success: false,
        error: `Transpilation failed: ${transpileResult.error}`,
      };
    }

    const wrappedCode = wrapAsComponent(transpileResult.code);
    const scopeKeys = getScopeKeys();
    const scopeValues = getScopeValues();

    // Create function with safe scope - dangerous globals are set to undefined
    // eslint-disable-next-line no-new-func
    const factory = new Function(...scopeKeys, wrappedCode);
    const Component = factory(...scopeValues);

    if (!Component) {
      return {
        success: false,
        error: 'Code must export a Component variable',
      };
    }

    return {
      success: true,
      Component,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Unknown evaluation error',
    };
  }
}

export function DynamicRenderer({ code, onRetry }: DynamicRendererProps) {
  const result = React.useMemo(() => evalCode(code), [code]);

  if (!result.success) {
    return (
      <DynamicUIError
        error={new Error(result.error)}
        code={code}
        onRetry={onRetry ? () => onRetry(result.error) : undefined}
      />
    );
  }

  const Component = result.Component;

  return (
    <DynamicUIErrorBoundary code={code} onRetry={onRetry}>
      <Component />
    </DynamicUIErrorBoundary>
  );
}
