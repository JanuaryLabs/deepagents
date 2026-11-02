# Recipe: Extract typed data from a page

**Use case.** Extract typed fields from a company page and ask the model to quote the source for each value. Discard values whose quotes are missing from the page. This checks that the quoted text exists; it does not prove that the text supports the value.

**What you need.** An [existing login](../../README.md#existing-login), plus the `@deepagents/experimental`, `ai`, and `zod` packages. The provider uses `@ai-sdk/anthropic` model options; see [Model behavior](../../README.md#model-behavior).

## The steps

1. Define a Zod schema with a `value` and a `quote` for each field. Ask the model to copy the exact source text supporting the value.
2. Call `generateText` with `output: Output.object({ schema })`.
3. Keep a value only when the page contains its quote.

## The program

```ts title="extract-company.ts"
import { Output, generateText } from 'ai';
import { z } from 'zod';

import { claude } from '@deepagents/experimental/providers/claude';

const page = `Acme Robotics builds warehouse robots. The company was founded in 2014
in Lyon, France. Marie Dubois has led Acme as chief executive since 2019.
Today 240 people work at Acme, in Lyon and in Montreal.`;

const fact = z.object({
  value: z.string().nullable(),
  quote: z
    .string()
    .describe('The exact words of the page that state the value, or ""'),
});

const company = z.object({
  name: fact,
  founded: fact,
  city: fact,
  chiefExecutive: fact,
  employees: fact,
  revenue: fact,
});

const { output } = await generateText({
  model: claude('claude-haiku-5-5'),
  output: Output.object({ schema: company }),
  system:
    'Extract each field from the page. Copy the words that state it into quote. ' +
    'If the page does not state a field, set value to null and quote to "".',
  prompt: page,
  maxOutputTokens: 4000,
  providerOptions: { anthropic: { effort: 'low' } },
});

// Keep a value only when its quote is in the page.
const facts = Object.fromEntries(
  Object.entries(output).map(([field, { value, quote }]) => [
    field,
    value !== null && quote !== '' && page.includes(quote) ? value : null,
  ]),
);

console.log(facts);
```

Output:

```
{
  name: 'Acme Robotics',
  founded: '2014',
  city: 'Lyon, France',
  chiefExecutive: 'Marie Dubois',
  employees: '240',
  revenue: null
}
```

## Why it works

`Output.object` sends the schema to the model and validates the answer with Zod. The inferred schema type determines the type of `output`. The program then uses `page.includes(quote)` to check that each nonempty quote appears in the page. A value with a missing or unmatched quote becomes `null`. In the sample output, `revenue` is `null` because the page does not state it.

A matching quote can still accompany an incorrect value. For example, the model could return `value: '2099'` with `quote: 'founded in 2014'`; this check would retain it. Review whether each quote supports its value when accuracy matters.

## Things to know

- **Set the effort in `providerOptions.anthropic`.** Claude 5.5 models think before they answer. `effort` (`low`, `medium`, `high`, `xhigh` or `max`) sets how much. `low` is enough to extract data.
- **`maxOutputTokens` counts the thinking too.** If the limit is too low, the answer stops before the object ends, and the parse fails.
- **Do not send `temperature`, `topP` or `topK`.** The AI SDK does not send them to Claude 5.5 models. It removes them and gives a warning.
- **The check compares exact text.** A quote spanning a line break must preserve that line break. If the page has irregular whitespace, normalize both the page and the quote before comparing them.
