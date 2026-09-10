import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { openai } from '@ai-sdk/openai';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fileTelemetry } from '@deepagents/devtool/traces';
import { defineAgent } from '@deepagents/experimental/zukhruf';
import { mcp } from '@deepagents/experimental/zukhruf/mcp';
import { uploads } from '@deepagents/experimental/zukhruf/uploads';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';

export const traceTelemetry = fileTelemetry({
  path: join(import.meta.dirname, 'telemetry.jsonl'),
});
export const imageUploads = uploads({ directory: '/workspace/.uploads' });

const browser = mcp({
  name: 'browser',
  connect: () =>
    createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: process.execPath,
        args: [
          fileURLToPath(
            import.meta
              .resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),
          ),
          '--categoryExperimentalWebmcp=true',
          '--chrome-arg=--enable-features=WebMCP',
          '--isolated',
          '--no-usage-statistics',
          '--no-performance-crux',
        ],
      }),
      initializationOptions: { timeout: 15_000 },
    }),
});

export default defineAgent({
  name: 'SimpleAgent',
  model: openai('gpt-5.6-luna'),
  sandbox,
  instructions,
  plugins: [imageUploads, traceTelemetry, browser],
});
