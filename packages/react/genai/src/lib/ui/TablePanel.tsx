import * as React from 'react';

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
} from '@deepagents/react-shadcn';

const TablePanelRoot = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<'div'>
>(function TablePanelRoot({ className, ...props }, ref) {
  return (
    <Card
      ref={ref}
      data-slot="table-panel"
      size="default"
      className={cn(
        'border-border bg-background relative min-w-0 gap-0 overflow-visible rounded-md border py-0 text-sm/normal ring-0',
        className,
      )}
      {...props}
    />
  );
});
TablePanelRoot.displayName = 'TablePanel.Root';

function TablePanelHeader({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <CardHeader
      data-slot="table-panel-header"
      className={cn(
        'border-border flex items-center justify-between gap-4 border-b px-4 py-3',
        className,
      )}
      {...props}
    />
  );
}

function TablePanelHeading({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="table-panel-heading"
      className={cn('min-w-0', className)}
      {...props}
    />
  );
}

function TablePanelTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <CardTitle
      data-slot="table-panel-title"
      className={cn(
        'text-base font-medium text-balance wrap-anywhere',
        className,
      )}
      {...props}
    />
  );
}

function TablePanelDescription({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <CardDescription
      data-slot="table-panel-description"
      className={cn(
        'text-muted-foreground text-xs text-pretty wrap-anywhere',
        className,
      )}
      {...props}
    />
  );
}

function TablePanelActions({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <CardAction
      data-slot="table-panel-actions"
      className={cn('flex shrink-0 items-center gap-1', className)}
      {...props}
    />
  );
}

function TablePanelContent({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <CardContent
      data-slot="table-panel-content"
      className={cn('min-w-0 flex-1 overflow-auto p-0', className)}
      {...props}
    />
  );
}

export const TablePanel = Object.assign(TablePanelRoot, {
  Header: TablePanelHeader,
  Heading: TablePanelHeading,
  Title: TablePanelTitle,
  Description: TablePanelDescription,
  Actions: TablePanelActions,
  Content: TablePanelContent,
});
