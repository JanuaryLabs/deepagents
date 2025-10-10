# Embed Module

A local-first RAG (Retrieval-Augmented Generation) system that ingests content from various sources, creates vector embeddings, and provides intelligent document search and question-answering capabilities.

## Quick Start

```typescript
import * as connectors from './connectors/index.ts';
import { rag } from './rag.ts';

// Ask questions about a GitHub file
const response = await rag(
  'What is the main theme of this book?',
  connectors.github(
    'mlschmitt/classic-books-markdown/Franz Kafka/The Trial.md',
  ),
);

// Query RSS feeds for latest content
const techNews = await rag(
  'What are the latest developments in AI?',
  connectors.rss('https://hnrss.org/frontpage'),
);

// Search local files
const codeHelp = await rag(
  'How does authentication work in this project?',
  connectors.local('./docs/auth-guide.md'),
);
```

## Core Concept

The embed module works with a simple **Connector** pattern. Each connector:

- **Ingests** content from a specific source (GitHub, RSS, local files, etc.)
- **Searches** through that content using semantic similarity
- **Provides** context to AI agents for intelligent responses

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Connectors    │────│   RAG Engine    │────│   AI Agent      │
│                 │    │                 │    │                 │
│ • GitHub        │    │ • Ingestion     │    │ • Groq/Kimi     │
│ • RSS Feeds     │    │ • Embedding     │    │ • Context-aware │
│ • Local Files   │    │ • Vector Search │    │ • Streaming     │
│ • PDF Documents │    │ • SQLite Store  │    │                 │
│ • Linear Issues │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Tech Stack

- **Embeddings**: Text embedding model with 1024 dimensions
- **Generation**: Large language model with streaming support
- **Vector Storage**: SQLite-vec with cosine similarity
- **Content Processing**: LangChain MarkdownTextSplitter

## Available Connectors

### GitHub Connector

Access any public GitHub file:

```typescript
import * as connectors from './connectors/index.ts';
import { rag } from './rag.ts';

// Analyze a README file
const response = await rag(
  'What are the main features of this project?',
  connectors.github('microsoft/TypeScript/README.md'),
);

// Study code documentation
const codeAnalysis = await rag(
  'How do I implement error handling?',
  connectors.github('vercel/next.js/docs/advanced-features/error-handling.md'),
);
```

### RSS Connector

Process RSS/Atom feeds with optional full-article extraction:

```typescript
import * as connectors from './connectors/index.ts';
import { rag } from './rag.ts';

// Basic RSS analysis
const news = await rag(
  "What are today's top tech stories?",
  connectors.rss('https://hnrss.org/frontpage'),
);

// With full article content extraction
const detailedNews = await rag(
  'What are the key points about AI developments?',
  connectors.rss('https://feeds.feedburner.com/oreilly/radar', {
    maxItems: 10,
    fetchFullArticles: true, // Uses Mozilla Readability
  }),
);
```

**RSS Features:**

- Industry-standard parsing (RSS 2.0, RSS 1.0, Atom)
- Mozilla Readability for full article extraction
- Metadata preservation (author, categories, dates)
- Configurable item limits

### Local File Connector

Work with local files:

```typescript
import * as connectors from './connectors/index.ts';
import { rag } from './rag.ts';

// Analyze local documentation
const docs = await rag(
  'How do I set up the development environment?',
  connectors.local('./docs/setup.md'),
);

// Query configuration files
const config = await rag(
  'What are the database connection settings?',
  connectors.local('./config/database.yml'),
);
```

### Linear Connector

Query Linear workspace issues:

```typescript
import * as connectors from './connectors/index.ts';
import { rag } from './rag.ts';

// Analyze your assigned issues
const issues = await rag(
  'What bugs are currently assigned to me?',
  connectors.linear('your-linear-api-key'),
);
```

### PDF Connector

Extract and query text content from PDF documents:

```typescript
import * as connectors from './connectors/index.ts';
import { rag } from './rag.ts';

// Query multiple PDFs using glob patterns
const research = await rag(
  'What are the key findings about machine learning?',
  connectors.pdf('./research-papers/**/*.pdf'),
);

// Query a specific PDF file
const manual = await rag(
  'How do I configure the authentication system?',
  connectors.pdfFile('./docs/user-manual.pdf'),
);

// Query a PDF from URL
const onlinePaper = await rag(
  'What methodology was used in this study?',
  connectors.pdfFile('https://example.com/paper.pdf'),
);
```

**PDF Features:**

- Supports both local files and remote URLs
- Glob pattern matching for multiple PDFs
- Text extraction using unpdf library
- Automatic page merging for cohesive content
- Excludes common non-content directories (node_modules, .git)

### GitHub Releases Connector

Ask questions about repository release notes (useful for changelogs, upgrade guides, and diffing versions):

```typescript
import * as connectors from './connectors/index.ts';
import { rag } from './rag.ts';

// Example question about recent changes
const changes = await rag(
  'Summarize the breaking changes introduced in the last two releases.',
  connectors.github.release('facebook/react'),
);

// Target a specific version
const specific = await rag(
  'What were the key features added in v18.3.0?',
  connectors.github.release('facebook/react'),
);

// Upgrade guidance
const upgrade = await rag(
  'Give me an upgrade checklist moving from v18.2.0 to the latest release.',
  connectors.github.release('facebook/react'),
);
```

## Understanding the RAG Process

When you call `rag(query, connector)`, here's what happens:

1. **Ingest**: Connector fetches and processes content
   - Content is split into chunks using MarkdownTextSplitter
   - Each chunk is converted to 1024-dimensional embeddings
   - Embeddings are stored in SQLite-vec with metadata

2. **Search**: Your query is embedded and compared
   - Query text is converted to the same embedding space
   - Cosine similarity finds the most relevant content chunks
   - Top results are ranked by relevance

3. **Generate**: AI agent creates contextual responses
   - Relevant chunks are provided as context
   - Groq Kimi model generates intelligent responses
   - Results are streamed for real-time output

## Advanced Usage

### Content Change Detection

Connectors automatically detect when content changes using SHA-256 hashing:

```typescript
const connector = connectors.github('facebook/react/CHANGELOG.md');

await rag('What changed in the latest version?', connector);
// First run: Downloads and processes content

await rag('What changed in the latest version?', connector);
// Subsequent runs: Only processes if file changed
```

### Error Handling

```typescript
try {
  const response = await rag(query, connector);
  console.log(await response.text);
} catch (error) {
  if (error.message.includes('404')) {
    console.error('Content not found');
  } else if (error.message.includes('rate limit')) {
    console.error('API rate limited, try again later');
  } else {
    console.error('RAG processing failed:', error.message);
  }
}
```

## Getting Started

1. **Configure your embedding model** with 1024-dimensional embeddings
2. **Configure your generation model** for AI responses
3. **Pick a connector** for your data source
4. **Start asking questions** with the `rag()` function

The embed module provides a complete RAG solution. The `rag()` function is your main entry point - everything else is handled automatically.
