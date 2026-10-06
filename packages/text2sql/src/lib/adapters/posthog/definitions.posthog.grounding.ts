import { z } from 'zod';

import type { ContextFragment, FragmentData } from '@deepagents/context';

import type { Filter } from '../adapter.ts';
import { AbstractGrounding } from '../groundings/abstract.grounding.ts';
import type { GroundingContext } from '../groundings/context.ts';
import type { PostHog } from './posthog.ts';
import type {
  PostHogEventDefinition,
  PostHogPropertyDefinition,
  PostHogPropertyDefinitionType,
} from './types.ts';

type StandardPropertyType = Exclude<PostHogPropertyDefinitionType, 'group'>;

// Definitions as PostHog's event_definitions and property_definitions
// endpoints list them. Only the members this grounding reads are checked.

const postHogEventDefinition = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  verified: z.boolean().nullish(),
});

const postHogPropertyDefinition = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  property_type: z.string().nullish(),
  is_numerical: z.boolean().nullish(),
  verified: z.boolean().nullish(),
});

export interface PostHogDefinitionsGroundingConfig {
  events?: Filter;
  properties?: Filter;
  propertyTypes?: StandardPropertyType[];
  groupTypeIndexes?: number[];
}

export class PostHogDefinitionsGrounding extends AbstractGrounding {
  readonly #adapter: PostHog;
  readonly #config: PostHogDefinitionsGroundingConfig;

  constructor(
    adapter: PostHog,
    config: PostHogDefinitionsGroundingConfig = {},
  ) {
    super('definitions', 'definitions');
    this.#adapter = adapter;
    this.#config = config;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    const fragments = (ctx.fragments ??= []);
    const configuredPropertyTypes: StandardPropertyType[] = this.#config
      .propertyTypes ?? ['event', 'person', 'session'];
    const propertyTypes = [
      ...new Set<StandardPropertyType>(configuredPropertyTypes),
    ];
    validatePropertyTypes(propertyTypes);
    const groupTypeIndexes = [...new Set(this.#config.groupTypeIndexes ?? [])];
    if (
      groupTypeIndexes.some((index) => !Number.isInteger(index) || index < 0)
    ) {
      throw new Error(
        'PostHog groupTypeIndexes must contain non-negative integers.',
      );
    }

    const propertyRequests = [
      ...propertyTypes.map(async (type) => ({
        type,
        definitions: await this.#adapter.transport.listPropertyDefinitions({
          type,
        }),
      })),
      ...groupTypeIndexes.map(async (groupTypeIndex) => ({
        type: `group:${groupTypeIndex}`,
        definitions: await this.#adapter.transport.listPropertyDefinitions({
          type: 'group',
          groupTypeIndex,
        }),
      })),
    ];
    const [events, properties] = await Promise.all([
      this.#adapter.transport.listEventDefinitions(),
      Promise.all(propertyRequests),
    ]);

    const eventData = readEvents(events, this.#config.events);
    if (eventData.length > 0) {
      fragments.push({ name: 'posthogEvents', data: eventData });
    }

    const propertyData: Record<string, FragmentData> = {};
    for (const group of properties) {
      const definitions = readProperties(
        group.definitions,
        this.#config.properties,
      );
      if (definitions.length > 0) propertyData[group.type] = definitions;
    }
    if (Object.keys(propertyData).length > 0) {
      fragments.push({
        name: 'posthogProperties',
        data: propertyData,
      } satisfies ContextFragment);
    }
  }
}

function readEvents(values: unknown[], filter?: Filter): FragmentData[] {
  return values
    .map(validateEvent)
    .filter((event) => matchesFilter(event.name, filter))
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((event) =>
      compact({
        name: event.name,
        description: event.description ?? undefined,
        tags: event.tags?.length ? event.tags : undefined,
        verified: event.verified ?? undefined,
      }),
    );
}

function readProperties(values: unknown[], filter?: Filter): FragmentData[] {
  return values
    .map(validateProperty)
    .filter((property) => matchesFilter(property.name, filter))
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((property) =>
      compact({
        name: property.name,
        description: property.description ?? undefined,
        propertyType: property.property_type ?? undefined,
        numerical: property.is_numerical ?? undefined,
        verified: property.verified ?? undefined,
      }),
    );
}

function validateEvent(value: unknown): PostHogEventDefinition {
  const event = postHogEventDefinition.safeParse(value);
  if (!event.success) {
    throw new Error('PostHog returned a malformed event definition.');
  }
  return event.data;
}

function validateProperty(value: unknown): PostHogPropertyDefinition {
  const property = postHogPropertyDefinition.safeParse(value);
  if (!property.success) {
    throw new Error('PostHog returned a malformed property definition.');
  }
  return property.data;
}

function validatePropertyTypes(values: StandardPropertyType[]): void {
  const allowed = new Set<StandardPropertyType>(['event', 'person', 'session']);
  if (values.some((value) => !allowed.has(value))) {
    throw new Error('PostHog propertyTypes contains an unsupported type.');
  }
}

function matchesFilter(name: string, filter?: Filter): boolean {
  if (!filter) return true;
  if (Array.isArray(filter)) return filter.includes(name);
  if (filter instanceof RegExp) {
    filter.lastIndex = 0;
    return filter.test(name);
  }
  return filter(name);
}

function compact(
  value: Record<string, FragmentData | undefined>,
): Record<string, FragmentData> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, FragmentData] => entry[1] !== undefined,
    ),
  );
}
