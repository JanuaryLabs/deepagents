import pluralize from 'pluralize';

import type { Introspection } from './adapters/adapter.ts';

const describeTables = (introspection: Introspection) => {
  if (!introspection.tables.length) {
    return 'Schema unavailable.';
  }

  return introspection.tables
    .map((table) => {
      const rowCountInfo =
        table.rowCount != null
          ? ` [rows: ${table.rowCount}${table.sizeHint ? `, size: ${table.sizeHint}` : ''}]`
          : '';
      const columns = table.columns
        .map((column) => {
          const annotations: string[] = [];
          if (column.isPrimaryKey) {
            annotations.push('PK');
          }
          if (column.isIndexed && !column.isPrimaryKey) {
            annotations.push('Indexed');
          }
          if (column.kind === 'LowCardinality' && column.values?.length) {
            annotations.push(`LowCardinality: ${column.values.join(', ')}`);
          }
          if (column.stats) {
            const statParts: string[] = [];
            if (column.stats.min != null || column.stats.max != null) {
              const minText = column.stats.min ?? 'n/a';
              const maxText = column.stats.max ?? 'n/a';
              statParts.push(`range ${minText} → ${maxText}`);
            }
            if (
              column.stats.nullFraction != null &&
              Number.isFinite(column.stats.nullFraction)
            ) {
              const percent = Math.round(column.stats.nullFraction * 1000) / 10;
              statParts.push(`null≈${percent}%`);
            }
            if (statParts.length) {
              annotations.push(statParts.join(', '));
            }
          }
          const annotationText = annotations.length ? ` [${annotations.join(', ')}]` : '';
          return `    - ${column.name} (${column.type})${annotationText}`;
        })
        .join('\n');
      const indexes =
        table.indexes?.length
          ? `\n  Indexes:\n${table.indexes
              .map((index) => {
                const props: string[] = [];
                if (index.primary) {
                  props.push('PRIMARY');
                } else if (index.unique) {
                  props.push('UNIQUE');
                }
                if (index.type) {
                  props.push(index.type);
                }
                const propsText = props.length ? ` (${props.join(', ')})` : '';
                const columnsText = index.columns?.length ? index.columns.join(', ') : 'expression';
                return `    - ${index.name}${propsText}: ${columnsText}`;
              })
              .join('\n')}`
          : '';
      return `- Table: ${table.name}${rowCountInfo}\n  Columns:\n${columns}${indexes}`;
    })
    .join('\n\n');
};

const formatTableLabel = (tableName: string) => {
  const base = tableName.split('.').pop() ?? tableName;
  return base.replace(/_/g, ' ');
};

const describeRelationships = (introspection: Introspection) => {
  if (!introspection.relationships.length) {
    return 'None detected';
  }

  const tableMap = new Map(introspection.tables.map((table) => [table.name, table]));

  return introspection.relationships
    .map((relationship) => {
      const sourceLabel = formatTableLabel(relationship.table);
      const targetLabel = formatTableLabel(relationship.referenced_table);
      const singularSource = pluralize.singular(sourceLabel);
      const pluralSource = pluralize(sourceLabel);
      const singularTarget = pluralize.singular(targetLabel);
      const pluralTarget = pluralize(targetLabel);
      const sourceTable = tableMap.get(relationship.table);
      const targetTable = tableMap.get(relationship.referenced_table);
      const sourceCount = sourceTable?.rowCount;
      const targetCount = targetTable?.rowCount;
      const ratio =
        sourceCount != null && targetCount != null && targetCount > 0
          ? sourceCount / targetCount
          : null;

      let cardinality = 'each';
      if (ratio != null) {
        if (ratio > 5) {
          cardinality = `many-to-one (≈${sourceCount} vs ${targetCount})`;
        } else if (ratio < 1.2 && ratio > 0.8) {
          cardinality = `roughly 1:1 (${sourceCount} vs ${targetCount})`;
        } else if (ratio < 0.2) {
          cardinality = `one-to-many (${sourceCount} vs ${targetCount})`;
        }
      }
      const mappings = relationship.from
        .map((fromCol, idx) => {
          const targetCol = relationship.to[idx] ?? relationship.to[0] ?? fromCol;
          return `${relationship.table}.${fromCol} -> ${relationship.referenced_table}.${targetCol}`;
        })
        .join(', ');

      return `- ${relationship.table} (${relationship.from.join(', ')}) -> ${relationship.referenced_table} (${relationship.to.join(', ')}) [${cardinality}]`;
    })
    .join('\n');
};

export function databaseSchemaPrompt(options: {
  introspection: Introspection;
  context?: string;
  adapterInfo?: string;
}) {
  const tablesSummary = describeTables(options.introspection);
  const relationshipsSummary = describeRelationships(options.introspection);
  const contextInfo = options.context || '';
  const adapterInfo = options.adapterInfo;
  const lines = [
    adapterInfo ? `<adapter>${adapterInfo}</adapter>` : '',
    contextInfo ? `<context>${contextInfo}</context>` : '',
    `<tables>\n${tablesSummary}\n</tables>`,
    `<relationships>\n${relationshipsSummary}\n</relationships>`,
  ];
  return lines.filter(Boolean).join('\n\n');
}
