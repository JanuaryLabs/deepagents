# Project Context

## Purpose

DeepAgents is a collection of TypeScript packages for building AI-powered applications. The project provides modular, composable building blocks for multi-agent systems, context management, natural language to SQL, retrieval-augmented generation (RAG), and ready-to-use AI tools.

**Goals:**

- Provide production-ready AI infrastructure components
- Enable developers to build sophisticated AI applications with TypeScript
- Maintain clean, well-organized code with zero technical debt
- Support 1000+ users with sustainable, long-term implementations

## Tech Stack

- **Language:** TypeScript (ESM modules, Node.js 20+)
- **Build System:** Nx monorepo
- **AI SDK:** Vercel AI SDK (compatible with OpenAI, Anthropic, Groq, etc.)
- **Schema Validation:** Zod
- **Testing:** Node.js native test runner
- **Linting:** ESLint with Prettier
- **Package Manager:** npm

## Project Conventions

### Code Style

- Always use `.ts` file extensions in imports (required for Node.js ESM)
- Prefer integration tests over unit tests
- Use Zod for schema validation and type inference
- Follow Vercel AI SDK patterns for tool and agent definitions

### Architecture Patterns

- **Monorepo Structure:** All packages live under `packages/`
- **Package Independence:** Each package is self-contained with its own build config
- **Composition Over Inheritance:** Use functional patterns and composition
- **Type Safety:** Leverage TypeScript's type system extensively

### Testing Strategy

- Focus on integration tests that verify complete flows
- Use Node.js native test runner: `node --test <file>.test.ts`
- Tests should validate overall functionality and user experience
- Evals for text2sql: `nx run text2sql:eval`

### Git Workflow

- Main branch: `main`
- Feature branches for changes
- Clean commits with descriptive messages

## Domain Context

### Package Relationships

- `@deepagents/agent` - Core agent framework, uses Vercel AI SDK
- `@deepagents/context` - Context management, can be used with any agent
- `@deepagents/text2sql` - Standalone NL-to-SQL, uses context patterns
- `@deepagents/retrieval` - RAG system, provides embeddings and search
- `@deepagents/toolbox` - Ready-to-use tools for agents

### Key Concepts

- **Agents:** Modular AI units with specific roles, tools, and handoff capabilities
- **Handoffs:** Agents can delegate tasks to specialized agents
- **Context Fragments:** Structured data rendered into prompts (XML, Markdown, TOML)
- **Teachables:** Domain knowledge injection (terms, hints, guardrails, examples)
- **Connectors:** Content sources for RAG (GitHub, RSS, local files, PDFs)

## Important Constraints

- **No Workarounds:** Always implement full, sustainable solutions
- **No Backwards Compatibility Shims:** Early development stage, do things right
- **Preserve UX Surface:** Never remove/hide features unless explicitly asked; stub instead
- **File Extensions Required:** Always use `.ts` extensions in imports for Node.js compatibility

## External Dependencies

- **Vercel AI SDK:** Core AI model integration
- **LangChain:** Text splitters for chunking
- **Zod:** Schema validation
- **Nx:** Build orchestration and monorepo management
