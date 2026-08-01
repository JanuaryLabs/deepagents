import { AbstractGrounding } from '../groundings/abstract.grounding.ts';
import type { GroundingContext } from '../groundings/context.ts';

export class PostHogInfoGrounding extends AbstractGrounding {
  constructor() {
    super('info', 'info');
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    ctx.info = {
      dialect: 'HogQL',
      details: {
        identifierQuoting:
          'Use backticks for identifiers that require quoting.',
        propertyAccess:
          'Use PostHog HogQL property access and the grounded event/person/session property definitions. Do not guess property names.',
        performance:
          'Prefer bounded time ranges and LIMIT for non-aggregate event queries. OFFSET is not supported by the Query API.',
        execution:
          'Queries run through PostHog as read-only HogQLQuery nodes, not through a PostgreSQL connection.',
      },
    };
  }
}
