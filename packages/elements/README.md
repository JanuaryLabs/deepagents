# @deepagents/elements

Platform-neutral interactive element catalogs for DeepAgents runtimes and
renderers.

Use this package when a model may write inline HTML-style tags that a host turns
into interactive UI. The package owns the serializable contract: element names,
allowed attributes, validation, descriptor serialization, context fragments, and
stream chunking that keeps an element tag together while text streams.

React component registration lives in `@deepagents/react-genai`; this package
does not ship renderer-specific components.

## Installation

```bash
npm install @deepagents/elements
```

## Define a catalog

```typescript
import { defineElements } from '@deepagents/elements';

const elements = defineElements([
  {
    name: 'followup',
    allowedAttributes: ['question'],
    description: 'Suggest a follow-up question',
  },
]);
```

Element names and attributes must use kebab-case. Reserved DOM-clobbering
attributes such as `id`, `name`, `aria-describedby`, and `aria-labelledby` are
rejected at definition time because markdown sanitizers rewrite them before the
component can receive props.

## Add elements to context

```typescript
import {
  elementsFragment,
  elementsStreamTransform,
} from '@deepagents/elements/context';

context.set(elementsFragment(elements));

const stream = await chat(agent, {
  transform: [elementsStreamTransform],
});
```

`elementsFragment()` advertises the catalog as structured context and stores a
descriptor snapshot on fragment metadata for host readback.

`elementsStreamTransform` buffers an HTML-style element until its root tag is
complete, so clients do not render partial custom tags during streaming.

## React hosts

React hosts can define renderer-backed elements through
`@deepagents/react-genai`, which re-exports `defineElements` and adds the
`GenAIInteractiveElement` type:

```typescript
import {
  type GenAIInteractiveElement,
  defineElements,
} from '@deepagents/react-genai';

const elements = defineElements<GenAIInteractiveElement>([
  {
    name: 'followup',
    allowedAttributes: ['question'],
    description: 'Suggest a follow-up question',
    component: FollowupQuestion,
  },
]);
```
