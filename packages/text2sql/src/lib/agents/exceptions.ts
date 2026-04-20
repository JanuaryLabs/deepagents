const sqlValidationMarker = Symbol('SQLValidationError');
const unanswerableSqlMarker = Symbol('UnanswerableSQLError');
const sqlScopeMarker = Symbol('SQLScopeError');
const sqlReadOnlyMarker = Symbol('SQLReadOnlyError');

export type SQLScopeErrorType = 'OUT_OF_SCOPE' | 'SQL_SCOPE_PARSE_ERROR';

export interface SQLScopeErrorPayload {
  error: string;
  error_type: SQLScopeErrorType;
  suggestion: string;
  sql_attempted: string;
  referenced_entities?: string[];
  allowed_entities?: string[];
  parser_dialect?: string;
  parser_error?: string;
}

/**
 * Error thrown when SQL validation fails.
 */
export class SQLValidationError extends Error {
  [sqlValidationMarker]: true;

  constructor(message: string) {
    super(message);
    this.name = 'SQLValidationError';
    this[sqlValidationMarker] = true;
  }

  static isInstance(error: unknown): error is SQLValidationError {
    return (
      error instanceof SQLValidationError && error[sqlValidationMarker] === true
    );
  }
}

/**
 * Error thrown when the question cannot be answered with the given schema.
 */
export class UnanswerableSQLError extends Error {
  [unanswerableSqlMarker]: true;

  constructor(message: string) {
    super(message);
    this.name = 'UnanswerableSQLError';
    this[unanswerableSqlMarker] = true;
  }

  static isInstance(error: unknown): error is UnanswerableSQLError {
    return (
      error instanceof UnanswerableSQLError &&
      error[unanswerableSqlMarker] === true
    );
  }
}

/**
 * Error thrown when a query falls outside the grounded runtime scope.
 */
export class SQLScopeError extends Error {
  [sqlScopeMarker]: true;
  readonly payload: SQLScopeErrorPayload;
  readonly errorType: SQLScopeErrorType;

  constructor(payload: SQLScopeErrorPayload) {
    super(JSON.stringify(payload));
    this.name = 'SQLScopeError';
    this.payload = payload;
    this.errorType = payload.error_type;
    this[sqlScopeMarker] = true;
  }

  static isInstance(error: unknown): error is SQLScopeError {
    return error instanceof SQLScopeError && error[sqlScopeMarker] === true;
  }
}

/**
 * Error thrown when a query is not read-only (does not start with SELECT or WITH).
 */
export class SQLReadOnlyError extends Error {
  [sqlReadOnlyMarker]: true;

  constructor(message: string) {
    super(message);
    this.name = 'SQLReadOnlyError';
    this[sqlReadOnlyMarker] = true;
  }

  static isInstance(error: unknown): error is SQLReadOnlyError {
    return (
      error instanceof SQLReadOnlyError && error[sqlReadOnlyMarker] === true
    );
  }
}
