import { z } from 'zod';

import {
  type ContextFragment,
  type FragmentData,
  isFragmentData,
  isFragmentObject,
  isMessageFragment,
} from '../fragments.ts';
import {
  analogy,
  clarification,
  example,
  explain,
  glossary,
  guardrail,
  hint,
  policy,
  principle,
  quirk,
  role,
  styleGuide,
  term,
  workflow,
} from '../fragments/domain.ts';
import {
  alias,
  correction,
  identity,
  persona,
  preference,
} from '../fragments/user.ts';

type SerializedPrimitive = string | number | boolean | null | undefined;
type SerializedObject = { [key: string]: SerializedValue };
export type SerializedValue =
  | SerializedPrimitive
  | SerializedFragment
  | SerializedValue[]
  | SerializedObject;

export type SerializedFragmentLike = {
  type: string;
} & Record<string, unknown>;

export type SerializedFragment =
  | { type: 'term'; name: string; definition: string }
  | { type: 'hint'; text: string }
  | { type: 'guardrail'; rule: string; reason?: string; action?: string }
  | {
      type: 'explain';
      concept: string;
      explanation: string;
      therefore?: string;
    }
  | { type: 'example'; question: string; answer: string; note?: string }
  | { type: 'clarification'; when: string; ask: string; reason: string }
  | {
      type: 'workflow';
      task: string;
      steps: string[];
      triggers?: string[];
      notes?: string;
    }
  | { type: 'quirk'; issue: string; workaround: string }
  | {
      type: 'styleGuide';
      prefer: string;
      never?: string;
      always?: string;
    }
  | {
      type: 'analogy';
      concepts: string[];
      relationship: string;
      insight?: string;
      therefore?: string;
      pitfall?: string;
    }
  | { type: 'glossary'; entries: Record<string, string> }
  | { type: 'role'; content: string }
  | {
      type: 'principle';
      title: string;
      description: string;
      policies?: SerializedValue[];
    }
  | {
      type: 'policy';
      rule: string;
      before?: string;
      reason?: string;
      policies?: SerializedValue[];
    }
  | { type: 'identity'; name?: string; role?: string }
  | {
      type: 'persona';
      name: string;
      role?: string;
      objective?: string;
      tone?: string;
    }
  | { type: 'alias'; term: string; meaning: string }
  | { type: 'preference'; aspect: string; value: string }
  | { type: 'correction'; subject: string; clarification: string };

export type SerializedFragmentType = SerializedFragment['type'];

export type FragmentSerializerEntry<
  TSerialized extends SerializedFragmentLike = SerializedFragmentLike,
> = {
  toFragment: (
    input: TSerialized,
    options?: FragmentSerializationOptions,
  ) => ContextFragment;
  fromFragment?: (
    fragment: ContextFragment,
    options?: FragmentSerializationOptions,
  ) => TSerialized | undefined;
};

export type FragmentSerializerRegistry = Record<
  string,
  FragmentSerializerEntry
>;

export interface FragmentSerializationOptions<
  TRegistry extends FragmentSerializerRegistry | undefined =
    FragmentSerializerRegistry | undefined,
> {
  registry?: TRegistry;
}

function isSerializedFragmentLike(
  value: unknown,
): value is SerializedFragmentLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

function toFragmentData(
  value: unknown,
  options?: FragmentSerializationOptions,
): FragmentData {
  if (isSerializedFragmentLike(value)) {
    return toFragment(value, options);
  }

  if (Array.isArray(value)) {
    return value.map((item) => toFragmentData(item, options));
  }

  if (isFragmentObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        toFragmentData(entry, options),
      ]),
    );
  }

  if (!isFragmentData(value)) {
    throw new Error(`Unsupported serialized value of type ${typeof value}`);
  }
  return value;
}

/**
 * A built-in entry validates the stored fields before building the fragment,
 * so a malformed payload fails here instead of yielding a fragment with
 * missing fields.
 */
function builtInEntry<TInput>(
  schema: z.ZodType<TInput>,
  build: (
    input: TInput,
    options?: FragmentSerializationOptions,
  ) => ContextFragment,
): FragmentSerializerEntry {
  return {
    toFragment: (input, options) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `Invalid serialized ${input.type} fragment: ${z.prettifyError(parsed.error)}`,
        );
      }
      return build(parsed.data, options);
    },
  };
}

const nestedPolicies = z.array(z.unknown()).optional();

const builtInSerializedRegistry: Record<
  SerializedFragmentType,
  FragmentSerializerEntry
> = {
  term: builtInEntry(
    z.object({ name: z.string(), definition: z.string() }),
    (input) => term(input.name, input.definition),
  ),
  hint: builtInEntry(z.object({ text: z.string() }), (input) =>
    hint(input.text),
  ),
  guardrail: builtInEntry(
    z.object({
      rule: z.string(),
      reason: z.string().optional(),
      action: z.string().optional(),
    }),
    (input) =>
      guardrail({
        rule: input.rule,
        reason: input.reason,
        action: input.action,
      }),
  ),
  explain: builtInEntry(
    z.object({
      concept: z.string(),
      explanation: z.string(),
      therefore: z.string().optional(),
    }),
    (input) =>
      explain({
        concept: input.concept,
        explanation: input.explanation,
        therefore: input.therefore,
      }),
  ),
  example: builtInEntry(
    z.object({
      question: z.string(),
      answer: z.string(),
      note: z.string().optional(),
    }),
    (input) =>
      example({
        question: input.question,
        answer: input.answer,
        note: input.note,
      }),
  ),
  clarification: builtInEntry(
    z.object({ when: z.string(), ask: z.string(), reason: z.string() }),
    (input) =>
      clarification({
        when: input.when,
        ask: input.ask,
        reason: input.reason,
      }),
  ),
  workflow: builtInEntry(
    z.object({
      task: z.string(),
      steps: z.array(z.string()),
      triggers: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }),
    (input) =>
      workflow({
        task: input.task,
        steps: input.steps,
        triggers: input.triggers,
        notes: input.notes,
      }),
  ),
  quirk: builtInEntry(
    z.object({ issue: z.string(), workaround: z.string() }),
    (input) =>
      quirk({
        issue: input.issue,
        workaround: input.workaround,
      }),
  ),
  styleGuide: builtInEntry(
    z.object({
      prefer: z.string(),
      never: z.string().optional(),
      always: z.string().optional(),
    }),
    (input) =>
      styleGuide({
        prefer: input.prefer,
        never: input.never,
        always: input.always,
      }),
  ),
  analogy: builtInEntry(
    z.object({
      concepts: z.array(z.string()),
      relationship: z.string(),
      insight: z.string().optional(),
      therefore: z.string().optional(),
      pitfall: z.string().optional(),
    }),
    (input) =>
      analogy({
        concepts: input.concepts,
        relationship: input.relationship,
        insight: input.insight,
        therefore: input.therefore,
        pitfall: input.pitfall,
      }),
  ),
  glossary: builtInEntry(
    z.object({ entries: z.record(z.string(), z.string()) }),
    (input) => glossary(input.entries),
  ),
  role: builtInEntry(z.object({ content: z.string() }), (input) =>
    role(input.content),
  ),
  principle: builtInEntry(
    z.object({
      title: z.string(),
      description: z.string(),
      policies: nestedPolicies,
    }),
    (input, options) =>
      principle({
        title: input.title,
        description: input.description,
        policies: input.policies?.map((item) => toFragmentData(item, options)),
      }),
  ),
  policy: builtInEntry(
    z.object({
      rule: z.string(),
      before: z.string().optional(),
      reason: z.string().optional(),
      policies: nestedPolicies,
    }),
    (input, options) =>
      policy({
        rule: input.rule,
        before: input.before,
        reason: input.reason,
        policies: input.policies?.map((item) => toFragmentData(item, options)),
      }),
  ),
  identity: builtInEntry(
    z.object({ name: z.string().optional(), role: z.string().optional() }),
    (input) =>
      identity({
        name: input.name,
        role: input.role,
      }),
  ),
  persona: builtInEntry(
    z.object({
      name: z.string(),
      role: z.string().optional(),
      objective: z.string().optional(),
      tone: z.string().optional(),
    }),
    (input) =>
      persona({
        name: input.name,
        role: input.role,
        objective: input.objective,
        tone: input.tone,
      }),
  ),
  alias: builtInEntry(
    z.object({ term: z.string(), meaning: z.string() }),
    (input) => alias(input.term, input.meaning),
  ),
  preference: builtInEntry(
    z.object({ aspect: z.string(), value: z.string() }),
    (input) => preference(input.aspect, input.value),
  ),
  correction: builtInEntry(
    z.object({ subject: z.string(), clarification: z.string() }),
    (input) => correction(input.subject, input.clarification),
  ),
};

function isBuiltInSerializedType(type: string): type is SerializedFragmentType {
  return Object.hasOwn(builtInSerializedRegistry, type);
}

const messageLikeTypes = new Set(['user', 'assistant', 'message']);

function findCustomSerializedFragment(
  fragment: ContextFragment,
  options?: FragmentSerializationOptions,
): SerializedFragmentLike | undefined {
  if (!options?.registry) {
    return undefined;
  }

  for (const entry of Object.values(options.registry)) {
    const serialized = entry.fromFragment?.(fragment, options);
    if (serialized !== undefined) {
      return serialized;
    }
  }

  return undefined;
}

export function toFragment(
  input: SerializedFragmentLike,
  options?: FragmentSerializationOptions,
): ContextFragment {
  if (messageLikeTypes.has(input.type)) {
    throw new Error(
      'Message fragments are not supported by serialized fragment conversion',
    );
  }

  const entry =
    options?.registry?.[input.type] ??
    (isBuiltInSerializedType(input.type)
      ? builtInSerializedRegistry[input.type]
      : undefined);
  if (!entry) {
    throw new Error(`Unsupported serialized fragment type: ${input.type}`);
  }

  return entry.toFragment(input, options);
}

/**
 * Serialize a non-message fragment. The result is whatever the matching
 * registry entry or the fragment's codec produces, so only its `type` is
 * known statically.
 */
export function fromFragment(
  fragment: ContextFragment,
  options?: FragmentSerializationOptions,
): SerializedFragmentLike {
  if (isMessageFragment(fragment)) {
    throw new Error(
      'Message fragments are not supported by serialized fragment conversion',
    );
  }

  const customSerialized = findCustomSerializedFragment(fragment, options);
  if (customSerialized !== undefined) {
    return customSerialized;
  }

  if (fragment.codec) {
    const encoded = fragment.codec.encode();
    if (!isSerializedFragmentLike(encoded)) {
      throw new Error(
        `Fragment "${fragment.name}" codec must encode to a serialized fragment object`,
      );
    }
    return encoded;
  }

  if (!isBuiltInSerializedType(fragment.name)) {
    throw new Error(`Unsupported fragment name: ${fragment.name}`);
  }

  throw new Error(`Fragment "${fragment.name}" is missing codec`);
}
