# Recipe: Extract typed data from a page

**Use case.** You have the text of a page about a company. You want an object with typed fields. A model can give a value that the page does not state. You must keep only the values that the page states.

**What you need.** A login ([Existing login](../../README.md#existing-login)), and the packages `ai` and `zod`. The model options are those of `@ai-sdk/anthropic` ([Model behavior](../../README.md#model-behavior)).

## The steps

1. Make a zod schema. Each field has a `value` and a `quote`. The quote is the words of the page that state the value.
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

`Output.object` sends the schema to the model and parses the answer with zod. `output` has the type of the schema. A quote is a claim that the program can check: `page.includes(quote)` finds it in the page, or not. A value with no quote, or with a quote that is not in the page, becomes `null`. The page does not state the revenue, so `revenue` is `null`.

## Things to know

- **Set the effort in `providerOptions.anthropic`.** Claude 5.5 models think before they answer. `effort` (`low`, `medium`, `high`, `xhigh` or `max`) sets how much. `low` is enough to extract data.
- **`maxOutputTokens` counts the thinking too.** If the limit is too low, the answer stops before the object ends, and the parse fails.
- **Do not send `temperature`, `topP` or `topK`.** The AI SDK does not send them to Claude 5.5 models. It removes them and gives a warning.
- **The check compares exact text.** A quote across a line break must have the same line break. If the page has irregular spaces, normalize the spaces of the page and of the quote before you compare them.
