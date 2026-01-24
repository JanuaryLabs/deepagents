import spawn from 'nano-spawn';

export interface ContainerConfig {
  image: string;
  name: string;
  env: Record<string, string>;
  internalPort: number;
}

export interface Container {
  containerId: string;
  host: string;
  port: number;
  cleanup: () => Promise<void>;
}

/**
 * Check if Docker is available on this machine.
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await spawn('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the mapped host port for a container's internal port.
 */
async function getMappedPort(
  containerId: string,
  internalPort: number,
): Promise<number> {
  const result = await spawn('docker', [
    'port',
    containerId,
    String(internalPort),
  ]);

  // Output format: "0.0.0.0:32768" or ":::32768"
  const output = result.stdout.trim();
  const match = output.match(/:(\d+)$/);

  if (!match) {
    throw new Error(
      `Failed to get mapped port for container ${containerId}: ${output}`,
    );
  }

  return parseInt(match[1], 10);
}

/**
 * Create a Docker container for testing.
 *
 * This is a low-level function that handles the common Docker operations.
 * Use the database-specific withPostgresContainer or withSqlServerContainer
 * functions instead.
 *
 * @internal
 */
export async function createContainer(
  config: ContainerConfig,
): Promise<Container> {
  const envArgs = Object.entries(config.env).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ]);

  const runResult = await spawn('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    config.name,
    ...envArgs,
    '-P', // Publish all exposed ports to random ports
    config.image,
  ]);

  const containerId = runResult.stdout.trim();

  if (!containerId) {
    throw new Error(`Failed to start container: ${runResult.stderr}`);
  }

  try {
    const port = await getMappedPort(containerId, config.internalPort);

    return {
      containerId,
      host: 'localhost',
      port,
      cleanup: async () => {
        try {
          await spawn('docker', ['stop', containerId]);
        } catch {
          // Container might already be stopped, ignore errors
        }
      },
    };
  } catch (error) {
    // Cleanup on failure
    try {
      await spawn('docker', ['stop', containerId]);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Check if Docker is available and optionally log a skip message.
 * Returns true if Docker is available, false otherwise.
 *
 * @internal
 */
export async function checkDockerAvailable(
  testName?: string,
): Promise<boolean> {
  const available = await isDockerAvailable();
  if (!available && testName) {
    console.log(`Skipping ${testName}: Docker not available`);
  }
  return available;
}
