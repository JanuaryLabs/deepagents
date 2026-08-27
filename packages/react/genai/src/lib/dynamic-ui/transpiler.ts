import { transform } from 'sucrase';

export type TranspileResult =
  { success: true; code: string } | { success: false; error: string };

/**
 * Strip import/export statements from code since we use eval with injected scope.
 * All dependencies (React hooks, shadcn components) are already available in scope.
 */
function preprocessCode(code: string): string {
  return (
    code
      // Remove import statements (e.g., import { useState } from 'react')
      .replace(/^import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '')
      // Remove side-effect imports (e.g., import 'styles.css')
      .replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')
      // Remove "export default Component;" at end
      .replace(/^export\s+default\s+\w+;?\s*$/gm, '')
      // Convert "export default function Component" or "export default () =>" to just the definition
      .replace(/^export\s+default\s+/gm, 'const Component = ')
      .trim()
  );
}

export function transpileJSX(code: string): TranspileResult {
  try {
    // Preprocess to remove import/export statements
    const preprocessed = preprocessCode(code);

    // Sucrase transforms JSX to React.createElement calls
    const result = transform(preprocessed, {
      transforms: ['jsx', 'typescript'],
      jsxRuntime: 'classic',
      production: true,
    });

    return {
      success: true,
      code: result.code,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Unknown transpilation error',
    };
  }
}

/**
 * Extract PascalCase variable/function names from code (React component convention).
 * These are candidate component names to check at runtime.
 */
function extractComponentNames(code: string): string[] {
  const patterns = [
    /(?:const|let|var)\s+([A-Z][a-zA-Z0-9]*)\s*=/g, // const MyComponent =
    /function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g, // function MyComponent(
  ];

  const names = new Set<string>();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      names.add(match[1]);
    }
  }
  return Array.from(names);
}

// Wrap the transpiled code to return a component
// Dynamically detects component by finding PascalCase names in the code
export function wrapAsComponent(transpiledCode: string): string {
  const componentNames = extractComponentNames(transpiledCode);

  // Generate checks for each found PascalCase name
  const checks = componentNames
    .map((name) => `if (typeof ${name} !== 'undefined') return ${name};`)
    .join('\n      ');

  return `
    return (function() {
      ${transpiledCode}
      ${checks}
      return null;
    })();
  `;
}
