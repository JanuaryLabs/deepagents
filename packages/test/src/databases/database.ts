/** Connection and disposal for one server-backed database. */
export interface Database extends AsyncDisposable {
  connectionString: string;
  image: string;
  containerId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** A database() handle drops its database; a start() handle stops its container. */
  cleanup: () => Promise<void>;
}

export interface DatabaseOptions {
  labels?: Record<string, string>;
  image?: string;
  password?: string;
  /** Used by start(); database() always creates an isolated name. */
  database?: string;
}
