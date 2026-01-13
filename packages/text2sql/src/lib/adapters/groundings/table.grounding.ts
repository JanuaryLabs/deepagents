import type { Filter, Relationship, Table } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { GroundingContext } from './context.ts';

/**
 * Configuration for TableGrounding.
 */
export interface TableGroundingConfig {
  /** Filter to select seed tables */
  filter?: Filter;
  /**
   * Traverse forward (child→parent) following FK direction.
   * - true: unlimited depth
   * - number: maximum depth
   * - false/undefined: no forward traversal
   */
  forward?: boolean | number;
  /**
   * Traverse backward (parent→child) finding tables that reference us.
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
    super('table');
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
  async execute(ctx: GroundingContext): Promise<void> {
    const seedTables = await this.applyFilter();
    const forward = this.#forward;
    const backward = this.#backward;

    // No traversal at all - just add the seed tables
    if (!forward && !backward) {
      const tables = await Promise.all(
        seedTables.map((name) => this.getTable(name)),
      );
      ctx.tables.push(...tables);
      return;
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
}
