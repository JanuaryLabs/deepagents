const sqlValidationMarker = Symbol('SQLValidationError');
const unanswerableSqlMarker = Symbol('UnanswerableSQLError');

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
