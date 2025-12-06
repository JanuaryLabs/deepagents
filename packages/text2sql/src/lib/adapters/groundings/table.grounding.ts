import pluralize from 'pluralize';

import type { Filter, Relationship, Table } from '../adapter.ts';
import { AbstractGrounding } from '../grounding.ticket.ts';
import type { GroundingContext } from './context.ts';

/**
 * Configuration for TableGrounding.
 */
export interface TableGroundingConfig {
  /** Filter to select seed tables */
  filter?: Filter;
  /**
   * Traverse forward (child�parent) following FK direction.
   * - true: unlimited depth
   * - number: maximum depth
   * - false/undefined: no forward traversal
   */
  forward?: boolean | number;
  /**
   * Traverse backward (parent�child) finding tables that reference us.
   * - true: unlimited depth
   * - number: maximum depth
   * - false/undefined: no backward traversal
   */
  backward?: boolean | number;
}

/**
 * Abstract base class for table grounding.
 *
 * The `execute()` method implements a BFS traversal algorithm that discovers
 * tables and relationships. Subclasses implement the database-specific hooks:
 * - `getAllTableNames()` - list all tables
 * - `getTable()` - get table metadata
 * - `findOutgoingRelations()` - find FKs FROM a table
 * - `findIncomingRelations()` - find FKs TO a table
 */
export abstract class TableGrounding extends AbstractGrounding {
  #filter?: Filter;
  #forward?: boolean | number;
  #backward?: boolean | number;

  constructor(config: TableGroundingConfig = {}) {
    super('tables');
    this.#filter = config.filter;
    this.#forward = config.forward;
    this.#backward = config.backward;
  }

  /** Get all table names in the database */
  protected abstract getAllTableNames(): Promise<string[]>;

  /** Get full table metadata for a single table */
  protected abstract getTable(tableName: string): Promise<Table>;

  /** Find FKs FROM this table (outgoing relationships) */
  protected abstract findOutgoingRelations(
    tableName: string,
  ): Promise<Relationship[]>;

  /** Find FKs TO this table (incoming relationships) */
  protected abstract findIncomingRelations(
    tableName: string,
  ): Promise<Relationship[]>;

  /**
   * Execute the grounding process.
   * Writes discovered tables and relationships to the context.
   */
  async execute(ctx: GroundingContext) {
    const seedTables = await this.applyFilter();
    const forward = this.#forward;
    const backward = this.#backward;

    // No traversal at all - just add the seed tables
    if (!forward && !backward) {
      const tables = await Promise.all(
        seedTables.map((name) => this.getTable(name)),
      );
      ctx.tables.push(...tables);
      return () => this.#describeTables(tables);
    }

    const tables: Record<string, Table> = {};
    const allRelationships: Relationship[] = [];
    const seenRelationships = new Set<string>();

    // Track depth separately for forward/backward using BFS
    const forwardQueue: Array<{ name: string; depth: number }> = [];
    const backwardQueue: Array<{ name: string; depth: number }> = [];
    const forwardVisited = new Set<string>();
    const backwardVisited = new Set<string>();

    // Initialize queues with seed tables at depth 0
    for (const name of seedTables) {
      if (forward) forwardQueue.push({ name, depth: 0 });
      if (backward) backwardQueue.push({ name, depth: 0 });
    }

    // Process forward (child→parent)
    const forwardLimit = forward === true ? Infinity : forward || 0;
    while (forwardQueue.length > 0) {
      const item = forwardQueue.shift();
      if (!item) break;
      const { name, depth } = item;

      if (forwardVisited.has(name)) continue;
      forwardVisited.add(name);

      if (!tables[name]) {
        tables[name] = await this.getTable(name);
      }

      if (depth < forwardLimit) {
        const rels = await this.findOutgoingRelations(name);
        for (const rel of rels) {
          this.addRelationship(rel, allRelationships, seenRelationships);
          if (!forwardVisited.has(rel.referenced_table)) {
            forwardQueue.push({ name: rel.referenced_table, depth: depth + 1 });
          }
        }
      }
    }

    // Process backward (parent→child)
    const backwardLimit = backward === true ? Infinity : backward || 0;
    while (backwardQueue.length > 0) {
      const item = backwardQueue.shift();
      if (!item) break;
      const { name, depth } = item;

      if (backwardVisited.has(name)) continue;
      backwardVisited.add(name);

      if (!tables[name]) {
        tables[name] = await this.getTable(name);
      }

      if (depth < backwardLimit) {
        const rels = await this.findIncomingRelations(name);
        for (const rel of rels) {
          this.addRelationship(rel, allRelationships, seenRelationships);
          if (!backwardVisited.has(rel.table)) {
            backwardQueue.push({ name: rel.table, depth: depth + 1 });
          }
        }
      }
    }

    // Write to context
    const tablesList = Object.values(tables);
    ctx.tables.push(...tablesList);
    ctx.relationships.push(...allRelationships);
    return () => this.#describeTables(tablesList);
  }

  /**
   * Apply the filter to get seed table names.
   * If filter is an explicit array, skip querying all table names.
   */
  protected async applyFilter(): Promise<string[]> {
    const filter = this.#filter;
    if (Array.isArray(filter)) {
      return filter;
    }
    const names = await this.getAllTableNames();
    if (!filter) {
      return names;
    }
    if (filter instanceof RegExp) {
      return names.filter((name) => filter.test(name));
    }
    return names.filter(filter);
  }

  /**
   * Add a relationship to the collection, deduplicating by key.
   */
  protected addRelationship(
    rel: Relationship,
    all: Relationship[],
    seen: Set<string>,
  ): void {
    const key = `${rel.table}:${rel.from.join(',')}:${rel.referenced_table}:${rel.to.join(',')}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(rel);
    }
  }

  #describeTables(tables: Table[]): string {
    if (!tables.length) {
      return 'Schema unavailable.';
    }

    return tables
      .map((table) => {
        const rowCountInfo =
          table.rowCount != null
            ? ` [rows: ${table.rowCount}${table.sizeHint ? `, size: ${table.sizeHint}` : ''}]`
            : '';
        // Get primary key columns from constraints
        const pkConstraint = table.constraints?.find((c) => c.type === 'PRIMARY_KEY');
        const pkColumns = new Set(pkConstraint?.columns ?? []);

        const columns = table.columns
          .map((column) => {
            const annotations: string[] = [];
            const isPrimaryKey = pkColumns.has(column.name);
            if (isPrimaryKey) {
              annotations.push('PK');
            }
            if (column.isIndexed && !isPrimaryKey) {
              annotations.push('Indexed');
            }
            if (column.kind === 'Enum' && column.values?.length) {
              annotations.push(`Enum: ${column.values.join(', ')}`);
            } else if (column.kind === 'LowCardinality' && column.values?.length) {
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
                const percent =
                  Math.round(column.stats.nullFraction * 1000) / 10;
                statParts.push(`null≈${percent}%`);
              }
              if (statParts.length) {
                annotations.push(statParts.join(', '));
              }
            }
            const annotationText = annotations.length
              ? ` [${annotations.join(', ')}]`
              : '';
            return `    - ${column.name} (${column.type})${annotationText}`;
          })
          .join('\n');
        const indexes = table.indexes?.length
          ? `\n  Indexes:\n${table.indexes
              .map((index) => {
                const props: string[] = [];
                if (index.unique) {
                  props.push('UNIQUE');
                }
                if (index.type) {
                  props.push(index.type);
                }
                const propsText = props.length ? ` (${props.join(', ')})` : '';
                const columnsText = index.columns?.length
                  ? index.columns.join(', ')
                  : 'expression';
                return `    - ${index.name}${propsText}: ${columnsText}`;
              })
              .join('\n')}`
          : '';
        return `- Table: ${table.name}${rowCountInfo}\n  Columns:\n${columns}${indexes}`;
      })
      .join('\n\n');
  }

  #formatTableLabel = (tableName: string) => {
    const base = tableName.split('.').pop() ?? tableName;
    return base.replace(/_/g, ' ');
  };

  #describeRelationships = (tables: Table[], relationships: Relationship[]) => {
    if (!relationships.length) {
      return 'None detected';
    }

    const tableMap = new Map(tables.map((table) => [table.name, table]));

    return relationships
      .map((relationship) => {
        const sourceLabel = this.#formatTableLabel(relationship.table);
        const targetLabel = this.#formatTableLabel(
          relationship.referenced_table,
        );
        const singularSource = pluralize.singular(sourceLabel);
        const pluralSource = pluralize.plural(sourceLabel);
        const singularTarget = pluralize.singular(targetLabel);
        const pluralTarget = pluralize.plural(targetLabel);
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
            const targetCol =
              relationship.to[idx] ?? relationship.to[0] ?? fromCol;
            return `${relationship.table}.${fromCol} -> ${relationship.referenced_table}.${targetCol}`;
          })
          .join(', ');

        return `- ${relationship.table} (${relationship.from.join(', ')}) -> ${relationship.referenced_table} (${relationship.to.join(', ')}) [${cardinality}]`;
      })
      .join('\n');
  };
}
