/**
 * Checkpoint - A generic, reusable checkpoint system for fault-tolerant pipelines.
 *
 * Features:
 * - Unified storage using points for both single and iterative operations
 * - Atomic writes (temp file + rename) to prevent corruption
 * - Config hash invalidation to detect config changes
 * - Immediate persistence after each update
 *
 * @example
 * ```typescript
 * const checkpoint = await Checkpoint.load({
 *   path: 'output.json',
 *   configHash: hashConfig(myConfig),
 * });
 *
 * // Single computation
 * const step1 = await checkpoint.run('step1', async () => {
 *   return await doStep1();
 * });
 *
 * // Iterative with concurrency
 * const results = await checkpoint.each('step2', inputs, async (item) => {
 *   return await process(item);
 * }, { concurrency: 4 });
 *
 * // Get clean output
 * const output = checkpoint.getOutput();
 * ```
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import pLimit from 'p-limit';

export interface CheckpointOptions {
  /** Path to the checkpoint file */
  path: string;
  /** Hash to detect config changes - if changed, checkpoint is invalidated */
  configHash?: string;
}

/**
 * Codec for encoding/decoding values during checkpoint operations.
 * Use this when storing objects with methods (like Teachables) that need
 * to be serialized to plain JSON and restored with their methods.
 */
export interface Codec<T, TSerialized = unknown> {
  /** Convert runtime value to JSON-serializable format */
  encode: (value: T) => TSerialized;
  /** Convert stored JSON back to runtime value */
  decode: (serialized: TSerialized) => T;
}

interface PointEntry {
  inputHash: string;
  output: unknown;
}

interface PointData {
  committed: boolean;
  entries: PointEntry[];
}

interface CheckpointFile {
  configHash?: string;
  points: Record<string, PointData>;
}

export class Checkpoint {
  private points: Record<string, PointData>;

  private constructor(
    private path: string,
    private configHash: string | undefined,
    points: Record<string, PointData>,
  ) {
    this.points = points;
  }

  /**
   * Load checkpoint from file, or return empty checkpoint if none exists.
   * Handles corrupted files and config changes gracefully.
   */
  static async load(options: CheckpointOptions): Promise<Checkpoint> {
    const { path, configHash } = options;

    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        const file: CheckpointFile = JSON.parse(content);

        // Check if config changed
        if (configHash && file.configHash && file.configHash !== configHash) {
          console.log('⚠ Config changed, starting fresh');
          return new Checkpoint(path, configHash, {});
        }

        const points = file.points ?? {};
        const totalEntries = Object.values(points).reduce(
          (sum, p) => sum + p.entries.length,
          0,
        );
        console.log(`✓ Resuming from checkpoint (${totalEntries} entries)`);
        return new Checkpoint(path, configHash, points);
      } catch {
        console.log('⚠ Checkpoint corrupted, starting fresh');
        return new Checkpoint(path, configHash, {});
      }
    }

    console.log('Starting new checkpoint');
    return new Checkpoint(path, configHash, {});
  }

  /**
   * Run a single computation with checkpointing.
   * If already completed, returns cached value.
   *
   * @param key - Unique identifier for this computation
   * @param computation - Async function that produces the value
   * @param codec - Optional codec for encoding/decoding non-primitive values
   */
  async run<T>(
    key: string,
    computation: () => Promise<T>,
    codec?: Codec<T>,
  ): Promise<T> {
    const point = this.point<T>(key);

    // Use fixed input hash for single-value runs
    return point.through('single', async () => {
      const result = await computation();
      return codec ? (codec.encode(result) as T) : result;
    }, codec);
  }

  /**
   * Create a resumable checkpoint point for iterative operations.
   *
   * @param step - Unique identifier for this checkpoint point
   */
  point<T>(step: string): Point<T> {
    if (!this.points[step]) {
      this.points[step] = { committed: false, entries: [] };
    }
    return new Point<T>(this.points[step], () => this.save());
  }

  /**
   * Process each input with automatic checkpointing and concurrency.
   *
   * @param step - Unique identifier for this checkpoint
   * @param inputs - Items to process
   * @param process - Function to process each input
   * @param options - Optional settings like concurrency
   * @returns All outputs (use `.flat()` if outputs are arrays)
   */
  async each<I, O>(
    step: string,
    inputs: Iterable<I>,
    process: (input: I) => Promise<O>,
    options?: { concurrency?: number },
  ): Promise<O[]> {
    const point = this.point<O>(step);
    const limit = pLimit(options?.concurrency ?? 1);

    const inputArray = Array.from(inputs);
    await Promise.all(
      inputArray.map((input) =>
        limit(() => point.through(input, () => process(input))),
      ),
    );

    await point.commit();
    return point.values();
  }

  /**
   * Get clean output from all completed points.
   * Single-entry points return the value directly, multi-entry return arrays.
   */
  getOutput(): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, pointData] of Object.entries(this.points)) {
      if (pointData.entries.length === 1) {
        output[key] = pointData.entries[0].output;
      } else {
        output[key] = pointData.entries.map((e) => e.output);
      }
    }
    return output;
  }

  /** Get the file path where checkpoint is stored */
  getPath(): string {
    return this.path;
  }

  private async save(): Promise<void> {
    const file: CheckpointFile = {
      configHash: this.configHash,
      points: this.points,
    };
    const content = JSON.stringify(file, null, 2);

    // Atomic write: write to temp file, then rename
    const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, content);
    renameSync(tempPath, this.path);
  }
}

function hash(value: unknown): string {
  return createHash('md5').update(JSON.stringify(value)).digest('hex');
}

/**
 * A checkpoint point for tracking iterative operations.
 * Uses input hashing to determine if an operation was already processed.
 */
export class Point<T> {
  #cache: Map<string, T>;

  constructor(
    private data: PointData,
    private persist: () => Promise<void>,
  ) {
    this.#cache = new Map(
      data.entries.map((e) => [e.inputHash, e.output as T]),
    );
  }

  /**
   * Execute computation if input wasn't processed before.
   * Returns cached output if input hash exists, otherwise executes, saves, and returns.
   */
  async through<I, O>(
    input: I,
    compute: () => Promise<O>,
    codec?: Codec<O>,
  ): Promise<O> {
    const inputHash = hash(input);

    if (this.#cache.has(inputHash)) {
      const cached = this.#cache.get(inputHash) as O;
      return codec ? codec.decode(cached) : cached;
    }

    const output = await compute();
    this.data.entries.push({ inputHash, output });
    this.#cache.set(inputHash, output as T);
    await this.persist();
    return output;
  }

  /** Mark this point as complete. */
  async commit(): Promise<void> {
    this.data.committed = true;
    await this.persist();
  }

  /** Check if this point has been committed. */
  isCommitted(): boolean {
    return this.data.committed;
  }

  /** Get all outputs from this point. */
  values(): T[] {
    return this.data.entries.map((e) => e.output as T);
  }
}

/**
 * Generate a hash from a config object for checkpoint invalidation.
 * If config changes, the checkpoint will be invalidated and pipeline restarts.
 */
export function hashConfig(config: Record<string, unknown>): string {
  return createHash('md5').update(JSON.stringify(config)).digest('hex');
}
