import {
  type ContextFragment,
  type FragmentData,
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

type SerializedRegistryEntry<T extends SerializedFragment> = {
  toFragment: (input: T) => ContextFragment;
};

function isSerializedFragment(value: unknown): value is SerializedFragment {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function toFragmentData(value: SerializedValue): FragmentData {
  if (isSerializedFragment(value)) {
    return toFragment(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => toFragmentData(item));
  }

  if (isFragmentObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toFragmentData(entry)]),
    );
  }

  return value;
}

const serializedRegistry: {
  [K in SerializedFragmentType]: SerializedRegistryEntry<
    Extract<SerializedFragment, { type: K }>
  >;
} = {
  term: {
    toFragment: (input) => term(input.name, input.definition),
  },
  hint: {
    toFragment: (input) => hint(input.text),
  },
  guardrail: {
    toFragment: (input) =>
      guardrail({
        rule: input.rule,
        reason: input.reason,
        action: input.action,
      }),
  },
  explain: {
    toFragment: (input) =>
      explain({
        concept: input.concept,
        explanation: input.explanation,
        therefore: input.therefore,
      }),
  },
  example: {
    toFragment: (input) =>
      example({
        question: input.question,
        answer: input.answer,
        note: input.note,
      }),
  },
  clarification: {
    toFragment: (input) =>
      clarification({
        when: input.when,
        ask: input.ask,
        reason: input.reason,
      }),
  },
  workflow: {
    toFragment: (input) =>
      workflow({
        task: input.task,
        steps: input.steps,
        triggers: input.triggers,
        notes: input.notes,
      }),
  },
  quirk: {
    toFragment: (input) =>
      quirk({
        issue: input.issue,
        workaround: input.workaround,
      }),
  },
  styleGuide: {
    toFragment: (input) =>
      styleGuide({
        prefer: input.prefer,
        never: input.never,
        always: input.always,
      }),
  },
  analogy: {
    toFragment: (input) =>
      analogy({
        concepts: input.concepts,
        relationship: input.relationship,
        insight: input.insight,
        therefore: input.therefore,
        pitfall: input.pitfall,
      }),
  },
  glossary: {
    toFragment: (input) => glossary(input.entries),
  },
  role: {
    toFragment: (input) => role(input.content),
  },
  principle: {
    toFragment: (input) =>
      principle({
        title: input.title,
        description: input.description,
        policies: input.policies?.map((item) => toFragmentData(item)),
      }),
  },
  policy: {
    toFragment: (input) =>
      policy({
        rule: input.rule,
        before: input.before,
        reason: input.reason,
        policies: input.policies?.map((item) => toFragmentData(item)),
      }),
  },
  identity: {
    toFragment: (input) =>
      identity({
        name: input.name,
        role: input.role,
      }),
  },
  persona: {
    toFragment: (input) =>
      persona({
        name: input.name,
        role: input.role,
        objective: input.objective,
        tone: input.tone,
      }),
  },
  alias: {
    toFragment: (input) => alias(input.term, input.meaning),
  },
  preference: {
    toFragment: (input) => preference(input.aspect, input.value),
  },
  correction: {
    toFragment: (input) => correction(input.subject, input.clarification),
  },
};

const messageLikeTypes = new Set(['user', 'assistant', 'message']);

export function toFragment<T extends SerializedFragment>(
  input: T,
): ContextFragment {
  if (messageLikeTypes.has(input.type)) {
    throw new Error(
      'Message fragments are not supported by serialized fragment conversion',
    );
  }

  const entry = serializedRegistry[input.type];
  if (!entry) {
    throw new Error(`Unsupported serialized fragment type: ${input.type}`);
  }

  return entry.toFragment(input as never);
}

export function fromFragment(fragment: ContextFragment): SerializedFragment {
  if (isMessageFragment(fragment)) {
    throw new Error(
      'Message fragments are not supported by serialized fragment conversion',
    );
  }

  if (fragment.codec) {
    const encoded = fragment.codec.encode();
    if (!isSerializedFragment(encoded)) {
      throw new Error(
        `Fragment "${fragment.name}" codec must encode to a serialized fragment object`,
      );
    }
    return encoded;
  }

  if (!serializedRegistry[fragment.name as SerializedFragmentType]) {
    throw new Error(`Unsupported fragment name: ${fragment.name}`);
  }

  throw new Error(`Fragment "${fragment.name}" is missing codec`);
}
