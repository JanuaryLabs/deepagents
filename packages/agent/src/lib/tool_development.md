# Tool Development Guide

Great tools are the foundation of effective agents. This comprehensive guide follows proven principles that can reduce tool failures by up to 10x.

## Table of Contents

1. [Fundamental Principles](#fundamental-principles)
2. [Perfect Tool Descriptions](#perfect-tool-descriptions)
3. [Parameter Design Excellence](#parameter-design-excellence)
4. [Complete Tool Example](#complete-tool-example)
5. [Continuous Improvement](#continuous-improvement)

## Fundamental Principles

### 1. Consistent Naming
- Use `snake_case` for all tool names consistently
- Inconsistent naming confuses models and reduces accuracy

```typescript
// ✅ Good: Consistent snake_case
const search_web = tool({ name: "search_web", ... });
const get_weather = tool({ name: "get_weather", ... });
const send_email = tool({ name: "send_email", ... });

// ❌ Avoid: Mixed naming styles
const searchWeb = tool({ name: "searchWeb", ... });
const get_weather = tool({ name: "get_weather", ... });
const SendEmail = tool({ name: "SendEmail", ... });
```

### 2. Narrow Scope: One Concern Per Tool
- Each tool should perform one atomic operation
- Split complex "do-everything" tools into smaller, precise ones

```typescript
// ❌ Avoid: Overly broad tool
const manage_files = tool({
  description: "Manage files - copy, move, delete, or rename based on action parameter",
  inputSchema: z.object({
    action: z.enum(["copy", "move", "delete", "rename"]),
    source: z.string(),
    destination: z.string().optional(),
  }),
});

// ✅ Good: Atomic, single-purpose tools
const copy_file = tool({
  description: "Tool to copy a file to a new location. Use when you need to duplicate a file.",
  inputSchema: z.object({
    source_path: z.string(),
    destination_path: z.string(),
  }),
});

const delete_file = tool({
  description: "Tool to permanently delete a file. Use when you need to remove a file after confirming the action.",
  inputSchema: z.object({
    file_path: z.string(),
  }),
});
```

## Perfect Tool Descriptions

Use this proven template:
```
Tool to <what it does>. Use when <specific situation>.
```

### Key Guidelines:
- Keep descriptions under 1024 characters
- State critical constraints upfront
- Be specific about when to use the tool

```typescript
// ✅ Excellent descriptions
const book_flight = tool({
  description: "Tool to book flight tickets after confirming user requirements. Use when user wants to book a flight after providing departure, destination, dates, and passenger details.",
});

const translate_text = tool({
  description: "Tool to translate text between languages. Use only when user specifically requests translation.",
});

const read_large_file = tool({
  description: "Tool to read file contents (max 750 lines). Use when you need to analyze or extract information from text files.",
});
```

## Parameter Design Excellence

### 1. Document Hidden Rules Explicitly
```typescript
const add_memory = tool({
  inputSchema: z.object({
    content: z.string().describe("The memory content to store"),
    agent_id: z.string().optional().describe("Agent ID. At least one of agent_id, user_id, or app_id is required."),
    user_id: z.string().optional().describe("User ID. At least one of agent_id, user_id, or app_id is required."),
    app_id: z.string().optional().describe("App ID. At least one of agent_id, user_id, or app_id is required."),
  }),
});
```

### 2. Use Strong Typing with Enums
```typescript
// ❌ Avoid: Vague string parameters
const get_weather = tool({
  inputSchema: z.object({
    unit: z.string().describe("Unit of measurement, e.g. Celsius or Fahrenheit"),
  }),
});

// ✅ Good: Explicit enums
const get_weather = tool({
  inputSchema: z.object({
    location: z.string().describe("City name or coordinates"),
    unit: z.enum(["celsius", "fahrenheit"]).describe("Temperature unit"),
  }),
});
```

### 3. Keep Parameters Minimal
```typescript
// ✅ Good: Focused, minimal parameters
const search_emails = tool({
  inputSchema: z.object({
    query: z.string().describe("Gmail search query syntax (e.g., \"from:user@example.com is:unread\")"),
  }),
});
```

### 4. Use Explicit Formatting
```typescript
const create_user = tool({
  inputSchema: z.object({
    email: z.string().email().describe("User email address"),
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Birth date in YYYY-MM-DD format"),
    phone: z.string().regex(/^\+\d{1,3}\d{10}$/).describe("Phone number with country code (e.g., +1234567890)"),
  }),
});
```

### 5. Include Inline Examples
```typescript
const gmail_search = tool({
  inputSchema: z.object({
    query: z.string().describe("Gmail search syntax. Examples: \"is:unread\", \"from:john@example.com\", \"subject:important\""),
  }),
});
```

## Complete Tool Example

```typescript
import { tool } from "ai";
import { z } from "zod";

const search_web = tool({
  description: "Tool to search the web for current information. Use when you need up-to-date information not in your training data.",
  inputSchema: z.object({
    query: z.string()
      .min(1, "Search query is required")
      .describe("Search query terms. Be specific for better results (e.g., \"TypeScript best practices 2024\")"),
    max_results: z.number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("Maximum number of results to return (1-10)"),
    source: z.enum(["web", "news", "academic"])
      .default("web")
      .describe("Type of sources to search"),
  }),
  execute: async ({ query, max_results, source }) => {
    try {
      const results = await performWebSearch(query, { 
        maxResults: max_results, 
        source 
      });
      return formatSearchResults(results);
    } catch (error) {
      return `Search failed: ${error.message}`;
    }
  },
});
```

## Continuous Improvement

- **Monitor tool usage and failure patterns**: Track anonymized production errors to identify friction points
- **Update descriptions based on agent behavior**: Refine descriptions when agents consistently misuse tools
- **Test tools with real agent interactions**: Use automated tests and evaluations before every change
- **Refine parameters based on common errors**: Adjust schemas to prevent recurring mistakes

### Testing Your Tools

```typescript
// Test tool with various scenarios
async function testSearchTool() {
  const testCases = [
    { input: { query: "TypeScript tutorial", max_results: 3 }, expected: "success" },
    { input: { query: "", max_results: 5 }, expected: "validation_error" },
    { input: { query: "test", max_results: 15 }, expected: "constraint_error" },
  ];

  for (const testCase of testCases) {
    try {
      const result = await search_web.execute(testCase.input);
      console.log(`✅ Test passed: ${JSON.stringify(testCase.input)}`);
    } catch (error) {
      if (testCase.expected === "validation_error" || testCase.expected === "constraint_error") {
        console.log(`✅ Expected error caught: ${error.message}`);
      } else {
        console.error(`❌ Unexpected error: ${error.message}`);
      }
    }
  }
}

// Run the tests
testSearchTool();
```

### Common Pitfalls to Avoid

1. **Vague descriptions**: "Process data" → "Tool to parse CSV files and extract email addresses. Use when you need to extract contacts from uploaded CSV files."

2. **Missing constraints**: Not mentioning file size limits, required formats, or dependencies

3. **Poor parameter naming**: `data` → `csv_file_content`, `options` → `extraction_format`

4. **Overloaded tools**: One tool doing multiple unrelated things instead of focused, atomic operations

5. **Missing examples**: Parameter descriptions without concrete examples of expected input formats

By following these guidelines, you'll create tools that agents can use reliably and effectively, leading to better overall system performance and fewer debugging sessions.