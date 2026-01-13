import type { AdapterInfo } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { GroundingContext } from './context.ts';

/**
 * Configuration for InfoGrounding.
 */
export interface InfoGroundingConfig {
  // Future: options to control what info to collect
}

/**
 * Abstract base class for database info grounding.
 *
 * Collects database dialect, version, and connection info.
 *
 * Subclasses implement the database-specific hook:
 * - `collectInfo()` - collect database info
 */
export abstract class InfoGrounding extends AbstractGrounding {
  constructor(config: InfoGroundingConfig = {}) {
    super('dialectInfo');
  }

  /**
   * Collect database dialect, version, and other info.
   */
  protected abstract collectInfo(): Promise<AdapterInfo>;

  /**
   * Execute the grounding process.
   * Writes database info to ctx.info.
   */
  async execute(ctx: GroundingContext): Promise<void> {
    ctx.info = await this.collectInfo();
  }
}
