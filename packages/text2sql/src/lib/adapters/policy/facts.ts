/**
 * One statement of the SQL. A SELECT that writes its rows into a relation or
 * a file is `select-into`, not `select`.
 */
export type Statement =
  | { readonly kind: 'select' }
  | { readonly kind: 'select-into' }
  | { readonly kind: 'other'; readonly name: string };

export interface Statements {
  statements(): Promise<readonly Statement[]>;
}

/** The relations that the SQL reads, as written, without its CTE names. */
export interface Relations {
  relations(): Promise<readonly string[]>;
}

/** The functions that the SQL calls, each as the parts of its name as written. */
export interface Calls {
  calls(): Promise<readonly (readonly string[])[]>;
}
