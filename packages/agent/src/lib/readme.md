# Agent Swarm Documentation

A comprehensive guide to building and using AI agents with the DeepAgents SDK.

## Table of Contents

1. [Basic Concepts](#basic-concepts)
2. [Creating Your First Agent](#creating-your-first-agent)
3. [Agent Instructions](#agent-instructions)
4. [Context Variables & State Management](#context-variables--state-management)
5. [Tools Integration](#tools-integration)
6. [Agent Handoffs](#agent-handoffs)
7. [Execution Methods](#execution-methods)
8. [Basic Examples](#basic-examples)
9. [Advanced Patterns](#advanced-patterns)
10. [Best Practices](#best-practices)
11. [Quick Reference](#quick-reference)

## Basic Concepts

### What are Agents?

Agents are autonomous AI entities that can:

- Follow structured instructions
- Use tools to interact with external systems
- Transfer control to other specialized agents
- Maintain context and state across interactions

### Core Components

- **Instructions**: Define the agent's purpose and behavior
- **Tools**: External capabilities (web search, file operations, etc.)
- **Handoffs**: Mechanism to transfer control between agents
- **Context**: Shared state and variables between agents

## Creating Your First Agent

Here's a simple agent that acts as a helpful assistant:

```typescript
import { agent, instructions } from './agent.ts';
import { execute } from './swarm.ts';

// Create a basic agent
const assistant = agent({
  name: 'helpful_assistant',
  prompt:
    'You are a helpful assistant that answers questions clearly and concisely.',
});

// Use the agent
const response = await execute(assistant, 'What is TypeScript?');
console.log(await response.text);
```

### Agent Configuration Options

```typescript
const my_agent = agent({
  name: 'my_agent',                    // Required: Agent identifier
  prompt: instructions({...}),          // Required: Agent instructions
  model: openai('gpt-4'),              // Optional: Override default model
  tools: { search: searchTool },       // Optional: Available tools
  handoffs: [otherAgent],              // Optional: Agents to transfer to
  handoffDescription: 'Use this specialist for...',    // Optional: When to use this agent
  output: MySchema,                    // Optional: Structured output schema
  toolChoice: 'required',              // Optional: Tool usage behavior
});
```

## Agent Instructions

The `instructions()` helper creates structured prompts with purpose and routine:

```typescript
import { instructions } from './agent.ts';

const prompt = instructions({
  purpose: [
    'You are a research assistant specializing in scientific papers.',
    'You help users find and analyze research documents.',
  ],
  routine: [
    'Understand what the user is looking for',
    'Search for relevant papers using available tools',
    'Summarize key findings clearly',
    'Provide citations and sources',
  ],
});
```

### Instruction Variations

```typescript
import { instructions } from './agent.ts';

// Basic instructions
instructions({ purpose: [...], routine: [...] })

// Swarm-optimized (includes system context)
instructions.swarm({ purpose: [...], routine: [...] })

// Supervisor agent instructions
instructions.supervisor({ purpose: [...], routine: [...] })

// Sub-agent instructions (automatically transfers back)
instructions.supervisor_subagent({ purpose: [...], routine: [...] })
```

## Context Variables & State Management

Context variables allow you to share data between agents and maintain state across the conversation.

### Basic Context Usage

```typescript
import { agent, instructions } from './agent.ts';
import { execute } from './swarm.ts';

interface MyContext {
  userName: string;
  preferences: string[];
  sessionData: Record<string, any>;
}

const personalized_agent = agent<MyContext>({
  name: 'personalized_assistant',
  prompt: (context) =>
    instructions({
      purpose: [
        `You are assisting ${context?.userName || 'the user'}.`,
        'Personalize responses based on their preferences.',
      ],
      routine: [
        'Consider user preferences in your responses',
        'Maintain conversation context',
      ],
    }),
});

// Execute with context
const context: MyContext = {
  userName: 'Alice',
  preferences: ['concise answers', 'technical details'],
  sessionData: {},
};

const response = await execute(
  personalized_agent,
  'Explain TypeScript',
  context,
);
```

### Managing State with Tools

Use the `toState()` utility to access and modify context within tools:

```typescript
import { tool } from 'ai';
import { z } from 'zod';

import { toState } from './stream_utils.ts';

const update_user_preferences = tool({
  description:
    'Tool to update user preferences in their profile. Use when user wants to modify their settings or preferences.',
  inputSchema: z.object({
    preferences: z
      .array(z.string())
      .min(1, 'At least one preference required')
      .describe(
        'List of user preferences (e.g., ["concise_answers", "technical_details"])',
      ),
  }),
  execute: ({ preferences }, options) => {
    const context = toState<MyContext>(options);
    context.preferences = preferences;
    return `Updated preferences: ${preferences.join(', ')}`;
  },
});
```

### Using Context with Instructions

You can make instructions dynamic based on context:

```typescript
import { agent, instructions } from './agent.ts';
import { execute } from './swarm.ts';

interface UserContext {
  name: string;
  role: 'beginner' | 'expert';
  topic: string;
}

const adaptive_agent = agent<UserContext>({
  name: 'adaptive_tutor',
  prompt: (context) => {
    const level = context?.role === 'expert' ? 'advanced' : 'beginner';
    const greeting = context?.name ? `Hello ${context.name}!` : 'Hello!';

    return instructions({
      purpose: [
        `${greeting} You are a ${level}-level tutor.`,
        `You specialize in teaching ${context?.topic || 'various subjects'}.`,
      ],
      routine: [
        context?.role === 'expert'
          ? 'Provide detailed technical explanations'
          : 'Use simple language and examples',
        "Adapt your teaching style to the user's level",
      ],
    });
  },
});

// Usage
const context: UserContext = {
  name: 'Alice',
  role: 'beginner',
  topic: 'machine learning',
};

const response = await execute(
  adaptive_agent,
  'Explain neural networks',
  context,
);
```

## Tools Integration

Tools extend agent capabilities by allowing interaction with external systems.

### Basic Tool Creation

```typescript
import { tool } from 'ai';
import { z } from 'zod';

import { agent, instructions } from './agent.ts';

const get_current_weather = tool({
  description:
    'Tool to get current weather conditions for any location. Use when user asks for weather information.',
  inputSchema: z.object({
    location: z
      .string()
      .min(1, 'Location is required')
      .describe(
        'City name, state/country, or coordinates (e.g., "New York, NY" or "40.7128,-74.0060")',
      ),
    units: z
      .enum(['celsius', 'fahrenheit'])
      .default('celsius')
      .describe('Temperature unit for the response'),
  }),
  execute: async ({ location, units }) => {
    try {
      const weather = await fetchWeather(location, units);
      return `Current weather in ${location}: ${weather.temperature}°${units === 'celsius' ? 'C' : 'F'}, ${weather.description}`;
    } catch (error) {
      return `Weather data unavailable for ${location}: ${error.message}`;
    }
  },
});

// Add tool to agent
const weather_assistant = agent({
  name: 'weather_assistant',
  prompt: instructions({
    purpose: ['You help users get weather information.'],
    routine: ['Use the weather tool to get current conditions'],
  }),
  tools: {
    get_current_weather: get_current_weather,
  },
});
```

### Using Existing Tools

The system includes several pre-built tools:

```typescript
import { agent, instructions } from './agent.ts';
import { duckDuckGoSearch } from './tools/ddg-search.ts';

const research_agent = agent({
  name: 'research_agent',
  prompt: instructions({
    purpose: ['You research topics using web search.'],
    routine: ['Search for information and summarize findings'],
  }),
  tools: {
    web_search: duckDuckGoSearch,
  },
});
```

### Tool with Context Access

```typescript
import { tool } from 'ai';
import { z } from 'zod';

import { toState } from './stream_utils.ts';

const store_session_data = tool({
  description:
    'Tool to store key-value data in the current session. Use when you need to remember information for later use.',
  inputSchema: z.object({
    key: z
      .string()
      .min(1, 'Key is required')
      .regex(
        /^[a-zA-Z_][a-zA-Z0-9_]*$/,
        'Key must be alphanumeric with underscores',
      )
      .describe(
        'Unique identifier for the data (e.g., "user_preference", "last_search")',
      ),
    value: z.string().min(1, 'Value is required').describe('The data to store'),
  }),
  execute: ({ key, value }, options) => {
    const context = toState<MyContext>(options);
    context.sessionData[key] = value;
    return `Successfully stored ${key}: ${value}`;
  },
});
```

## Agent Handoffs

Handoffs allow agents to transfer control to specialized agents when needed.

### Simple Handoff

```typescript
import { agent, instructions } from './agent.ts';

const writer = agent({
  name: 'writer',
  prompt: instructions({
    purpose: ['You write clear, engaging content.'],
    routine: ['Create well-structured content'],
  }),
  handoffDescription:
    'Use this specialist for writing tasks and content creation',
});

const editor = agent({
  name: 'editor',
  prompt: instructions({
    purpose: ['You review and improve written content.'],
    routine: ['Review for clarity, grammar, and style'],
  }),
  handoffDescription: 'Use this specialist for editing and improving content',
});

const coordinator = agent({
  name: 'coordinator',
  prompt: instructions({
    purpose: ['You coordinate between writer and editor.'],
    routine: [
      'Determine if content needs writing or editing',
      'Transfer to appropriate specialist',
    ],
  }),
  handoffs: [writer, editor],
});
```

### Handoff Execution

```typescript
import { execute } from './swarm.ts';

// When an agent calls transfer_to_writer, control moves to the writer agent
const response = await execute(
  coordinator,
  'Write a blog post about TypeScript',
);
```

### Dynamic Handoffs

```typescript
import { agent, instructions } from './agent.ts';

const supervisor = agent({
  name: 'supervisor',
  prompt: (context) => {
    const availableAgents = context?.availableAgents || [];
    return instructions({
      purpose: ['You manage a team of specialized agents.'],
      routine: [
        'Analyze the request',
        `Available specialists: ${availableAgents.join(', ')}`,
        'Choose the most appropriate agent',
      ],
    });
  },
  handoffs: [writer, editor, researcher], // All available agents
});
```

## Execution Methods

### execute() Function

For direct agent execution:

```typescript
import { execute } from './swarm.ts';

const result = await execute(
  agent, // The agent to run
  'Your message', // Input message or UIMessage[]
  contextVariables, // Optional context
  'System prompt', // Optional system prompt override
  abortSignal, // Optional abort signal
);

// Access response
const text = await result.text;
const usage = await result.totalUsage;
```

### swarm() Function

For UI-friendly streaming with handoff support:

```typescript
import { printer } from './stream_utils.ts';
import { swarm } from './swarm.ts';

const [stream, messages] = swarm(
  agent,
  'Your message',
  contextVariables,
  'System prompt',
  abortSignal,
).tee();

// Print to console in real-time
printer.readableStream(stream);

// Collect all messages
const allMessages = await Array.fromAsync(messages);
```

### Output Processing

```typescript
// Get structured output
import { z } from 'zod';

import { agent } from './agent.ts';
import { toOutput } from './stream_utils.ts';
import { execute } from './swarm.ts';

const data_extractor = agent({
  name: 'data_extractor',
  output: z.object({
    summary: z.string(),
    keyPoints: z.array(z.string()),
  }),
  // ... other config
});

const result = await execute(data_extractor, 'Analyze this data...');
const structuredData = await toOutput(result);
console.log(structuredData.summary);
```

## Basic Examples

### 1. Simple Question-Answer Agent

```typescript
import { agent } from './agent.ts';
import { execute } from './swarm.ts';

// Most basic agent with string prompt
const qa_agent = agent({
  name: 'qa_assistant',
  prompt:
    'You are a helpful assistant that answers questions clearly and accurately.',
});

// Usage
const response = await execute(qa_agent, 'What is machine learning?');
console.log(await response.text);
```

### 2. Research Agent with Web Search

```typescript
import { agent, instructions } from './agent.ts';
import { execute } from './swarm.ts';
import { duckDuckGoSearch } from './tools/ddg-search.ts';

const research_agent = agent({
  name: 'research_agent',
  prompt: instructions({
    purpose: [
      'Research topics using web search.',
      'Provide accurate, up-to-date information.',
    ],
    routine: [
      'Search for relevant information',
      'Analyze and synthesize findings',
      'Present clear summaries with sources',
    ],
  }),
  tools: {
    search: duckDuckGoSearch,
  },
});

// Usage
const response = await execute(
  research_agent,
  'Research the latest developments in quantum computing',
);
console.log(await response.text);
```

### 3. Multi-Agent Conversation

```typescript
import { agent, instructions } from './agent.ts';
import { execute } from './swarm.ts';

const analyst = agent({
  name: 'analyst',
  prompt: instructions({
    purpose: ['Analyze data and identify patterns.'],
    routine: ['Examine data carefully', 'Identify key insights'],
  }),
  handoffDescription:
    'Use this specialist for data analysis and pattern recognition',
});

const reporter = agent({
  name: 'reporter',
  prompt: instructions({
    purpose: ['Create reports from analysis.'],
    routine: ['Format findings into clear reports'],
  }),
  handoffDescription: 'Use this specialist for report writing and presentation',
});

const manager = agent({
  name: 'manager',
  prompt: instructions({
    purpose: ['Coordinate analysis and reporting workflow.'],
    routine: [
      'Send data to analyst for analysis',
      'Send analysis to reporter for formatting',
      'Deliver final report',
    ],
  }),
  handoffs: [analyst, reporter],
});

// Usage
const response = await execute(
  manager,
  'Analyze sales data and create a report',
);
```

## Advanced Patterns

### Supervisor Pattern

The supervisor pattern coordinates multiple specialized agents:

```typescript
import { agent, instructions } from './agent.ts';
import { createSupervisor } from './patterns/supervisor.ts';
import { execute } from './swarm.ts';

// Create specialized agents
const writer = agent({
  name: 'writer',
  prompt: instructions({
    purpose: ['Create engaging written content.'],
    routine: ['Write clear, well-structured content'],
  }),
  handoffDescription: 'Use this specialist for writing and content creation',
});

const critic = agent({
  name: 'critic',
  prompt: instructions({
    purpose: ['Provide constructive criticism.'],
    routine: ['Analyze content critically', 'Suggest improvements'],
  }),
  handoffDescription: 'Use this specialist for critique and feedback',
});

// Create supervisor
const supervisor = createSupervisor({
  name: 'content_manager',
  subagents: [writer, critic],
  prompt: instructions({
    purpose: ['Manage content creation workflow.'],
    routine: [
      'Determine what type of work is needed',
      'Delegate to appropriate specialist',
      'Coordinate between agents as needed',
    ],
  }),
});

// Usage
const response = await execute(
  supervisor,
  'Create and review a blog post about TypeScript',
);
```

## Best Practices

### 1. Agent Design Principles

- **Single Responsibility**: Each agent should have a clear, focused purpose
- **Clear Instructions**: Write specific, actionable prompts
- **Tool Selection**: Only include tools the agent actually needs
- **Handoff Strategy**: Plan agent interactions before implementation

### 2. Context Management

```typescript
// ✅ Good: Structured, typed context
interface WorkflowContext {
  userId: string;
  currentStep: string;
  data: ProcessedData;
}

// ❌ Avoid: Untyped, unclear context
const context = { stuff: 'things', data: {} };
```

### 3. Error Handling

```typescript
import { agent, instructions } from './agent.ts';

const robust_agent = agent({
  name: 'robust_agent',
  prompt: instructions({
    purpose: ['Handle tasks reliably with error recovery.'],
    routine: [
      'Attempt the primary approach',
      'If that fails, try alternative methods',
      'Always provide some form of helpful response',
    ],
  }),
});
```

### 4. Tool Development

See the comprehensive [Tool Development Guide](./tool_development.md) for detailed best practices on creating effective agent tools.

**Quick highlights:**

- Use `snake_case` naming consistently
- Follow the "one concern per tool" principle
- Use the template: "Tool to `<what it does>`. Use when `<specific situation>`."
- Document parameter constraints explicitly
- Test tools with real agent interactions

---

## Quick Reference

### Creating Agents

```typescript
const agent = agent({ name, prompt, tools?, handoffs?, model? });
```

### Execution

```typescript
const result = await execute(agent, message, context?);
const stream = swarm(agent, message, context?);
```

### Context Access

```typescript
const context = toState<MyType>(options);
```

### Common Patterns

```typescript
// Basic agent
instructions({ purpose: [...], routine: [...] })

// With handoffs
agent({ handoffs: [other_agent], ... })

// With tools
agent({ tools: { toolName: toolImpl }, ... })

// Supervisor pattern
createSupervisor({ subagents: [...], ... })
```

This documentation provides everything you need to build sophisticated agent systems. Start with the basic examples and gradually incorporate more advanced patterns as your needs grow.
