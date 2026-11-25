import {
  Button,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockLine,
  CodeBlock as CodeBlockRoot,
  useHighlightedCode,
} from '@zukhruf/shadcn';
import { cn } from 'cn';
import { CheckIcon, CopyIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, use } from 'react';

import { useCopyFeedback } from '../ui/use-copy-feedback.ts';

const CodeBlockContext = createContext({ code: '' });

export type CodeBlockProps = ComponentProps<typeof CodeBlockRoot> & {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  /** Soft-wrap long lines instead of scrolling them horizontally. */
  wrap?: boolean;
  children?: ReactNode;
};

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  wrap = false,
  children,
  ...props
}: CodeBlockProps) => {
  const lines = useHighlightedCode(code, language);
  return (
    <CodeBlockContext value={{ code }}>
      <CodeBlockRoot size="sm" {...props}>
        <CodeBlockContent lineNumbers={showLineNumbers} wrap={wrap}>
          {lines.map((line, index) => (
            // A line is its position in the code: lines only append as it streams.
            // eslint-disable-next-line @eslint-react/no-array-index-key
            <CodeBlockLine key={index}>{line}</CodeBlockLine>
          ))}
        </CodeBlockContent>
        {Boolean(children) && <CodeBlockActions>{children}</CodeBlockActions>}
      </CodeBlockRoot>
    </CodeBlockContext>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, copy] = useCopyFeedback(timeout);
  const { code } = use(CodeBlockContext);

  const copyToClipboard = async () => {
    if (typeof window === 'undefined' || !navigator.clipboard.writeText) {
      onError?.(new Error('Clipboard API not available'));
      return;
    }

    try {
      await copy(code);
      onCopy?.();
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn('shrink-0', className)}
      onClick={() => void copyToClipboard()}
      size="icon-xs"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon />}
    </Button>
  );
};
