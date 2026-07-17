import type { SQLScopeErrorPayload } from '../agents/exceptions.ts';
import {
  type RuntimeScopeDialect,
  buildOutOfScopePayload,
  buildScopeParseErrorPayload,
  extractBaseEntityReferences,
  parseStatementTypes,
} from './runtime-scope.ts';

const READ_ONLY_MESSAGE = 'only SELECT or WITH queries allowed';

export type SqlPolicyViolation =
  | { kind: 'read-only'; message: string }
  | { kind: 'scope'; payload: SQLScopeErrorPayload };

export interface SqlPolicyContext {
  resolveAllowedEntities(): Promise<readonly string[]>;
}

/**
 * Strategy used by an adapter to decide whether SQL may reach its validator or
 * executor. Implementations may analyze locally or ask the database server.
 */
export interface SqlPolicyAnalyzer {
  analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null>;
}

/** Shared parser implementation. Adapters select a concrete policy below. */
abstract class ParserSqlPolicyAnalyzer implements SqlPolicyAnalyzer {
  protected abstract readonly dialects: readonly RuntimeScopeDialect[];

  async analyze(
    sql: string,
    context: SqlPolicyContext,
  ): Promise<SqlPolicyViolation | null> {
    if (!this.#isReadOnly(sql)) {
      return { kind: 'read-only', message: READ_ONLY_MESSAGE };
    }

    const allowedEntities = await context.resolveAllowedEntities();
    const scopeError = this.#checkScope(sql, allowedEntities);
    return scopeError ? { kind: 'scope', payload: scopeError } : null;
  }

  #isReadOnly(sql: string): boolean {
    const statementTypes = this.#readParsedStatementTypes(sql);
    if (statementTypes) {
      return statementTypes.length === 1 && statementTypes[0] === 'select';
    }

    const keyword = this.#firstStatementKeyword(sql);
    return keyword === 'SELECT' || keyword === 'WITH';
  }

  #readParsedStatementTypes(sql: string): string[] | null {
    for (const dialect of this.dialects) {
      try {
        return parseStatementTypes(sql, dialect);
      } catch {
        // Parser coverage failures are handled by scope/adapter validation later.
      }
    }
    return null;
  }

  #firstStatementKeyword(sql: string): string | null {
    let offset = 0;

    while (offset < sql.length) {
      if (/\s/.test(sql[offset])) {
        offset++;
        continue;
      }

      if (sql.startsWith('--', offset)) {
        offset += 2;
        while (
          offset < sql.length &&
          sql[offset] !== '\n' &&
          sql[offset] !== '\r'
        ) {
          offset++;
        }
        continue;
      }

      if (sql.startsWith('/*', offset)) {
        const commentEnd = sql.indexOf('*/', offset + 2);
        if (commentEnd === -1) return null;
        offset = commentEnd + 2;
        continue;
      }

      const keyword = /^[A-Za-z]+/.exec(sql.slice(offset));
      return keyword ? keyword[0].toUpperCase() : null;
    }

    return null;
  }

  #checkScope(
    sql: string,
    allowedEntities: readonly string[],
  ): SQLScopeErrorPayload | null {
    let references: { db?: string | null; table: string }[] | null = null;
    let lastError: unknown;
    let lastDialect = this.dialects[0]!;
    for (const dialect of this.dialects) {
      try {
        references = extractBaseEntityReferences(sql, dialect);
        break;
      } catch (error) {
        lastDialect = dialect;
        lastError = error;
      }
    }
    if (references === null) {
      return buildScopeParseErrorPayload(sql, lastDialect, lastError);
    }

    if (references.length === 0) return null;

    const allowedQualified = new Set(
      allowedEntities.map((entity) => entity.toLowerCase()),
    );
    const allowedUnqualified = new Set<string>();
    for (const entity of allowedEntities) {
      const dot = entity.lastIndexOf('.');
      if (dot !== -1) {
        allowedUnqualified.add(entity.slice(dot + 1).toLowerCase());
      } else {
        allowedUnqualified.add(entity.toLowerCase());
      }
    }

    const outOfScope = references
      .map((reference) =>
        reference.db ? `${reference.db}.${reference.table}` : reference.table,
      )
      .filter((name) => {
        const lower = name.toLowerCase();
        if (name.includes('.')) {
          if (allowedQualified.has(lower)) return false;
          const parts = lower.split('.');
          if (parts.length >= 3) {
            const datasetTable = parts.slice(-2).join('.');
            if (allowedQualified.has(datasetTable)) return false;
          }
          return true;
        }
        return !allowedQualified.has(lower) && !allowedUnqualified.has(lower);
      });

    return outOfScope.length === 0
      ? null
      : buildOutOfScopePayload(sql, outOfScope, [...allowedEntities]);
  }
}

export class BigQuerySqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['bigquery'] as const;
}

export class MysqlSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['mysql'] as const;
}

export class PostgresSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['postgresql'] as const;
}

export class SqliteSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  // MySQL covers SQLite syntax that node-sql-parser's SQLite grammar rejects.
  protected readonly dialects = ['sqlite', 'mysql'] as const;
}

export class SqlServerSqlPolicyAnalyzer extends ParserSqlPolicyAnalyzer {
  protected readonly dialects = ['transactsql'] as const;
}
