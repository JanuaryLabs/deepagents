import type { Root, Table } from 'mdast';
import type { LeafDirective } from 'mdast-util-directive';
import { toString } from 'mdast-util-to-string';
import * as React from 'react';
import { type ComponentProps, useMemo } from 'react';
import remarkDirective from 'remark-directive';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import {
  type AllowedTags,
  Block,
  type BlockProps,
  type ExtraProps,
  Streamdown,
  TableCopyDropdown,
  TableDownloadDropdown,
  defaultRemarkPlugins,
  detectTextDirection,
  parseMarkdownIntoBlocks,
} from 'streamdown';
import { unified } from 'unified';
import { SKIP, visit } from 'unist-util-visit';

import { buttonVariants, cn } from '@deepagents/react-shadcn';

import { TablePanel } from '../ui/TablePanel.tsx';
import { normalizeStreamdownChildren } from './normalize-streamdown-children.ts';

export type TablePanelStreamdownProps = Omit<
  ComponentProps<typeof Streamdown>,
  'parseMarkdownIntoBlocksFn'
> & {
  tableActions?: React.ReactNode;
};

type StreamdownBlockComponent = NonNullable<
  TablePanelStreamdownProps['BlockComponent']
>;

const tablePanelTag = 'response-table-panel';
const tablePanelAttributes = ['title', 'description'];
const tableActionClassName = buttonVariants({
  variant: 'ghost',
  size: 'icon-sm',
});

interface TablePanelNode {
  type: 'tablePanel';
  data: {
    hName: string;
    hProperties?: Record<string, string>;
  };
  children: [Table];
}

declare module 'mdast' {
  interface BlockContentMap {
    tablePanel: TablePanelNode;
  }

  interface RootContentMap {
    tablePanel: TablePanelNode;
  }
}

const tableDirectiveParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkDirective);

interface SourceRange {
  start: number;
  end: number;
}

const parseMarkdownWithTableDirectives: NonNullable<
  ComponentProps<typeof Streamdown>['parseMarkdownIntoBlocksFn']
> = (markdown) => {
  const blocks = parseMarkdownIntoBlocks(markdown);
  const directiveRanges = tableDirectiveRanges(markdown);

  if (directiveRanges.length === 0) return blocks;

  let offset = 0;
  const blockRanges = blocks.map((block) => {
    const range = { start: offset, end: offset + block.length };
    offset = range.end;
    return range;
  });
  const mergeWithPrevious = new Set<number>();

  for (const directiveRange of directiveRanges) {
    let foundFirstBlock = false;

    for (const [index, blockRange] of blockRanges.entries()) {
      const overlapsDirective =
        blockRange.start < directiveRange.end &&
        blockRange.end > directiveRange.start;

      if (!overlapsDirective) continue;
      if (foundFirstBlock) mergeWithPrevious.add(index);
      foundFirstBlock = true;
    }
  }

  return blocks.reduce<string[]>((groupedBlocks, block, index) => {
    if (mergeWithPrevious.has(index) && groupedBlocks.length > 0) {
      groupedBlocks[groupedBlocks.length - 1] += block;
    } else {
      groupedBlocks.push(block);
    }
    return groupedBlocks;
  }, []);
};

function isMarkdownTableDirective(
  node: { type: string } | undefined,
): node is LeafDirective {
  return (
    node?.type === 'leafDirective' && 'name' in node && node.name === 'table'
  );
}

function tableDirectiveBefore(
  children: readonly { type: string }[],
  index: number | undefined,
) {
  if (index === undefined) return undefined;
  const previous = children[index - 1];
  return isMarkdownTableDirective(previous) ? previous : undefined;
}

function tableDirectiveRanges(markdown: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const tree = tableDirectiveParser.parse(markdown);

  visit(tree, 'table', (table, index, parent) => {
    if (!parent) return;
    const directive = tableDirectiveBefore(parent.children, index);
    const start = directive?.position?.start.offset;
    const end = table.position?.end.offset;

    if (start !== undefined && end !== undefined) {
      ranges.push({ start, end });
    }
  });

  return ranges;
}

function directiveAttribute(
  directive: LeafDirective,
  attribute: 'title' | 'description',
) {
  const value = directive.attributes?.[attribute]?.trim();
  return value || undefined;
}

function tableDirectiveTextDirection(markdown: string) {
  const tree = tableDirectiveParser.parse(markdown);
  let hasTableDirective = false;

  visit(tree, 'leafDirective', (directive, index, parent) => {
    const next = index === undefined ? undefined : parent?.children[index + 1];
    if (directive.name !== 'table' || next?.type !== 'table') return;

    hasTableDirective = true;
    const metadata = [
      directiveAttribute(directive, 'title'),
      directiveAttribute(directive, 'description'),
    ]
      .filter(Boolean)
      .join(' ');
    directive.children = metadata ? [{ type: 'text', value: metadata }] : [];
  });

  if (!hasTableDirective) return undefined;
  return detectTextDirection(toString(tree, { includeHtml: false }));
}

function DefaultStreamdownBlock(props: BlockProps) {
  return <Block {...props} />;
}

function createDirectionAwareBlock(BlockComponent: StreamdownBlockComponent) {
  function DirectionAwareBlock(props: BlockProps) {
    const direction = tableDirectiveTextDirection(props.content) ?? props.dir;
    return <BlockComponent {...props} dir={direction} />;
  }

  DirectionAwareBlock.displayName = 'DirectionAwareTableBlock';
  return DirectionAwareBlock;
}

function createTablePanelNode(
  table: Table,
  directive?: LeafDirective,
): TablePanelNode {
  const title = directive && directiveAttribute(directive, 'title');
  const description = directive && directiveAttribute(directive, 'description');
  const hProperties = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };

  return {
    type: 'tablePanel',
    data: {
      hName: tablePanelTag,
      ...(Object.keys(hProperties).length > 0 ? { hProperties } : {}),
    },
    children: [table],
  };
}

function tablePanelRemarkPlugin() {
  return (tree: Root) => {
    visit(tree, 'table', (table, index, parent) => {
      if (index === undefined || !parent) return;

      const directive = tableDirectiveBefore(parent.children, index);
      const panelIndex = directive ? index - 1 : index;
      const replacedNodeCount = directive ? 2 : 1;

      parent.children.splice(
        panelIndex,
        replacedNodeCount,
        createTablePanelNode(table, directive),
      );

      return [SKIP, panelIndex + 1];
    });
  };
}

const defaultTablePanelRemarkPlugins: NonNullable<
  TablePanelStreamdownProps['remarkPlugins']
> = [
  ...Object.values(defaultRemarkPlugins),
  remarkDirective,
  tablePanelRemarkPlugin,
];

interface MarkdownTableContextValue {
  actions: React.ReactNode;
  controls: TablePanelStreamdownProps['controls'];
}

const MarkdownTableContext = React.createContext<MarkdownTableContextValue>({
  actions: null,
  controls: true,
});

function isTableActionEnabled(
  controls: TablePanelStreamdownProps['controls'],
  action: 'copy' | 'download',
) {
  if (controls === false) return false;
  if (controls === true || controls === undefined) return true;

  const tableControls = controls.table;
  if (tableControls === false) return false;
  if (tableControls === true || tableControls === undefined) return true;
  return tableControls[action] !== false;
}

function withoutBuiltInTableControls(
  controls: TablePanelStreamdownProps['controls'],
): NonNullable<TablePanelStreamdownProps['controls']> {
  if (controls === false) return false;
  if (controls === true || controls === undefined) return { table: false };
  return { ...controls, table: false };
}

interface MarkdownTablePanelProps extends ExtraProps {
  children?: React.ReactNode;
  className?: string;
  title?: string;
  description?: string;
}

function MarkdownTablePanel({
  children,
  className,
  title,
  description,
}: MarkdownTablePanelProps) {
  const { actions, controls } = React.useContext(MarkdownTableContext);
  const showCopy = isTableActionEnabled(controls, 'copy');
  const showDownload = isTableActionEnabled(controls, 'download');
  const hasMetadata = Boolean(title || description);
  const hasActions = Boolean(showCopy || showDownload || actions);

  if (!children) return null;

  return (
    <TablePanel
      data-streamdown="table-wrapper"
      className={cn('my-4', className)}
    >
      {(hasMetadata || hasActions) && (
        <TablePanel.Header className={cn(!hasMetadata && 'justify-end')}>
          {hasMetadata && (
            <TablePanel.Heading>
              {title && <TablePanel.Title>{title}</TablePanel.Title>}
              {description && (
                <TablePanel.Description className={cn(title && 'mt-1')}>
                  {description}
                </TablePanel.Description>
              )}
            </TablePanel.Heading>
          )}
          {hasActions && (
            <TablePanel.Actions data-copy-exclude="assistant-snapshot">
              {showCopy && (
                <TableCopyDropdown className={tableActionClassName} />
              )}
              {showDownload && (
                <TableDownloadDropdown className={tableActionClassName} />
              )}
              {actions}
            </TablePanel.Actions>
          )}
        </TablePanel.Header>
      )}
      <TablePanel.Content
        className={cn(
          'overflow-hidden',
          '[&>[data-streamdown=table-wrapper]]:m-0 [&>[data-streamdown=table-wrapper]]:gap-0 [&>[data-streamdown=table-wrapper]]:rounded-none [&>[data-streamdown=table-wrapper]]:border-0 [&>[data-streamdown=table-wrapper]]:bg-transparent [&>[data-streamdown=table-wrapper]]:p-0',
          '[&>[data-streamdown=table-wrapper]>div:last-child]:rounded-none [&>[data-streamdown=table-wrapper]>div:last-child]:border-0',
          '[&_[data-streamdown=table]]:tabular-nums',
          '[&_[data-streamdown=table-header]]:bg-muted/30',
          '[&_[data-streamdown=table-header-cell]]:text-muted-foreground [&_[data-streamdown=table-header-cell]]:text-xs [&_[data-streamdown=table-header-cell]]:font-medium',
          '[&_[data-streamdown=table-cell]]:py-2',
          '[&_[data-streamdown=table-row]]:hover:bg-muted/30',
        )}
      >
        {children}
      </TablePanel.Content>
    </TablePanel>
  );
}

export function TablePanelStreamdown({
  allowedTags,
  BlockComponent,
  children,
  components,
  controls,
  dir,
  mode,
  remarkPlugins,
  tableActions,
  ...props
}: TablePanelStreamdownProps) {
  const tablePanelPlugins = useMemo(() => {
    if (!remarkPlugins) {
      return defaultTablePanelRemarkPlugins;
    }
    return [...remarkPlugins, remarkDirective, tablePanelRemarkPlugin];
  }, [remarkPlugins]);

  const tablePanelAllowedTags = useMemo<AllowedTags>(
    () => ({
      ...allowedTags,
      [tablePanelTag]: tablePanelAttributes,
    }),
    [allowedTags],
  );

  const tablePanelComponents = useMemo(
    () => ({ ...components, [tablePanelTag]: MarkdownTablePanel }),
    [components],
  );

  const tableContext = useMemo<MarkdownTableContextValue>(
    () => ({ actions: tableActions, controls }),
    [controls, tableActions],
  );

  const tablePanelBlockComponent = useMemo(() => {
    if (dir !== 'auto' || mode === 'static') return BlockComponent;
    return createDirectionAwareBlock(BlockComponent ?? DefaultStreamdownBlock);
  }, [BlockComponent, dir, mode]);

  const streamdownDirection = useMemo(() => {
    if (dir !== 'auto' || mode !== 'static' || typeof children !== 'string') {
      return dir;
    }
    return tableDirectiveTextDirection(children) ?? dir;
  }, [children, dir, mode]);

  return (
    <MarkdownTableContext.Provider value={tableContext}>
      <Streamdown
        allowedTags={tablePanelAllowedTags}
        BlockComponent={tablePanelBlockComponent}
        components={tablePanelComponents}
        controls={withoutBuiltInTableControls(controls)}
        dir={streamdownDirection}
        mode={mode}
        parseMarkdownIntoBlocksFn={parseMarkdownWithTableDirectives}
        remarkPlugins={tablePanelPlugins}
        {...props}
      >
        {normalizeStreamdownChildren(
          children,
          Object.keys(tablePanelAllowedTags),
        )}
      </Streamdown>
    </MarkdownTableContext.Provider>
  );
}
