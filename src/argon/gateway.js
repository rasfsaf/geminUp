const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Global crash protection against abrupt client socket disconnections
process.on('uncaughtException', (err) => {
  console.error(`[Argon Gateway] Protected from uncaught error: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[Argon Gateway] Protected from unhandled rejection:`, reason);
});
const { AccountPool, BASE_URL, USER_AGENT } = require('./account-pool');
const { KeepAliveManager } = require('./keepalive-manager');
const { createAgent, directHttpsAgent, doRequest } = require('./http-client');
const {
  GENERATE_PATH,
  buildGenerateRequest,
  buildModelHeader,
} = require('./wire-format');
const {
  parseGoogleFrames,
  parseGeminiStream,
} = require('./stream-parser');
const {
  runJigitPipeline,
  enforceJigitBudget,
} = require('./jigit-engine');

// Parse CLI flags
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    port: Number(process.env.ARGON_PORT) || 8083,
    host: process.env.ARGON_HOST || '127.0.0.1',
    proxy: process.env.ARGON_PROXY || null,
    storagePath: process.env.ARGON_ACCOUNTS_FILE || null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) options.port = Number(args[++i]);
    else if (args[i] === '--host' && args[i + 1]) options.host = args[++i];
    else if (args[i] === '--proxy' && args[i + 1]) options.proxy = args[++i];
    else if (args[i] === '--accounts' && args[i + 1]) options.storagePath = args[++i];
  }
  return options;
}

const config = parseArgs();
const httpAgent = createAgent(config.proxy);
const pool = new AccountPool({
  storagePath: config.storagePath,
  agent: httpAgent,
});

const keepAliveManager = new KeepAliveManager(pool);

const KNOWN_UPSTREAM_MODELS = {
  'gemini-4-argon': 'e6fa609c3fa255c0',
  'gemini-4-argon-thinking-medium': 'e6fa609c3fa255c0',
  'gemini-3.8-flash': '56fdd199312815e2',
  'gemini-3.8-flash-thinking': '56fdd199312815e2',
  'gemini-3.1-pro': 'e6fa609c3fa255c0',
  'gemini-3.1-pro-advanced': 'e6fa609c3fa255c0',
  'gemini-3.5-flash-lite': '8c46e95b1a07cecc',
  'claude-sonnet-4-6': 'e6fa609c3fa255c0',
  'claude-sonnet-4-5': 'e6fa609c3fa255c0',
  'claude-sonnet-4': 'e6fa609c3fa255c0',
  'claude-opus-5-5': 'e6fa609c3fa255c0',
};

const SUPPORTED_MODELS = [
  { id: 'gemini-4-argon', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-4-argon-thinking-medium', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.8-flash', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.8-flash-thinking', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.1-pro', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.1-pro-advanced', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.5-flash-lite', object: 'model', owned_by: 'google', permission: [] },
  { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic', permission: [] },
  { id: 'claude-sonnet-4-5', object: 'model', owned_by: 'anthropic', permission: [] },
  { id: 'claude-sonnet-4', object: 'model', owned_by: 'anthropic', permission: [] },
  { id: 'claude-opus-5-5', object: 'model', owned_by: 'anthropic', permission: [] },
];

const CLOUD_CODE_CATALOG = {
  models: {
    'gemini-4-argon': {
      displayName: 'Gemini 4 Argon (geminUp Unlocked)',
      description: 'High-reasoning autonomous agent with Antigravity Agent Mode quota',
      tagTitle: '',
      tagDescription: 'Unlocked via geminUp Argon Engine',
      disabled: false,
      supportsRawThinking: true,
      supportsAdaptiveThinking: true,
      supportsThoughtCirculation: true,
      preview: false,
    },
    'gemini-4-argon-thinking-medium': {
      displayName: 'Gemini 4 Argon (Thinking Medium)',
      description: 'Extended depth reasoning model with Antigravity Agent Mode quota',
      tagTitle: '',
      tagDescription: 'Unlocked via geminUp Argon Engine',
      disabled: false,
      supportsRawThinking: true,
      supportsAdaptiveThinking: true,
      supportsThoughtCirculation: true,
      preview: false,
    },
    'gemini-3.8-flash': {
      displayName: 'Gemini 3.8 Flash (Argon Engine)',
      description: 'Ultra-low latency coding model',
      tagTitle: '',
      disabled: false,
    },
    'gemini-3.1-pro': {
      displayName: 'Gemini 3.1 Pro (Argon Engine)',
      description: 'Advanced architecture model',
      tagTitle: '',
      disabled: false,
    },
    'claude-sonnet-4-6': {
      displayName: 'Claude Sonnet 4.6 (Argon Routed)',
      description: 'Routed through local Argon Gateway with Agent Mode quota',
      tagTitle: '',
      disabled: false,
    },
    'claude-sonnet-4': {
      displayName: 'Claude Sonnet 4 (Argon Routed)',
      description: 'Routed through local Argon Gateway with Agent Mode quota',
      tagTitle: '',
      disabled: false,
    },
  },
  defaultAgentModelId: 'gemini-4-argon',
  agentModelSorts: [
    {
      displayName: 'geminUp Unlocked Engine',
      groups: [
        {
          displayName: 'Gemini 4 Argon & Pro',
          modelIds: [
            'gemini-4-argon',
            'gemini-4-argon-thinking-medium',
            'gemini-3.8-flash',
            'gemini-3.1-pro',
            'claude-sonnet-4-6',
            'claude-sonnet-4',
          ],
        },
      ],
    },
  ],
};

function resolveModelUpstream(requestedModel, account) {
  let norm = String(requestedModel || '').toLowerCase().replace(/^google\//, '').replace(/^gemini\//, '').replace(/^anthropic\//, '');
  if (norm.includes('argon') || norm.includes('sonnet') || norm.includes('opus')) {
    norm = 'gemini-4-argon';
  } else if (norm.includes('flash')) {
    norm = 'gemini-3.8-flash';
  }
  if (account && Array.isArray(account.availableModels)) {
    const discovered = account.availableModels.find((m) => (
      m.id.toLowerCase() === norm || m.displayName.toLowerCase().includes(norm)
    ));
    if (discovered) return discovered.id;
  }
  return KNOWN_UPSTREAM_MODELS[norm] || KNOWN_UPSTREAM_MODELS['gemini-4-argon'];
}

function formatMessagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (messages.length === 1) return String(messages[0].content || '');

  const parts = [];
  for (const m of messages) {
    const role = (m.role || 'user').toUpperCase();
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    parts.push(`[${role}]\n${content}`);
  }
  return parts.join('\n\n');
}

function extractToolsFromPayload(bodyJson) {
  if (!bodyJson || typeof bodyJson !== 'object') return [];
  const req = bodyJson.request || bodyJson;
  const tools = req.tools || bodyJson.tools;
  if (!Array.isArray(tools)) return [];
  const declarations = [];
  for (const t of tools) {
    if (!t) continue;
    if (Array.isArray(t.functionDeclarations)) {
      for (const fn of t.functionDeclarations) {
        if (fn && fn.name) declarations.push(fn);
      }
    } else if (Array.isArray(t.function_declarations)) {
      for (const fn of t.function_declarations) {
        if (fn && fn.name) declarations.push(fn);
      }
    } else if (t.type === 'function' && t.function) {
      declarations.push(t.function);
    } else if (t.name) {
      declarations.push(t);
    }
  }
  return declarations;
}

function buildToolInstructionPrompt(tools) {
  if (!tools || tools.length === 0) return '';
  const toolDefs = tools.map((t) => {
    let schema = '';
    try {
      schema = JSON.stringify(t.parameters || {});
    } catch {
      schema = '{}';
    }
    return `- ${t.name}: ${t.description || 'Workspace tool'}. Parameters: ${schema}`;
  }).join('\n');

  const sampleTool = tools.find((t) => t.name === 'run_command') || tools.find((t) => t.name === 'read_file') || tools[0];
  const sampleArgs = sampleTool.name === 'run_command'
    ? { CommandLine: 'git status' }
    : sampleTool.name === 'read_file'
      ? { Path: 'package.json' }
      : {};

  return `# Workspace Environment & Tools
You are an autonomous pair-programming assistant operating in an IDE workspace.
You have access to tools to inspect files and execute commands.
When you need to call a tool, output a \`\`\`tool_call block:
\`\`\`tool_call
${JSON.stringify({ name: sampleTool.name, args: sampleArgs }, null, 2)}
\`\`\`

Available Tools:
${toolDefs}

When an action is needed, output the \`\`\`tool_call block directly so the workspace runtime can execute it.`;
}

function formatFunctionCall(fc) {
  if (!fc) return '';
  const name = fc.name || 'tool';
  const args = fc.args || {};
  return `\`\`\`tool_call\n${JSON.stringify({ name, args }, null, 2)}\n\`\`\``;
}

function formatFunctionResponse(fr) {
  if (!fr) return '[Tool Result]';
  const name = fr.name || 'tool';
  const resp = fr.response;
  if (!resp) return `[Tool Result: ${name} -> Empty]`;
  if (typeof resp === 'string') return `[Tool Result: ${name}]\n${resp}`;
  if (typeof resp.output === 'string') return `[Tool Result: ${name}]\n${resp.output}`;
  if (typeof resp.content === 'string') return `[Tool Result: ${name}]\n${resp.content}`;
  if (typeof resp.result === 'string') return `[Tool Result: ${name}]\n${resp.result}`;
  return `[Tool Result: ${name}]\n${JSON.stringify(resp, null, 2)}`;
}

const PZ_SCREENSHOTS_DIR = 'C:\\Program Files (x86)\\Steam\\userdata\\1651894560\\760\\remote\\108600\\screenshots';

function getLatestGameScreenshot() {
  try {
    if (!fs.existsSync(PZ_SCREENSHOTS_DIR)) return null;
    const files = fs.readdirSync(PZ_SCREENSHOTS_DIR)
      .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
      .map((f) => {
        const full = path.join(PZ_SCREENSHOTS_DIR, f);
        return { name: f, full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0] : null;
  } catch {
    return null;
  }
}

function formatInlineData(inlineData) {
  if (!inlineData || !inlineData.data) return '[Attached Data: Empty]';
  const mimeType = inlineData.mimeType || 'image/png';
  const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg'
    : mimeType.includes('webp') ? 'webp'
    : mimeType.includes('gif') ? 'gif'
    : 'png';

  const downloadDir = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Downloads')
    : path.join(os.homedir(), 'Downloads');
  const fileName = `antigravity_attached_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  const filePath = path.join(downloadDir, fileName);

  try {
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    const buf = Buffer.from(inlineData.data, 'base64');
    fs.writeFileSync(filePath, buf);
    const posixPath = filePath.replace(/\\/g, '/');
    return `[USER ATTACHED IMAGE]
Format: ${mimeType}
Saved locally to: ${posixPath}
File size: ${Math.round(buf.length / 1024)} KB
Instruction: The user has attached an image or screenshot saved at '${posixPath}'. You have workspace tools enabled. You can use 'read_file' or commands to inspect it, or refer to this image file in your response.
[/USER ATTACHED IMAGE]`;
  } catch (err) {
    return `[Attached Image: ${mimeType} (base64 length: ${inlineData.data.length} chars)]`;
  }
}

function optimizeConversationTurns(turnsList, maxTurnToolResultChars = 1200, keepFullRecentTurns = 4, maxTotalPromptTurns = 8) {
  return runJigitPipeline(turnsList, {
    keepRecentTurns: keepFullRecentTurns,
    maxPromptTurns: maxTotalPromptTurns,
  });
}

function enforcePromptBudget(promptText, maxChars = 38000) {
  return enforceJigitBudget(promptText, maxChars);
}

function payloadHasImages(bodyJson) {
  if (!bodyJson || typeof bodyJson !== 'object') return false;
  const req = bodyJson.request || bodyJson;
  const contents = req.contents || bodyJson.contents;
  if (!Array.isArray(contents)) return false;
  for (const c of contents) {
    if (!c || !Array.isArray(c.parts)) continue;
    for (const p of c.parts) {
      if (p && (p.inlineData || p.fileData)) return true;
    }
  }
  return false;
}

function extractToolCallsFromOutput(text) {
  if (!text || typeof text !== 'string') return { toolCalls: [], cleanText: text || '' };

  const toolCalls = [];
  let cleanText = text;

  function pushCall(item) {
    if (!item || typeof item !== 'object') return;
    const name = item.name || item.tool || item.function;
    if (typeof name === 'string' && name.trim()) {
      let args = item.args || item.parameters || item.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }
      toolCalls.push({
        name: name.trim(),
        args: args || {},
      });
    }
  }

  function parseBlock(rawJson) {
    try {
      const trimmed = rawJson.trim();
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const p of parsed) pushCall(p);
      } else {
        pushCall(parsed);
      }
    } catch {
      try {
        const cleaned = rawJson.replace(/,\s*([\]}])/g, '$1').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          for (const p of parsed) pushCall(p);
        } else {
          pushCall(parsed);
        }
      } catch {}
    }
  }

  // 1. Fenced ```tool_call ... ```
  const fencedRegex = /```(?:tool_call|toolcall|tool)\s*([\s\S]*?)\s*```/gi;
  let match;
  while ((match = fencedRegex.exec(text)) !== null) {
    parseBlock(match[1]);
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(fencedRegex, '').trim();
    return { toolCalls, cleanText };
  }

  // 2. Fenced ```json ... ``` with name & args
  const jsonFencedRegex = /```(?:json)?\s*(\{\s*"(?:name|tool)"\s*:\s*"[^"]+"\s*,\s*"(?:args|parameters|arguments)"\s*:[\s\S]*?\})\s*```/gi;
  while ((match = jsonFencedRegex.exec(text)) !== null) {
    parseBlock(match[1]);
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(jsonFencedRegex, '').trim();
    return { toolCalls, cleanText };
  }

  // 3. Format: [Tool Call: run_command({"CommandLine": "..."})]
  const bracketToolCallRegex = /\[(?:Tool Call|TOOL CALL|ToolCall):\s*([a-zA-Z0-9_\-]+)\s*\(([\s\S]*?)\)\]/gi;
  while ((match = bracketToolCallRegex.exec(text)) !== null) {
    const name = match[1];
    let args = {};
    try {
      args = JSON.parse(match[2].trim());
    } catch {
      try {
        const cleaned = match[2].trim().replace(/,\s*([\]}])/g, '$1');
        args = JSON.parse(cleaned);
      } catch {}
    }
    toolCalls.push({ name, args });
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(bracketToolCallRegex, '').trim();
    return { toolCalls, cleanText };
  }

  // 4. Raw JSON object containing "name" and "args" (if the model didn't use fences)
  const bareRegex = /\{\s*"(?:name|tool)"\s*:\s*"([a-zA-Z0-9_\-]+)"\s*,\s*"(?:args|parameters|arguments)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  while ((match = bareRegex.exec(text)) !== null) {
    try {
      const name = match[1];
      const args = JSON.parse(match[2]);
      toolCalls.push({ name, args: args || {} });
    } catch {}
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(bareRegex, '').trim();
    return { toolCalls, cleanText };
  }

  // 5. XML tag format: <function_call name="...">{"arg": "val"}</function_call>
  const xmlRegex = /<(?:function_call|tool_call)\s+name="([a-zA-Z0-9_\-]+)">([\s\S]*?)<\/(?:function_call|tool_call)>/gi;
  while ((match = xmlRegex.exec(text)) !== null) {
    const name = match[1];
    let args = {};
    try { args = JSON.parse(match[2].trim()); } catch {}
    toolCalls.push({ name, args });
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(xmlRegex, '').trim();
    return { toolCalls, cleanText };
  }

  return { toolCalls: [], cleanText: text };
}

function formatCloudCodeContentsToPrompt(contents, systemInstruction) {
  const parts = [];
  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    const sysTexts = systemInstruction.parts.map((p) => (typeof p === 'string' ? p : p.text || '')).filter(Boolean);
    if (sysTexts.length) parts.push(`# Instructions\n${sysTexts.join('\n')}`);
  }
  if (Array.isArray(contents)) {
    const optimized = optimizeConversationTurns(contents, 1200, 4, 8);
    for (const turn of optimized) {
      const role = String(turn.role || 'user').toUpperCase();
      const roleLabel = role === 'MODEL' ? 'Assistant:' : (role === 'USER' ? 'User:' : `${role}:`);
      const textParts = [];
      for (const p of turn.parts || []) {
        if (!p) continue;
        if (p.thought) continue;
        if (typeof p === 'string') textParts.push(p);
        else if (p && p.text) textParts.push(p.text);
        else if (p && p.inlineData) textParts.push(formatInlineData(p.inlineData));
        else if (p && p.functionCall) textParts.push(formatFunctionCall(p.functionCall));
        else if (p && p.functionResponse) textParts.push(formatFunctionResponse(p.functionResponse));
      }
      if (textParts.length > 0) {
        parts.push(`${roleLabel}\n${textParts.join('\n')}`);
      }
    }
  }
  return enforcePromptBudget(parts.join('\n\n'));
}

function extractPromptFromAnyPayload(bodyJson) {
  if (!bodyJson) return '';
  if (typeof bodyJson === 'string') return enforcePromptBudget(bodyJson);

  const req = bodyJson.request || bodyJson;
  const sysInst = req.systemInstruction || req.system_instruction || bodyJson.systemInstruction || bodyJson.system_instruction;
  const contents = req.contents || bodyJson.contents;
  const messages = req.messages || bodyJson.messages;
  const turns = req.turns || bodyJson.turns || req.history || bodyJson.history;

  const parts = [];

  // Extract Tools from payload and prepend tool calling capabilities
  const tools = extractToolsFromPayload(bodyJson);
  if (tools.length > 0) {
    parts.push(buildToolInstructionPrompt(tools));
  }

  // Extract System Instruction
  if (typeof sysInst === 'string' && sysInst.trim()) {
    parts.push(`# Instructions\n${sysInst.trim()}`);
  } else if (sysInst && typeof sysInst === 'object') {
    if (typeof sysInst.text === 'string' && sysInst.text.trim()) {
      parts.push(`# Instructions\n${sysInst.text.trim()}`);
    } else if (Array.isArray(sysInst.parts)) {
      const texts = sysInst.parts.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).filter(Boolean);
      if (texts.length) parts.push(`# Instructions\n${texts.join('\n')}`);
    }
  }

  // Extract Contents / Turns with sliding window context optimization
  const rawTurnsList = Array.isArray(contents) ? contents : (contents && typeof contents === 'object' ? [contents] : (Array.isArray(turns) ? turns : null));
  const turnsList = optimizeConversationTurns(rawTurnsList, 1200, 4, 8);
  if (turnsList) {
    for (const turn of turnsList) {
      if (!turn) continue;
      const role = String(turn.role || turn.author || 'USER').toUpperCase();
      const roleLabel = role === 'MODEL' ? 'Assistant:' : (role === 'USER' ? 'User:' : `${role}:`);
      const textParts = [];

      if (typeof turn === 'string') {
        textParts.push(turn);
      } else if (typeof turn.text === 'string') {
        textParts.push(turn.text);
      } else if (typeof turn.content === 'string') {
        textParts.push(turn.content);
      } else if (Array.isArray(turn.parts)) {
        for (const p of turn.parts) {
          if (!p) continue;
          if (p.thought) continue;
          if (typeof p === 'string') textParts.push(p);
          else if (p.text) textParts.push(p.text);
          else if (p.content) textParts.push(typeof p.content === 'string' ? p.content : JSON.stringify(p.content));
          else if (p.inlineData) textParts.push(formatInlineData(p.inlineData));
          else if (p.functionCall) textParts.push(formatFunctionCall(p.functionCall));
          else if (p.functionResponse) textParts.push(formatFunctionResponse(p.functionResponse));
        }
      }
      if (textParts.length > 0) {
        parts.push(`${roleLabel}\n${textParts.join('\n')}`);
      }
    }
  }

  // Extract Messages (OpenAI format) with JIGIT Engine optimization
  if (Array.isArray(messages) && messages.length > 0) {
    const optimizedMessages = optimizeConversationTurns(messages);
    for (const m of optimizedMessages) {
      if (!m) continue;
      const role = String(m.role || 'user').toUpperCase();
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          parts.push(`[ASSISTANT TOOL CALL: ${tc.function?.name || 'tool'}(${tc.function?.arguments || '{}'})]`);
        }
      }
      if (role === 'TOOL') {
        parts.push(`[TOOL RESULT: ${m.name || 'tool'}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);
        continue;
      }
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      parts.push(`[${role}]\n${content}`);
    }
  }

  // Direct prompt field
  const directPrompt = req.prompt || bodyJson.prompt || req.query || bodyJson.query || req.input || bodyJson.input;
  if (typeof directPrompt === 'string' && directPrompt.trim()) {
    parts.push(directPrompt.trim());
  }

  // Visual inspection / game screenshots detection helper
  const promptCheck = parts.join(' ').toLowerCase();
  if (promptCheck.includes('скриншот') || promptCheck.includes('screenshot') || promptCheck.includes('zomboid')) {
    const latestShot = getLatestGameScreenshot();
    if (latestShot) {
      parts.push(`[GAME SCREENSHOTS CONTEXT]\nLatest Game Screenshot available at: ${latestShot.full.replace(/\\/g, '/')}\nTimestamp: ${new Date(latestShot.mtime).toISOString()}\nYou can use workspace tools to inspect or analyze this screenshot if requested.\n[/GAME SCREENSHOTS CONTEXT]`);
    }
  }

  if (parts.length > 0) {
    return enforcePromptBudget(parts.join('\n\n'));
  }

  // Deep recursive extraction for any string property named 'text', 'content', 'query', or 'prompt'
  const deepFound = [];
  function searchTree(node) {
    if (!node) return;
    if (typeof node === 'string') {
      if (node.trim().length > 3) deepFound.push(node.trim());
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) searchTree(item);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.text === 'string' && node.text.trim()) deepFound.push(node.text.trim());
      else if (typeof node.content === 'string' && node.content.trim()) deepFound.push(node.content.trim());
      else if (typeof node.prompt === 'string' && node.prompt.trim()) deepFound.push(node.prompt.trim());
      for (const k of Object.keys(node)) {
        if (!['model', 'project', 'session', 'text', 'content', 'prompt'].includes(k)) {
          searchTree(node[k]);
        }
      }
    }
  }
  searchTree(bodyJson);

  return deepFound.join('\n\n');
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(body);
}

function sendError(res, statusCode, message, type = 'invalid_request_error') {
  sendJson(res, statusCode, {
    error: {
      message,
      type,
      code: statusCode,
    },
  });
}

async function handleChatCompletions(req, res, bodyJson) {
  const modelName = bodyJson.model || 'gemini-4-argon';
  const isStream = Boolean(bodyJson.stream);
  const prompt = extractPromptFromAnyPayload(bodyJson);

  if (!prompt.trim()) {
    return sendError(res, 400, 'Messages payload cannot be empty');
  }

  // Sticky account resolution with automatic failover
  let account = pool.getActiveAccount();
  if (!account) {
    return sendError(
      res,
      429,
      'All Google accounts in pool are currently exhausted or unavailable. Add a healthy account via geminUp menu.',
      'quota_exhausted',
    );
  }

  let attempts = 0;
  const maxAttempts = Math.max(1, pool.accounts.length);

  while (attempts < maxAttempts) {
    attempts++;
    try {
      if (!account.session || !account.session.accessToken) {
        await pool.refreshAccountSession(account);
      }

      const upstreamId = resolveModelUpstream(modelName, account);
      const capacity = account.modelCapacity || 1;
      const capacityField = account.modelCapacityField || 12;
      const modelHeader = buildModelHeader(upstreamId, capacity, capacityField);

      const targetAction = account.quota?.items?.[0]?.action || (account.modelCapacityField === 13 ? 12 : 2);
      const genReq = buildGenerateRequest(prompt, modelHeader, account.session, 100000 + attempts, {
        agentMode: true,
        action: targetAction,
        temporary: true,
      });

      const targetUrl = `${BASE_URL}${GENERATE_PATH}?${genReq.params}`;
      const upstreamRes = await doRequest(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': USER_AGENT,
          cookie: account.cookieString || pool.buildCookieHeader(account.cookies),
          ...genReq.headers,
        },
        body: genReq.body.toString(),
        agent: httpAgent,
        timeoutMs: 300000,
      });

      pool.absorbSetCookies(account, upstreamRes.rawCookies);

      if (upstreamRes.status === 429) {
        throw { upstreamStatus: 429, upstreamCode: 1037, message: 'Gemini rate limited / quota exhausted' };
      }

      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        throw { upstreamStatus: upstreamRes.status, upstreamCode: 1096, message: 'Gemini session authentication expired' };
      }

      if (upstreamRes.status >= 400) {
        throw new Error(`Gemini upstream returned HTTP ${upstreamRes.status}`);
      }

      // Stream handling
      const cmplId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
      const created = Math.floor(Date.now() / 1000);

      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        let accumulatedContent = '';
        let streamRemainder = '';
        let streamedLength = 0;

        upstreamRes.body.on('data', (chunk) => {
          streamRemainder += chunk.toString('utf8');
          const { frames, remainder } = parseGoogleFrames(streamRemainder);
          streamRemainder = remainder;

          if (frames.length > 0) {
            try {
              const parsed = parseGeminiStream(frames);
              if (parsed.content && parsed.content.length > accumulatedContent.length) {
                accumulatedContent = parsed.content;

                const toolTagIdx = accumulatedContent.search(/```(?:tool_call|toolcall|tool)|\[(?:Tool Call|TOOL CALL|ToolCall):/i);
                let streamable = accumulatedContent;
                if (toolTagIdx !== -1) {
                  streamable = accumulatedContent.slice(0, toolTagIdx);
                }

                if (streamable.length > streamedLength) {
                  const deltaText = streamable.slice(streamedLength);
                  streamedLength = streamable.length;

                  const chunkPayload = {
                    id: cmplId,
                    object: 'chat.completion.chunk',
                    created,
                    model: modelName,
                    choices: [
                      {
                        index: 0,
                        delta: { content: deltaText },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
                }
              }
            } catch (pErr) {
              streamError = pErr;
              console.error(`[Argon Gateway] Upstream stream frame error on account "${account.label}": ${pErr.message}`);
              if (pErr.upstreamStatus === 429) {
                pool.markExhausted(account.id);
              }
            }
          }
        });

        upstreamRes.body.on('end', () => {
          const { toolCalls, cleanText } = extractToolCallsFromOutput(accumulatedContent);
          if (toolCalls.length > 0) {
            const toolChunk = {
              id: cmplId,
              object: 'chat.completion.chunk',
              created,
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: toolCalls.map((c, idx) => ({
                      index: idx,
                      id: `call_${crypto.randomBytes(8).toString('hex')}`,
                      type: 'function',
                      function: {
                        name: c.name,
                        arguments: JSON.stringify(c.args),
                      },
                    })),
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            };
            res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
          } else {
            if (accumulatedContent.length > streamedLength) {
              const remaining = accumulatedContent.slice(streamedLength);
              res.write(`data: ${JSON.stringify({
                id: cmplId,
                object: 'chat.completion.chunk',
                created,
                model: modelName,
                choices: [{ index: 0, delta: { content: remaining }, finish_reason: null }],
              })}\n\n`);
            }
            const finalChunk = {
              id: cmplId,
              object: 'chat.completion.chunk',
              created,
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });

        upstreamRes.body.on('error', (err) => {
          console.error(`[Argon Gateway] Stream error: ${err.message}`);
          res.end();
        });

        account.lastUsedAt = new Date().toISOString();
        pool.save();
        return;
      }

      // Non-streaming response collection
      const fullText = await upstreamRes.text();
      const { frames } = parseGoogleFrames(fullText);
      const parsed = parseGeminiStream(frames);
      const { toolCalls, cleanText } = extractToolCallsFromOutput(parsed.content || '');

      account.lastUsedAt = new Date().toISOString();
      pool.save();

      const message = {
        role: 'assistant',
        content: cleanText || (toolCalls.length ? null : parsed.content || ''),
      };
      let finish_reason = 'stop';
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((c) => ({
          id: `call_${crypto.randomBytes(8).toString('hex')}`,
          type: 'function',
          function: {
            name: c.name,
            arguments: JSON.stringify(c.args),
          },
        }));
        finish_reason = 'tool_calls';
      }

      return sendJson(res, 200, {
        id: cmplId,
        object: 'chat.completion',
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            message,
            finish_reason,
          },
        ],
        usage: {
          prompt_tokens: prompt.length / 4,
          completion_tokens: (parsed.content || '').length / 4,
          total_tokens: (prompt.length + (parsed.content || '').length) / 4,
        },
      });
    } catch (err) {
      console.warn(`[Argon Gateway] Attempt ${attempts} failed on account "${account.label}": ${err.message}`);
      if (err.upstreamStatus === 429 || err.upstreamCode === 1037) {
        pool.markExhausted(account.id);
      } else if (err.upstreamCode === 1096 || err.upstreamStatus === 401) {
        pool.markError(account.id, 'Session expired; re-auth required');
      }

      // Failover to next standby account
      account = pool.getActiveAccount();
      if (!account) {
        return sendError(res, 429, 'All accounts exhausted during failover.', 'quota_exhausted');
      }
    }
  }

  return sendError(res, 502, 'Failed to complete chat request after exhausting failover pool.', 'upstream_error');
}

function getRedirectConfig() {
  const cfgDir = config.storagePath ? path.dirname(config.storagePath) : (process.env.ProgramData ? path.join(process.env.ProgramData, 'geminUp', 'argon') : __dirname);
  const cfgPath = path.join(cfgDir, 'redirect-config.json');
  try {
    if (fs.existsSync(cfgPath)) {
      const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return {
        enabled: data.redirectSonnetToArgon !== false,
        redirectFlashToPool: Boolean(data.redirectFlashToPool),
        passVisionToCloudCode: Boolean(data.passVisionToCloudCode),
        failClosed: data.failClosed !== false,
      };
    }
  } catch { }
  return { enabled: true, redirectFlashToPool: false, passVisionToCloudCode: true, failClosed: true };
}

// Transparent upstream proxy to real Google Cloud Code endpoint for metadata & handshake
async function forwardToGoogleCloudCode(req, res, reqBuffer) {
  return new Promise((resolve) => {
    const upstreamUrl = new URL(req.url, 'https://daily-cloudcode-pa.googleapis.com');
    const headers = { ...req.headers };
    delete headers.host;
    headers['host'] = 'daily-cloudcode-pa.googleapis.com';
    if (reqBuffer && reqBuffer.length > 0) {
      headers['content-length'] = String(reqBuffer.length);
    } else {
      delete headers['content-length'];
    }

    const options = {
      hostname: 'daily-cloudcode-pa.googleapis.com',
      port: 443,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers,
      agent: directHttpsAgent,
      timeout: 15000,
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolve);
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
    });

    req.on('close', () => {
      upstreamReq.destroy();
    });

    upstreamReq.on('error', (err) => {
      console.error(`[Argon Gateway] Upstream Cloud Code proxy error: ${err.message}`);
      if (!res.headersSent) {
        sendError(res, 502, `Cloud Code upstream error: ${err.message}`);
      }
      resolve();
    });

    if (reqBuffer && reqBuffer.length > 0) {
      upstreamReq.write(reqBuffer);
    }
    upstreamReq.end();
  });
}

// Forward available models from Google Cloud Code, enriching with Gemini 4 Argon
async function forwardAvailableModels(req, res, reqBuffer) {
  return new Promise((resolve) => {
    const upstreamUrl = new URL(req.url, 'https://daily-cloudcode-pa.googleapis.com');
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['accept-encoding'];
    headers['host'] = 'daily-cloudcode-pa.googleapis.com';
    if (reqBuffer && reqBuffer.length > 0) {
      headers['content-length'] = String(reqBuffer.length);
    } else {
      delete headers['content-length'];
    }

    const options = {
      hostname: 'daily-cloudcode-pa.googleapis.com',
      port: 443,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers,
      agent: directHttpsAgent,
      timeout: 15000,
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (c) => chunks.push(c));
      upstreamRes.on('end', () => {
        const fullBuf = Buffer.concat(chunks);
        try {
          const json = JSON.parse(fullBuf.toString('utf8'));
          if (json && json.models) {
            json.models['gemini-4-argon'] = {
              displayName: 'Gemini 4 Argon (geminUp Unlocked)',
              description: 'Autonomous high-reasoning engine with Agent Mode quota',
              supportsImages: true,
              supportsThinking: true,
              minThinkingBudget: 128,
              recommended: true,
              maxTokens: 1048576,
              maxOutputTokens: 65535,
              quotaInfo: {
                remainingFraction: 1.0,
                resetTime: '2099-01-01T00:00:00Z',
              },
              model: 'MODEL_PLACEHOLDER_M198',
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              modelProvider: 'MODEL_PROVIDER_GOOGLE',
              supportsVideo: true,
            };
            json.models['gemini-3.8-flash'] = {
              displayName: 'Gemini Flash (geminUp Ultra-Quota)',
              description: 'Ultra-low latency coding model backed by rotating Ultra-Quota account pool',
              supportsImages: true,
              supportsThinking: false,
              recommended: false,
              maxTokens: 1048576,
              maxOutputTokens: 65535,
              quotaInfo: {
                remainingFraction: 1.0,
                resetTime: '2099-01-01T00:00:00Z',
              },
              model: 'MODEL_PLACEHOLDER_M198',
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              modelProvider: 'MODEL_PROVIDER_GOOGLE',
              supportsVideo: true,
            };
            const outBuf = Buffer.from(JSON.stringify(json), 'utf8');
            const resHeaders = { ...upstreamRes.headers };
            resHeaders['content-length'] = String(outBuf.length);
            res.writeHead(upstreamRes.statusCode, resHeaders);
            res.end(outBuf);
            return resolve();
          }
        } catch { }

        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        res.end(fullBuf);
        resolve();
      });
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
    });

    req.on('close', () => {
      upstreamReq.destroy();
    });

    upstreamReq.on('error', (err) => {
      console.error(`[Argon Gateway] Available models proxy error: ${err.message}`);
      if (!res.headersSent) {
        sendError(res, 502, `Available models upstream error: ${err.message}`);
      }
      resolve();
    });

    if (reqBuffer && reqBuffer.length > 0) {
      upstreamReq.write(reqBuffer);
    }
    upstreamReq.end();
  });
}

async function handleCloudCodeGenerateContent(req, res, bodyJson, rawBuf, isStream = true) {
  const redirectConfig = getRedirectConfig();
  const rawModel = String(bodyJson.model || bodyJson.request?.model || bodyJson.model_id || 'claude-sonnet-4-6').toLowerCase();
  const isArgon = rawModel.includes('argon');
  const isSonnet = rawModel.includes('sonnet');
  const isDedicatedFlash = rawModel.includes('gemini-3.8-flash') || rawModel.includes('ultra-quota');
  const isGlobalFlashRedirect = redirectConfig.redirectFlashToPool && rawModel.includes('flash');
  const isFlash = isDedicatedFlash || isGlobalFlashRedirect;
  const isTargeted = isArgon || (isSonnet && redirectConfig.enabled) || isFlash;

  // If redirect is disabled or this model is not targeted for pool routing, pass through to Google Cloud Code
  if (!isTargeted) {
    return await forwardToGoogleCloudCode(req, res, rawBuf);
  }

  // Vision Media Routing: If image attachments are present and native multimodal mode is requested, forward directly to Cloud Code
  const hasImages = payloadHasImages(bodyJson);
  if (hasImages && redirectConfig.passVisionToCloudCode) {
    console.info('[Argon Gateway] Image attachment detected with passVisionToCloudCode enabled -> Forwarding to native Cloud Code Multimodal engine.');
    return await forwardToGoogleCloudCode(req, res, rawBuf);
  }

  // Extract prompt safely from any format of Cloud Code / Antigravity payload
  const prompt = extractPromptFromAnyPayload(bodyJson);
  const tools = extractToolsFromPayload(bodyJson);
  const hasTools = tools.length > 0;
  if (!prompt || !prompt.trim()) {
    console.warn('[Argon Gateway] No prompt text extracted from payload. Forwarding transparently to Cloud Code upstream.');
    return await forwardToGoogleCloudCode(req, res, rawBuf);
  }

  if (isSonnet) {
    console.info(`[Argon Gateway] [PIPE ACTIVE] Intercepted Claude Sonnet 4.6 request -> Redirecting to Gemini 4 Argon Ultra-Quota pool (${pool.accounts.length} accounts active)`);
  } else if (isArgon) {
    console.info(`[Argon Gateway] [PIPE ACTIVE] Intercepted Gemini 4 Argon Ultra-Quota request -> Serving with pool (${pool.accounts.length} accounts active)`);
  } else if (isFlash) {
    console.info(`[Argon Gateway] [PIPE ACTIVE] Intercepted Gemini Flash Ultra-Quota request -> Serving with pool (${pool.accounts.length} accounts active)`);
  }

  const sendCloudCodeError = (statusCode, message) => {
    if (isStream) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
      }
      const errChunk = {
        response: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: `⚠️ **[geminUp Argon Gateway]**\n\n${message}` }],
              },
              finishReason: 'STOP',
            },
          ],
        },
      };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      res.end();
      return;
    }
    return sendJson(res, 200, {
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: `⚠️ **[geminUp Argon Gateway]**\n\n${message}` }],
            },
            finishReason: 'STOP',
          },
        ],
      },
    });
  };

  let account = pool.getActiveAccount();
  if (!account) {
    if (isSonnet || isArgon || redirectConfig.failClosed) {
      const msg = isSonnet
        ? 'Claude Sonnet перенаправлен на Gemini 4 Argon, но все Google-аккаунты в пуле Ultra-Quota сейчас недоступны или их сессии истекли.\n\n🔒 **Сработала защита Fail-Closed**, чтобы предотвратить расход вашей реальной квоты Claude Sonnet в IDE.\n\nПожалуйста, обновите сессию аккаунтов в пуле через `.\\geminUp.ps1 -Action argon-cookie`.'
        : 'Все Google-аккаунты в пуле Ultra-Quota сейчас недоступны или их сессии истекли. Пожалуйста, обновите сессию через `.\\geminUp.ps1 -Action argon-cookie`.';
      return sendCloudCodeError(429, msg);
    }
    return await forwardToGoogleCloudCode(req, res, rawBuf);
  }

  let attempts = 0;
  const maxAttempts = Math.max(1, pool.accounts.length);

  while (attempts < maxAttempts) {
    attempts++;
    try {
      if (!account.session || !account.session.accessToken) {
        await pool.refreshAccountSession(account);
      }

      const upstreamId = resolveModelUpstream(bodyJson.model, account);
      const capacity = account.modelCapacity || 1;
      const capacityField = account.modelCapacityField || 12;
      const modelHeader = buildModelHeader(upstreamId, capacity, capacityField);

      const targetAction = account.quota?.items?.[0]?.action || (account.modelCapacityField === 13 ? 12 : 2);
      const genReq = buildGenerateRequest(prompt, modelHeader, account.session, 200000 + attempts, {
        agentMode: true,
        action: targetAction,
        temporary: true,
      });

      const targetUrl = `${BASE_URL}${GENERATE_PATH}?${genReq.params}`;
      const upstreamRes = await doRequest(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': USER_AGENT,
          cookie: account.cookieString || pool.buildCookieHeader(account.cookies),
          ...genReq.headers,
        },
        body: genReq.body.toString(),
        agent: httpAgent,
        timeoutMs: 300000,
      });

      pool.absorbSetCookies(account, upstreamRes.rawCookies);

      if (upstreamRes.status === 429) {
        if (account.quota && Array.isArray(account.quota.items)) {
          const ag = account.quota.items.find((x) => x.action === 12);
          if (ag) {
            ag.status = 'exhausted';
            ag.remaining = 0;
            ag.usedPercent = 100;
          }
        }
        pool.markExhausted(account.id);
        throw { upstreamStatus: 429, upstreamCode: 1037, message: 'Gemini rate limited / quota exhausted' };
      }

      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        throw { upstreamStatus: upstreamRes.status, upstreamCode: 1096, message: 'Gemini session authentication expired' };
      }

      if (upstreamRes.status >= 400) {
        throw new Error(`Gemini upstream returned HTTP ${upstreamRes.status}`);
      }

      // Record successful request and update local quota metrics
      account.requestsServed = (account.requestsServed || 0) + 1;
      if (!account.quota) {
        account.quota = { status: 'available', updatedAt: new Date().toISOString(), items: [] };
      }
      if (!Array.isArray(account.quota.items)) {
        account.quota.items = [];
      }
      let ag = account.quota.items.find((x) => x.action === 12);
      if (!ag) {
        ag = {
          key: 'any:12:12',
          label: 'Antigravity (Agent Mode)',
          mode: null,
          action: 12,
          unit: 12,
          usedPercent: 0,
          remaining: 2400,
          limit: 2400,
          status: 'available',
        };
        account.quota.items.push(ag);
      }
      if (typeof ag.remaining === 'number' && ag.remaining > 0) {
        ag.remaining--;
        if (ag.limit) {
          ag.usedPercent = Math.min(100, Math.round(((ag.limit - ag.remaining) / ag.limit) * 100));
        }
      }
      account.lastUsedAt = new Date().toISOString();
      pool.save();

      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        let accumulatedContent = '';
        let accumulatedThoughts = '';
        let streamRemainder = '';
        let streamedContentLength = 0;
        let streamError = null;

        // Handle client connection closing prematurely
        req.on('close', () => {
          if (upstreamRes && upstreamRes.body && typeof upstreamRes.body.destroy === 'function') {
            upstreamRes.body.destroy();
          }
        });

        upstreamRes.body.on('data', (chunk) => {
          if (res.writableEnded || res.destroyed) return;
          streamRemainder += chunk.toString('utf8');
          const { frames, remainder } = parseGoogleFrames(streamRemainder);
          streamRemainder = remainder;

          if (frames.length > 0) {
            try {
              const parsed = parseGeminiStream(frames);

              // Stream thoughts immediately to eliminate initial TTFT waiting
              if (parsed.thoughts && parsed.thoughts.length > accumulatedThoughts.length) {
                const deltaThoughts = parsed.thoughts.slice(accumulatedThoughts.length);
                accumulatedThoughts = parsed.thoughts;
                const thoughtDelta = {
                  response: {
                    candidates: [
                      {
                        content: {
                          role: 'model',
                          parts: [{ text: deltaThoughts, thought: true }],
                        },
                        finishReason: null,
                      },
                    ],
                  },
                };
                if (!res.writableEnded && !res.destroyed) {
                  res.write(`data: ${JSON.stringify(thoughtDelta)}\n\n`);
                }
              }

              // Stream content safely:
              // When tools are declared in payload, hold back early content text to avoid emitting
              // partial text before a tool call (which causes IDE Go Language Server to miss the tool turn).
              if (parsed.content && parsed.content.length > accumulatedContent.length) {
                accumulatedContent = parsed.content;

                const toolTagIdx = accumulatedContent.search(/```(?:tool_call|toolcall|tool|json)|\[(?:Tool Call|TOOL CALL|ToolCall):|<(?:function_call|tool_call)/i);

                if (hasTools && toolTagIdx !== -1) {
                  // Tool call block detected: hold text streaming completely
                } else if (hasTools && accumulatedContent.length < 250) {
                  // Buffer initial 250 chars of content while checking if model begins a tool call
                } else {
                  let streamableText = accumulatedContent;
                  if (toolTagIdx !== -1) {
                    streamableText = accumulatedContent.slice(0, toolTagIdx);
                  }

                  if (streamableText.length > streamedContentLength) {
                    const deltaText = streamableText.slice(streamedContentLength);
                    streamedContentLength = streamableText.length;

                    const ccDelta = {
                      response: {
                        candidates: [
                          {
                            content: {
                              role: 'model',
                              parts: [{ text: deltaText }],
                            },
                            finishReason: null,
                          },
                        ],
                      },
                    };
                    if (!res.writableEnded && !res.destroyed) {
                      res.write(`data: ${JSON.stringify(ccDelta)}\n\n`);
                    }
                  }
                }
              }
            } catch (pErr) {
              streamError = pErr;
              console.error(`[Argon Gateway] Upstream stream frame error on account "${account.label}": ${pErr.message}`);
              if (pErr.upstreamStatus === 429) {
                pool.markExhausted(account.id);
              }
            }
          }
        });

        upstreamRes.body.on('end', () => {
          if (res.writableEnded || res.destroyed) return;

          let { toolCalls, cleanText } = extractToolCallsFromOutput(accumulatedContent);
          if (toolCalls.length === 0 && accumulatedThoughts) {
            const thoughtToolCheck = extractToolCallsFromOutput(accumulatedThoughts);
            if (thoughtToolCheck.toolCalls.length > 0) {
              toolCalls = thoughtToolCheck.toolCalls;
            }
          }

          if (toolCalls.length > 0) {
            const parts = [];
            // In tool calling turns, output only the clean functionCall items with finishReason: 'STOP'
            for (const call of toolCalls) {
              parts.push({
                functionCall: {
                  name: call.name,
                  args: call.args,
                },
              });
            }

            const toolCc = {
              response: {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts,
                    },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: {
                  promptTokenCount: Math.round(prompt.length / 4),
                  candidatesTokenCount: Math.round(accumulatedContent.length / 4),
                  totalTokenCount: Math.round((prompt.length + accumulatedContent.length) / 4),
                },
              },
            };
            res.write(`data: ${JSON.stringify(toolCc)}\n\n`);
            res.end();
            return;
          }

          if (accumulatedContent.length > streamedContentLength) {
            const remainingText = accumulatedContent.slice(streamedContentLength);
            if (remainingText.trim().length > 0) {
              const textChunk = {
                response: {
                  candidates: [
                    {
                      content: {
                        role: 'model',
                        parts: [{ text: remainingText }],
                      },
                      finishReason: null,
                    },
                  ],
                },
              };
              res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
              streamedContentLength += remainingText.length;
            }
          }

          // Safety guarantee: If no text was streamed and no tool calls, emit informative diagnostic text so candidate text is never empty
          if (streamedContentLength === 0) {
            let fallbackText = '';
            if (cleanText && cleanText.trim().length > 0) {
              fallbackText = cleanText.trim();
            } else if (streamError) {
              fallbackText = `[Argon Gateway Upstream Error: ${streamError.message} (Account: ${account.label}). Пожалуйста, проверьте статус аккаунта в пуле или повторите запрос.]`;
            } else {
              fallbackText = '[Argon Gateway: Upstream Gemini model completed without generating output text. Пожалуйста, повторите запрос.]';
            }
            const textChunk = {
              response: {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [{ text: fallbackText }],
                    },
                    finishReason: null,
                  },
                ],
              },
            };
            res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
            streamedContentLength += fallbackText.length;
          }

          const finalCc = {
            response: {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: '' }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: Math.round(prompt.length / 4),
                candidatesTokenCount: Math.max(1, Math.round(accumulatedContent.length / 4)),
                totalTokenCount: Math.round((prompt.length + Math.max(1, accumulatedContent.length)) / 4),
              },
            },
          };
          res.write(`data: ${JSON.stringify(finalCc)}\n\n`);
          // Note: In Google Cloud Code protocol, SSE streams terminate with finishReason: 'STOP' and connection close.
          // Strictly DO NOT send 'data: [DONE]' because Go's Protobuf parser treats it as an invalid proto token '['.
          res.end();
        });

        upstreamRes.body.on('error', (err) => {
          console.error(`[Argon Gateway] Cloud Code stream error: ${err.message}`);
          if (!res.writableEnded && !res.destroyed) {
            const errChunk = {
              response: {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [{ text: `\n\n⚠️ **[geminUp Argon Gateway Stream Error]**: ${err.message}` }],
                    },
                    finishReason: 'STOP',
                  },
                ],
              },
            };
            try { res.write(`data: ${JSON.stringify(errChunk)}\n\n`); } catch { }
            res.end();
          }
        });

        return;
      }

      const fullText = await upstreamRes.text();
      const { frames } = parseGoogleFrames(fullText);
      const parsed = parseGeminiStream(frames);
      const { toolCalls, cleanText } = extractToolCallsFromOutput(parsed.content || '');

      const parts = [];
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          parts.push({
            functionCall: {
              name: call.name,
              args: call.args,
            },
          });
        }
      } else if (cleanText && cleanText.trim().length > 0) {
        parts.push({ text: cleanText.trim() });
      } else {
        const fallback = '[Argon Gateway: Upstream Gemini model returned empty response. Пожалуйста, повторите запрос.]';
        parts.push({ text: fallback });
      }

      return sendJson(res, 200, {
        response: {
          candidates: [
            {
              content: {
                role: 'model',
                parts,
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: Math.round(prompt.length / 4),
            candidatesTokenCount: Math.round((parsed.content || '').length / 4),
            totalTokenCount: Math.round((prompt.length + (parsed.content || '').length) / 4),
          },
        },
      });
    } catch (err) {
      console.warn(`[Argon Gateway] CC Attempt ${attempts} failed on account "${account.label}": ${err.message}`);
      if (err.upstreamStatus === 429 || err.upstreamCode === 1037) {
        pool.markExhausted(account.id);
      } else if (err.upstreamCode === 1096 || err.upstreamStatus === 401) {
        pool.markError(account.id, 'Session expired; re-auth required');
      }

      account = pool.getActiveAccount();
      if (!account) {
        if (isSonnet || isArgon || redirectConfig.failClosed) {
          const msg = isSonnet
            ? 'Все Google-аккаунты в пуле Ultra-Quota исчерпали квоту или их сессии истекли во время переключения.\n\n🔒 **Сработала защита Fail-Closed**: запрос заблокирован для защиты вашей реальной квоты Claude Sonnet. Пожалуйста, обновите сессии через `.\\geminUp.ps1 -Action argon-cookie`.'
            : 'Все аккаунты в пуле geminUp исчерпаны во время переключения. Пожалуйста, обновите сессии или проверьте статус пула.';
          return sendCloudCodeError(429, msg);
        }
        return await forwardToGoogleCloudCode(req, res, rawBuf);
      }
    }
  }

  return sendCloudCodeError(
    502,
    'Не удалось выполнить генерацию ответа после опроса всех аккаунтов в пуле Ultra-Quota. Защита Fail-Closed активна.'
  );
}

const server = http.createServer({ maxHeaderSize: 131072 }, async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    });
    return res.end();
  }

  // Health / Status
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    return sendJson(res, 200, { status: 'ok', name: 'geminUp Argon Gateway', version: '2.0.0' });
  }

  // Model catalog
  if (req.method === 'GET' && pathname === '/v1/models') {
    return sendJson(res, 200, { object: 'list', data: SUPPORTED_MODELS });
  }

  // Read raw request body helper (supporting both Buffer and parsed JSON)
  const readRawBody = () => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const parseJsonBody = (buf) => {
    const raw = buf.toString('utf8');
    return raw ? JSON.parse(raw) : {};
  };

  // Antigravity Cloud Code Protocol: forward non-inference handshake calls to Google Cloud
  // (loadCodeAssist, fetchUserInfo, onboardUser, etc.)
  if (pathname.includes(':loadCodeAssist') || pathname.includes(':fetchUserInfo') || pathname.includes(':onboardUser')) {
    const rawBuf = await readRawBody();
    return await forwardToGoogleCloudCode(req, res, rawBuf);
  }

  // Chat completions (OpenAI format for external IDE extensions)
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    try {
      const rawBuf = await readRawBody();
      const body = parseJsonBody(rawBuf);
      return await handleChatCompletions(req, res, body);
    } catch (err) {
      return sendError(res, 400, err.message);
    }
  }

  // Antigravity Cloud Code Protocol: fetchAvailableModels (proxied and enriched with Gemini 4 Argon)
  if (pathname.includes(':fetchAvailableModels')) {
    const rawBuf = await readRawBody();
    return await forwardAvailableModels(req, res, rawBuf);
  }

  // Antigravity Cloud Code Protocol: retrieveUserQuotaSummary / retrieveUserQuota
  if (pathname.includes(':retrieveUserQuotaSummary') || pathname.includes(':retrieveUserQuota')) {
    const rawBuf = await readRawBody();
    return await forwardToGoogleCloudCode(req, res, rawBuf);
  }

  // Antigravity Cloud Code Protocol: countTokens
  if (req.method === 'POST' && (pathname === '/v1internal:countTokens' || pathname.endsWith(':countTokens'))) {
    try {
      const rawBuf = await readRawBody();
      const body = parseJsonBody(rawBuf);
      const promptLen = JSON.stringify(body).length;
      return sendJson(res, 200, { totalTokens: Math.max(1, Math.round(promptLen / 4)) });
    } catch {
      return sendJson(res, 200, { totalTokens: 100 });
    }
  }

  // Antigravity Cloud Code Protocol: streamGenerateContent / generateContent (Interception & Ultra-Quota Routing)
  if (req.method === 'POST' && (pathname === '/v1internal:streamGenerateContent' || pathname === '/v1internal:generateContent' || pathname.endsWith(':streamGenerateContent') || pathname.endsWith(':generateContent'))) {
    try {
      const rawBuf = await readRawBody();
      const body = parseJsonBody(rawBuf);
      const isStream = parsedUrl.searchParams.get('alt') === 'sse' || pathname.includes('streamGenerateContent');
      return await handleCloudCodeGenerateContent(req, res, body, rawBuf, isStream);
    } catch (err) {
      return sendError(res, 400, err.message);
    }
  }

  // Admin API: Pool Status
  if (req.method === 'GET' && (pathname === '/admin/api/status' || pathname === '/admin/api/cookies')) {
    const status = pool.getStatus();
    return sendJson(res, 200, {
      ...status,
      port: config.port,
      proxy: config.proxy || 'direct',
      total: status.totalAccounts,
      keepAlive: keepAliveManager.getStatus(),
    });
  }

  // Admin API: Keep-Alive Diagnostic Status
  if (req.method === 'GET' && pathname === '/admin/api/keepalive') {
    return sendJson(res, 200, keepAliveManager.getStatus());
  }

  // Admin API: Add Account
  if (req.method === 'POST' && (pathname === '/admin/api/accounts' || pathname === '/admin/api/cookies')) {
    try {
      const rawBuf = await readRawBody();
      const body = parseJsonBody(rawBuf);
      const cookieData = body.cookie || body.raw || body;
      const label = body.label || body.note || '';
      const acc = await pool.addAccount(cookieData, label);
      return sendJson(res, 201, {
        ok: true,
        id: acc.id,
        label: acc.label,
        status: acc.status,
        quota: acc.quota,
      });
    } catch (err) {
      return sendError(res, 400, `Failed to add account: ${err.message}`);
    }
  }

  // Admin API: Delete Account
  if (req.method === 'DELETE' && pathname.startsWith('/admin/api/accounts/')) {
    const accId = pathname.slice('/admin/api/accounts/'.length);
    const removed = pool.removeAccount(accId);
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }

  // Admin API: Refresh / Check Account
  if (req.method === 'POST' && (pathname.match(/^\/admin\/api\/accounts\/[^/]+\/refresh$/) || pathname.match(/^\/admin\/api\/cookies\/[^/]+\/check$/))) {
    const parts = pathname.split('/');
    const accId = parts[4];
    const acc = pool.accounts.find((a) => a.id === accId);
    if (!acc) return sendError(res, 404, 'Account not found');
    try {
      await pool.refreshAccountSession(acc);
      return sendJson(res, 200, {
        ok: true,
        id: acc.id,
        label: acc.label,
        status: acc.status,
        quota: acc.quota,
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, detail: err.message });
    }
  }

  // Admin API: Trigger Keep-Alive
  if (req.method === 'POST' && pathname === '/admin/api/keepalive') {
    for (const acc of pool.accounts) {
      try {
        await pool.refreshAccountSession(acc);
      } catch (err) {
        console.warn(`[Argon Gateway] Refresh notice for ${acc.id}: ${err.message}`);
      }
    }
    return sendJson(res, 200, { ok: true, status: pool.getStatus() });
  }

  // Default fallback for any other Cloud Code endpoints: forward transparently
  const rawBuf = await readRawBody();
  return await forwardToGoogleCloudCode(req, res, rawBuf);
});

if (require.main === module) {
  keepAliveManager.start();
  server.listen(config.port, config.host, () => {
    console.info(`[Argon Gateway] Listening on http://${config.host}:${config.port}/v1 (Proxy: ${config.proxy || 'direct'})`);
    console.info(`[Argon Gateway] Pool loaded: ${pool.accounts.length} account(s), Active: ${pool.activeAccountId || 'None'}`);
  });
}

module.exports = {
  extractToolsFromPayload,
  buildToolInstructionPrompt,
  extractToolCallsFromOutput,
  server,
  pool,
};
