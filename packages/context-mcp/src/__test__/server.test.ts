import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArchiveStore } from '@context/engine';
import { createMcpServer } from '../index.js';
import type { Message, ModuleInfo } from '@context/engine';

function makeModule(): ModuleInfo {
  return {
    id: 'module-typescript',
    topicKeywords: new Set(['typescript', 'type']),
    representativeQuery: 'TypeScript type guards',
    startTurn: 1,
    lastReferencedTurn: 2,
    messageIndices: [0, 1],
    status: 'archived',
    summary: 'TypeScript type system',
  };
}

const store = new ArchiveStore();
const messages: Message[] = [
  {
    role: 'user',
    content: 'How should TypeScript narrow an unknown value with a type guard?',
  },
  {
    role: 'assistant',
    content: 'Use a user-defined type predicate such as value is User.',
  },
];
await store.archive(makeModule(), messages);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createMcpServer(store);
const client = new Client(
  { name: 'context-mcp-test-client', version: '0.1.0' },
  { capabilities: {} },
);

await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
]);

const tools = await client.listTools();
assert.deepEqual(tools.tools.map((tool) => tool.name), ['search_archive']);

const response = await client.callTool({
  name: 'search_archive',
  arguments: { query: 'TypeScript type guard', topK: 3 },
});
assert.equal(response.isError, undefined);
const textContent = (response as { content?: unknown[] }).content?.[0] as
  | { type: 'text'; text: string }
  | undefined;
assert.equal(textContent?.type, 'text');

const payload = JSON.parse(
  textContent?.text ?? '',
) as { results: Array<{ metadata?: { moduleId?: string } }> };
assert.equal(payload.results.length > 0, true);
assert.equal(payload.results[0]?.metadata?.moduleId, 'module-typescript');

const invalidResponse = await client.callTool({
  name: 'search_archive',
  arguments: { query: '' },
});
assert.equal(invalidResponse.isError, true);

await client.close();
await server.close();
console.log('context-mcp server test passed');
