import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type MockClientConfig = {
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
};

let listToolsImpl: () => Promise<Tool[]>;
let closeCalls = 0;
const createdConfigs: MockClientConfig[] = [];

mock.module('./client.js', () => ({
  CraftMcpClient: class {
    constructor(config: MockClientConfig) {
      createdConfigs.push(config);
    }

    async connect(): Promise<void> {
      // listTools() below is the validation surface under test.
    }

    getServerInfo(): { name: string; version: string } | undefined {
      return undefined;
    }

    async listTools(): Promise<Tool[]> {
      return listToolsImpl();
    }

    async close(): Promise<void> {
      closeCalls++;
    }
  },
}));

const { validateMcpConnection } = await import('./validation.ts');

describe('validateMcpConnection', () => {
  beforeEach(() => {
    createdConfigs.length = 0;
    closeCalls = 0;
    listToolsImpl = async () => [
      {
        name: 'list_projects',
        description: 'List projects',
        inputSchema: { type: 'object', properties: {} },
      } as Tool,
    ];
  });

  it('validates remote MCP directly without Claude credentials', async () => {
    const result = await validateMcpConnection({
      mcpUrl: 'https://mcp.example.com/',
    });

    expect(result.success).toBe(true);
    expect(result.tools).toEqual(['list_projects']);
    expect(createdConfigs[0]).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com',
      headers: undefined,
    });
    expect(closeCalls).toBe(1);
  });

  it('maps MCP auth failures to needs-auth', async () => {
    listToolsImpl = async () => {
      const error = new Error('401 Unauthorized');
      (error as Error & { code?: number }).code = 401;
      throw error;
    };

    const result = await validateMcpConnection({
      mcpUrl: 'https://mcp.example.com/',
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('needs-auth');
    expect(result.error).toBe('MCP server requires authentication');
    expect(closeCalls).toBe(1);
  });

  it('keeps invalid tool schema validation on the direct MCP path', async () => {
    listToolsImpl = async () => [
      {
        name: 'bad_tool',
        description: 'Bad schema',
        inputSchema: {
          type: 'object',
          properties: {
            'bad key': { type: 'string' },
          },
        },
      } as Tool,
    ];

    const result = await validateMcpConnection({
      mcpUrl: 'https://mcp.example.com/',
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('invalid-schema');
    expect(result.invalidProperties).toEqual([
      {
        toolName: 'bad_tool',
        propertyPath: 'bad key',
        propertyKey: 'bad key',
      },
    ]);
    expect(result.tools).toEqual(['bad_tool']);
  });
});
