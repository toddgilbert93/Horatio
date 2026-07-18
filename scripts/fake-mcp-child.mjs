#!/usr/bin/env node
// Fake MCP server for tap testing. node builtins only, NDJSON on stdio.
// Behaviors:
//  - initialize / tools/list: canned responses
//  - tools/call get_viewport_screenshot: returns a base64 1x1 PNG content item
//  - tools/call anything else: echoes params back as text content
//  - tools/call trigger_error: returns isError result AND prints a fake
//    Python traceback to stderr
//  - tools/call trigger_garbage: emits a deliberately corrupt non-JSON line
//    on stdout before the real response
import * as readline from 'node:readline';

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-child', version: '0.0.1' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
          { name: 'get_viewport_screenshot', description: 'shot', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const tool = params?.name;
    if (tool === 'get_viewport_screenshot') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: 'Screenshot captured' },
            { type: 'image', data: PNG_1PX, mimeType: 'image/png' },
          ],
        },
      });
      return;
    }
    if (tool === 'trigger_error') {
      process.stderr.write(
        'Traceback (most recent call last):\n  File "addon.py", line 42, in execute\n' +
          "KeyError: 'Tree.001'\n"
      );
      send({
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: "KeyError: 'Tree.001'" }] },
      });
      return;
    }
    if (tool === 'trigger_garbage') {
      process.stdout.write('THIS IS NOT JSON {{{\n');
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'garbage emitted' }] },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `echo: ${JSON.stringify(params?.arguments ?? {})}` }] },
    });
    return;
  }
  if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
