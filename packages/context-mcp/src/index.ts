import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ArchiveStore,
  type RetrievedContext,
} from '@context/engine';

export interface SearchArchiveResult {
  query: string;
  results: Array<{
    id: string;
    content: string;
    score?: number;
    metadata?: Record<string, unknown>;
  }>;
}

function toSearchResult(result: RetrievedContext): SearchArchiveResult['results'][number] {
  return {
    id: result.id,
    content: result.content,
    score: result.score,
    metadata: result.metadata,
  };
}

/**
 * Create an MCP server backed by an existing ArchiveStore.
 *
 * The store is injected so an embedding application can expose the same
 * in-memory archive used by the engine instead of creating a disconnected copy.
 */
export function createMcpServer(store: ArchiveStore): McpServer {
  const server = new McpServer({
    name: 'context-engine',
    version: '0.1.0',
  });

  server.registerTool(
    'search_archive',
    {
      title: 'Search archived context',
      description:
        'Search archived conversation messages with the Context Engine archive index.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Natural-language search query'),
        topK: z.number().int().min(1).max(20).default(6).describe('Maximum results'),
      },
    },
    async ({ query, topK }) => {
      const results = await store.search(query, topK);
      const payload: SearchArchiveResult = {
        query,
        results: results.map(toSearchResult),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

/**
 * Start the standalone stdio server.
 *
 * A standalone process has its own ArchiveStore. Embedding applications should
 * call createMcpServer() with their live store instead.
 */
export async function startStdioServer(store = new ArchiveStore()): Promise<void> {
  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('context-mcp listening on stdio');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startStdioServer().catch((error: unknown) => {
    console.error('context-mcp failed to start:', error);
    process.exitCode = 1;
  });
}
