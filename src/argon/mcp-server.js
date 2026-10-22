#!/usr/bin/env node
/**
 * JIGIT Memory MCP Server
 * Standard JSON-RPC 2.0 stdio Model Context Protocol (MCP) server for Antigravity IDE.
 * Allows autonomous agents to inspect and restore full content of JIGIT-compressed capsules.
 */

const readline = require('readline');
const { getCapsule, listCapsules, searchCapsules } = require('./capsule-store');

const SERVER_NAME = 'jigit-memory';
const SERVER_VERSION = '1.0.0';

const TOOLS = [
  {
    name: 'jigit_restore_capsule',
    description: 'Restore the complete, untruncated content of a JIGIT capsule (e.g. truncated stack trace, long tool output, or compacted file) by its capsule ID.',
    inputSchema: {
      type: 'object',
      properties: {
        capsule_id: {
          type: 'string',
          description: "The unique capsule identifier, e.g. 'jigit-a1b2c3d4e5'",
        },
      },
      required: ['capsule_id'],
    },
  },
  {
    name: 'jigit_list_capsules',
    description: 'List recently saved JIGIT capsules with previews and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of capsules to return (default 10)',
        },
      },
    },
  },
  {
    name: 'jigit_search_memory',
    description: 'Search through all compressed JIGIT capsules for specific strings, file paths, or error messages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
      },
      required: ['query'],
    },
  },
];

function sendResponse(id, result) {
  const payload = {
    jsonrpc: '2.0',
    id,
    result,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sendError(id, code, message) {
  const payload = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
  }

  if (method === 'notifications/initialized') {
    // Client notification, no reply needed
    return;
  }

  if (method === 'tools/list') {
    return sendResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'jigit_restore_capsule') {
      const capsuleId = args.capsule_id;
      const data = getCapsule(capsuleId);
      if (!data) {
        return sendResponse(id, {
          content: [
            {
              type: 'text',
              text: `[JIGIT MCP] Capsule '${capsuleId}' not found in local memory store. It may have expired or not been saved.`,
            },
          ],
          isError: true,
        });
      }
      return sendResponse(id, {
        content: [
          {
            type: 'text',
            text: `=== Restored Capsule: ${data.id} (${data.category || 'General'}, ${data.length} bytes) ===\n${data.content}`,
          },
        ],
      });
    }

    if (toolName === 'jigit_list_capsules') {
      const limit = Number(args.limit) || 10;
      const items = listCapsules(limit);
      return sendResponse(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(items, null, 2),
          },
        ],
      });
    }

    if (toolName === 'jigit_search_memory') {
      const query = args.query;
      const results = searchCapsules(query);
      return sendResponse(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      });
    }

    return sendError(id, -32601, `Unknown tool: ${toolName}`);
  }

  if (method === 'ping') {
    return sendResponse(id, {});
  }

  return sendError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req = JSON.parse(trimmed);
    handleRequest(req);
  } catch (err) {
    // Malformed JSON-RPC
  }
});
