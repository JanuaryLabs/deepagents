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
    super('dialect_info');
  }

  /**
   * Collect database dialect, version, and other info.
   */
  protected abstract collectInfo(): Promise<AdapterInfo>;

  /**
   * Execute the grounding process.
   * Writes database info to ctx.info.
   */
  async execute(ctx: GroundingContext) {
    ctx.info = await this.collectInfo();
    const lines = [`Dialect: ${ctx.info.dialect ?? 'unknown'}`];
    if (ctx.info.version) {
      lines.push(`Version: ${ctx.info.version}`);
    }
    if (ctx.info.database) {
      lines.push(`Database: ${ctx.info.database}`);
    }
    if (ctx.info.details && Object.keys(ctx.info.details).length) {
      lines.push(`Details: ${JSON.stringify(ctx.info.details)}`);
    }
    return () => lines.join('\n');
  }
}
