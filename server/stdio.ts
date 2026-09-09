// Stdio is a bridge to the one running Core; it never opens a second persistence writer.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const client = new Client({ name: 'aacl-stdio-bridge', version: '0.1.0' });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(process.env.AACL_URL ?? 'http://127.0.0.1:4780/mcp')),
  );
  const server = new Server(
    { name: 'aacl', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, (req) => client.callTool(req.params));
  server.setRequestHandler(ListResourcesRequestSchema, () => client.listResources());
  server.setRequestHandler(ReadResourceRequestSchema, (req) => client.readResource(req.params));
  await server.connect(new StdioServerTransport());
  server.onclose = () => {
    void client.close();
  };
  const stop = async () => {
    await client.close();
    await server.close();
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} catch (error) {
  console.error(
    'AACL Coreへ接続できません。先にnpm startまたはnpm run devでCoreを起動してください。',
    error,
  );
  process.exitCode = 1;
}
