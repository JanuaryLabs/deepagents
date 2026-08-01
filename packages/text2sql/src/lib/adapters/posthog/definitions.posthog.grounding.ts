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

function readEvents(
  values: PostHogEventDefinition[],
  filter?: Filter,
): FragmentData[] {
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

function readProperties(
  values: PostHogPropertyDefinition[],
  filter?: Filter,
): FragmentData[] {
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

function validateEvent(value: PostHogEventDefinition): PostHogEventDefinition {
  if (
    !isRecord(value) ||
    !readNonEmptyString(value.name) ||
    !isOptionalString(value.description) ||
    !isOptionalBoolean(value.verified) ||
    !isOptionalStringArray(value.tags)
  ) {
    throw new Error('PostHog returned a malformed event definition.');
  }
  return value;
}

function validateProperty(
  value: PostHogPropertyDefinition,
): PostHogPropertyDefinition {
  if (
    !isRecord(value) ||
    !readNonEmptyString(value.name) ||
    !isOptionalString(value.description) ||
    !isOptionalString(value.property_type) ||
    !isOptionalBoolean(value.is_numerical) ||
    !isOptionalBoolean(value.verified)
  ) {
    throw new Error('PostHog returned a malformed property definition.');
  }
  return value;
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
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as Record<string, FragmentData>;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean';
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
