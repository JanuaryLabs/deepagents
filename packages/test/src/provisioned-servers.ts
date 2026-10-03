export const TEST_SERVERS_ENV = 'DEEPAGENTS_TEST_SERVERS';

export type DatabaseEngine = 'postgres' | 'mysql' | 'sqlserver';

export interface ServerCoordinates {
  image: string;
  containerId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface ProvisionedServer extends ServerCoordinates {
  engine: DatabaseEngine;
}

export function publishServer(
  engine: DatabaseEngine,
  container: ServerCoordinates,
): void {
  // Standalone global setup can publish the first server without an Nx hook.
  const serialized = process.env[TEST_SERVERS_ENV];
  const servers: ProvisionedServer[] =
    serialized === undefined ? [] : JSON.parse(serialized);
  const { image, containerId, host, port, user, password, database } =
    container;
  const published = {
    engine,
    image,
    containerId,
    host,
    port,
    user,
    password,
    database,
  };
  const previous = servers.findIndex(
    (server) =>
      server.engine === engine &&
      server.image === image &&
      server.user === user &&
      server.password === password,
  );
  if (previous === -1) servers.push(published);
  else servers[previous] = published;
  process.env[TEST_SERVERS_ENV] = JSON.stringify(servers);
}

export function requireServer(
  engine: DatabaseEngine,
  config:
    Partial<Pick<ServerCoordinates, 'image' | 'user' | 'password'>> | undefined,
): ServerCoordinates {
  const serialized = process.env[TEST_SERVERS_ENV];
  if (serialized === undefined) {
    throw new Error(
      `No provisioned ${engine} server. Run tests through the Nx test target or an explicit global setup.`,
    );
  }
  const servers: ProvisionedServer[] = JSON.parse(serialized);
  const server = servers.find(
    (server) =>
      server.engine === engine &&
      (config?.image === undefined || config.image === server.image) &&
      (config?.user === undefined || config.user === server.user) &&
      (config?.password === undefined || config.password === server.password),
  );
  if (!server) {
    throw new Error(
      `No provisioned ${engine} server matches the requested configuration. Declare the database requirement in the project's test tags.`,
    );
  }
  return server;
}
