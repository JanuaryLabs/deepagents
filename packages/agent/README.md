# @deepagents/agent

A framework for building multi-agent AI systems with TypeScript. Create agents that use tools, coordinate through handoffs, and work together to solve complex tasks.

## Features

- **Agent Composition** - Build modular agents with specific roles and capabilities
- **Tool Integration** - Compatible with Vercel AI SDK tools
- **Handoffs** - Agents can delegate to specialized agents automatically
- **Structured Output** - Type-safe responses with Zod schemas
- **Streaming** - Real-time streaming responses
- **Context Sharing** - Type-safe state passed between agents

## Installation

```bash
npm install @deepagents/agent
```

Requires Node.js LTS (20+) and a `zod` peer dependency.

## Quick Start

### Simple Agent

```typescript
import { agent, execute, user } from '@deepagents/agent';
import { openai } from '@ai-sdk/openai';

const assistant = agent({
  name: 'assistant',
  model: openai('gpt-4o'),
  prompt: 'You are a helpful assistant.',
});

const stream = execute(assistant, 'Hello!', {});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

### Agent with Tools

```typescript
import { agent, execute } from '@deepagents/agent';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

const weatherTool = tool({
  description: 'Get weather for a location',
  parameters: z.object({
    location: z.string(),
  }),
  execute: async ({ location }) => {
    return { temperature: 72, condition: 'sunny', location };
  },
});

const weatherAgent = agent({
  name: 'weather_agent',
  model: openai('gpt-4o'),
  prompt: 'You help users check the weather.',
  tools: { weather: weatherTool },
});

const stream = execute(weatherAgent, 'What is the weather in Tokyo?', {});
console.log(await stream.text);
```

### Multi-Agent with Handoffs

```typescript
import { agent, instructions, swarm } from '@deepagents/agent';
import { openai } from '@ai-sdk/openai';

const researcher = agent({
  name: 'researcher',
  model: openai('gpt-4o'),
  prompt: 'You research topics and provide detailed information.',
  handoffDescription: 'Handles research and fact-finding tasks',
  tools: { /* research tools */ },
});

const writer = agent({
  name: 'writer',
  model: openai('gpt-4o'),
  prompt: 'You write clear, engaging content based on research.',
  handoffDescription: 'Handles writing and content creation',
});

const coordinator = agent({
  name: 'coordinator',
  model: openai('gpt-4o'),
  prompt: instructions({
    purpose: ['Coordinate research and writing tasks'],
    routine: [
      'Analyze the request',
      'Use transfer_to_researcher for fact-finding',
      'Use transfer_to_writer for content creation',
    ],
  }),
  handoffs: [researcher, writer],
});

// Agents automatically transfer control via transfer_to_<agent_name> tools
const stream = swarm(coordinator, 'Write a blog post about AI agents', {});
```

### Structured Output

```typescript
import { agent, generate } from '@deepagents/agent';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const analyzer = agent({
  name: 'analyzer',
  model: openai('gpt-4o'),
  prompt: 'Analyze the sentiment of the given text.',
  output: z.object({
    sentiment: z.enum(['positive', 'negative', 'neutral']),
    confidence: z.number(),
    keywords: z.array(z.string()),
  }),
});

const result = await generate(analyzer, 'I love this product!', {});
console.log(result.experimental_output);
// { sentiment: 'positive', confidence: 0.95, keywords: ['love', 'product'] }
```

### Context Variables

Share state between agents and tools:

```typescript
import { agent, execute, toState } from '@deepagents/agent';
import { tool } from 'ai';
import { z } from 'zod';

interface AppContext {
  userId: string;
  preferences: Record<string, string>;
}

const preferenceTool = tool({
  description: 'Save user preference',
  parameters: z.object({
    key: z.string(),
    value: z.string(),
  }),
  execute: async ({ key, value }, options) => {
    const ctx = toState<AppContext>(options);
    ctx.preferences[key] = value;
    return `Saved ${key}=${value}`;
  },
});

const assistant = agent<unknown, AppContext>({
  name: 'assistant',
  model: openai('gpt-4o'),
  prompt: (ctx) => `Help user ${ctx?.userId} manage their preferences.`,
  tools: { savePreference: preferenceTool },
});

const context: AppContext = { userId: 'user123', preferences: {} };
const stream = execute(assistant, 'Set my theme to dark', context);
await stream.text;

console.log(context.preferences); // { theme: 'dark' }
```

## API Reference

### `agent(config)`

Creates a new agent:

```typescript
agent<Output, ContextIn, ContextOut>({
  name: string;                    // Agent identifier (required)
  model: LanguageModel;            // AI SDK model (required)
  prompt: string | string[] | ((ctx?) => string);  // Instructions
  tools?: ToolSet;                 // Available tools
  handoffs?: Agent[];              // Agents to delegate to
  handoffDescription?: string;     // When to use this agent
  output?: z.Schema<Output>;       // Structured output schema
  temperature?: number;            // LLM temperature
  toolChoice?: ToolChoice;         // 'auto' | 'none' | 'required'
})
```

### `instructions({ purpose, routine })`

Helper for structured prompts:

```typescript
instructions({
  purpose: string | string[],  // Agent's role
  routine: string[],           // Step-by-step workflow
})

// For swarm coordination
instructions.swarm({ purpose, routine })
```

### Execution Functions

```typescript
// Streaming execution
execute(agent, messages, context, config?)
stream(agent, messages, context, config?)  // alias

// Non-streaming execution
generate(agent, messages, context, config?)

// High-level UI streaming with handoff support
swarm(agent, messages, context, abortSignal?)
```

### Utilities

```typescript
// Create user message
user(message: string): UIMessage

// Access context in tools
toState<T>(options: ToolCallOptions): T

// Extract structured output
toOutput<T>(result): Promise<T>
```

## AI Model Providers

Works with any model provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/docs):

```typescript
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { groq } from '@ai-sdk/groq';

const agent1 = agent({ model: openai('gpt-4o'), /* ... */ });
const agent2 = agent({ model: anthropic('claude-sonnet-4-20250514'), /* ... */ });
const agent3 = agent({ model: google('gemini-1.5-pro'), /* ... */ });
```

## Documentation

Full documentation available at [januarylabs.github.io/deepagents](https://januarylabs.github.io/deepagents/docs/agent).

## Repository

[github.com/JanuaryLabs/deepagents](https://github.com/JanuaryLabs/deepagents)
