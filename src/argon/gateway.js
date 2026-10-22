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
// [ARGON PIPELINE: DISABLED] Google account pool & Bard web interface
// const { AccountPool, BASE_URL, USER_AGENT } = require('./account-pool');
// const { KeepAliveManager } = require('./keepalive-manager');
const { createAgent, directHttpsAgent, doRequest } = require('./http-client');
// const {
//   GENERATE_PATH,
//   buildGenerateRequest,
//   buildModelHeader,
// } = require('./wire-format');
// const {
//   parseGoogleFrames,
//   parseGeminiStream,
// } = require('./stream-parser');
const {
  runJigitPipeline,
  enforceJigitBudget,
} = require('./jigit-engine');
const {
  setActiveConversation,
} = require('./capsule-store');
const { ensureMcpRegistered } = require('./mcp-registration');

const ANTIGRAVITY_IDE_SYSTEM_PROMPT = `# Role & Environment: Antigravity IDE Autonomous Pair Programmer
You are Antigravity, an expert Principal Software Engineer and autonomous coding assistant operating directly inside the Google Antigravity IDE workspace.
You have direct, real-time access to the user's local operating system, active project workspace, terminal, and filesystem through integrated workspace tools.

CORE ENVIRONMENT AWARENESS:
1. Environment: You are NOT a remote chatbot answering theoretical questions. You are pair programming with the user inside their IDE.
2. Direct Action Over Conversation: Never tell the user "run this command", "create this file", "open your terminal", or "here is the script to save". Instead, IMMEDIATELY call the provided workspace tools to perform the work yourself.
3. Proactive Execution:
   - When asked to inspect, debug, or write code, call 'read_file', 'edit_file', or 'write_file'.
   - When asked to check git status, test scripts, or run background processes, call 'run_command'.
4. JIGIT Context Compression & Memory Restoration:
   - When historical turns, long logs, or huge files are compressed by the JIGIT engine, they appear as \`[JIGIT Engine: ... capsule=jigit-xxxxx]\`.
   - If you need full, untruncated original content, invoke the 'jigit-memory' MCP tool: \`jigit_restore_capsule\` with \`capsule_id\`.
5. Tool Calling Syntax:
   Whenever an action is needed, output a \`\`\`tool_call block immediately so the IDE runtime executes it without delay.`;

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
// [ARGON PIPELINE: DISABLED] Account pool and keep-alive manager disabled
// const pool = new AccountPool({
//   storagePath: config.storagePath,
//   agent: httpAgent,
// });
// const keepAliveManager = new KeepAliveManager(pool);
const pool = {
  accounts: [],
  getStatus: () => ({ totalAccounts: 0, activeAccountId: null, accounts: [] }),
  getActiveAccount: () => null,
  save: () => {},
};
const keepAliveManager = {
  getStatus: () => ({ running: false, activeIntervals: 0 }),
  start: () => {},
  stop: () => {},
};

const KNOWN_UPSTREAM_MODELS = {
  'gemini-4-argon': '95a4c0abcba24364',
  'gemini-4-argon-thinking-medium': '95a4c0abcba24364',
  'gemini-4-argon-thinking-high': '95a4c0abcba24364',
  'gemini-4-argon-thinking-low': '95a4c0abcba24364',
  'gemini-3.8-flash': '56fdd199312815e2',
  'gemini-3.8-flash-high': '56fdd199312815e2',
  'gemini-3.8-flash-medium': '56fdd199312815e2',
  'gemini-3.8-flash-low': '56fdd199312815e2',
  'gemini-3.8-flash-thinking': '56fdd199312815e2',
  'gemini-3.1-pro': 'e6fa609c3fa255c0',
  'gemini-3.1-pro-advanced': 'e6fa609c3fa255c0',
  'gemini-3.5-flash-lite': '8c46e95b1a07cecc',
  'claude-sonnet-4-6': '95a4c0abcba24364',
  'claude-sonnet-4-5': '95a4c0abcba24364',
  'claude-sonnet-4': '95a4c0abcba24364',
  'claude-opus-5-5': '95a4c0abcba24364',
};

const SUPPORTED_MODELS = [
  { id: 'gemini-4-argon', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-4-argon-thinking-medium', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-4-argon-thinking-high', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.8-flash', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.8-flash-high', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.8-flash-medium', object: 'model', owned_by: 'google', permission: [] },
  { id: 'gemini-3.8-flash-low', object: 'model', owned_by: 'google', permission: [] },
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
    'gemini-3.8-flash-medium': {
      displayName: 'Gemini 3.8 Flash (Thinking Medium)',
      description: 'Balanced latency coding model with Ultra-Quota pool',
      tagTitle: '',
      disabled: false,
      supportsRawThinking: true,
      supportsAdaptiveThinking: true,
    },
    'gemini-3.8-flash-high': {
      displayName: 'Gemini 3.8 Flash (Thinking High)',
      description: 'Extended depth reasoning Flash model with Ultra-Quota pool',
      tagTitle: '',
      disabled: false,
      supportsRawThinking: true,
      supportsAdaptiveThinking: true,
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
            'gemini-3.8-flash-medium',
            'gemini-3.8-flash-high',
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
  const raw = String(requestedModel || '').toLowerCase().replace(/^google\//, '').replace(/^gemini\//, '').replace(/^anthropic\//, '');
  let targetFamily = 'argon';
  if (raw.includes('flash-lite') || raw.includes('flash_lite')) {
    targetFamily = 'flash-lite';
  } else if (raw.includes('flash')) {
    targetFamily = 'flash';
  } else if (raw.includes('pro')) {
    targetFamily = 'pro';
  } else {
    targetFamily = 'argon';
  }

  if (account && Array.isArray(account.availableModels)) {
    const discovered = account.availableModels.find((m) => {
      const dName = String(m.displayName || '').toLowerCase();
      const mId = String(m.id || '').toLowerCase();
      if (targetFamily === 'argon') return dName.includes('argon') || mId === '95a4c0abcba24364';
      if (targetFamily === 'flash-lite') return dName.includes('lite') || mId === '8c46e95b1a07cecc';
      if (targetFamily === 'flash') return (dName.includes('flash') && !dName.includes('lite')) || mId === '56fdd199312815e2';
      if (targetFamily === 'pro') return dName.includes('pro') || mId === 'e6fa609c3fa255c0';
      return false;
    });
    if (discovered) return discovered.id;
  }

  const modelKey = targetFamily === 'flash' ? 'gemini-3.8-flash' : (targetFamily === 'flash-lite' ? 'gemini-3.5-flash-lite' : (targetFamily === 'pro' ? 'gemini-3.1-pro' : 'gemini-4-argon'));
  return KNOWN_UPSTREAM_MODELS[modelKey] || '95a4c0abcba24364';
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
CRITICAL DIRECTIVES FOR AUTONOMOUS AGENT OPERATION:
1. You are Antigravity, an autonomous coding agent operating inside the user's IDE with direct workspace tool capabilities.
2. Direct Action Required: When inspecting files, analyzing project structure, checking git, or running commands, NEVER output conversational chatter, conversational preambles, or narrative promises (e.g. NEVER write "I will check the codebase...", "Let's read README.md first...", or "I will now inspect...").
3. Immediate Tool Execution: If any action or investigation is required, you MUST IMMEDIATELY invoke the required tool using a \`\`\`tool_call block as the very first output in your response.
4. Outputting conversational text without a \`\`\`tool_call block when actions are needed terminates your turn prematurely and causes the task to FAIL.
5. If you have internal reasoning, you may write it concisely, but it MUST be immediately followed by the \`\`\`tool_call block in the exact same response.
6. Only output plain text responses when the requested task is 100% finished and no further tool execution is necessary.

Tool Calling Syntax:
Whenever an action is needed, output a \`\`\`tool_call block as demonstrated below:
\`\`\`tool_call
${JSON.stringify({ name: sampleTool.name, args: sampleArgs }, null, 2)}
\`\`\`

Available Tools in this IDE Session:
${toolDefs}

When an action is needed, output the \`\`\`tool_call block immediately so the IDE runtime executes it without delay.`;
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

let jigitEngine = require('./jigit-engine');

function optimizeConversationTurns(turnsList, maxTurnToolResultChars = 1200, keepFullRecentTurns = 10, maxTotalPromptTurns = 16) {
  const runner = jigitEngine.runJigitPipeline || runJigitPipeline;
  return runner(turnsList, {
    keepRecentTurns: keepFullRecentTurns,
    maxPromptTurns: maxTotalPromptTurns,
  });
}

function enforcePromptBudget(promptText, maxChars = 38000) {
  const enforcer = jigitEngine.enforceJigitBudget || enforceJigitBudget;
  return enforcer(promptText, maxChars);
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

  // 3. Bare fenced ``` ... ``` with name & args
  const bareFenceRegex = /```\s*(\{\s*"(?:name|tool)"\s*:\s*"[^"]+"\s*,\s*"(?:args|parameters|arguments)"\s*:[\s\S]*?\})\s*```/gi;
  while ((match = bareFenceRegex.exec(text)) !== null) {
    parseBlock(match[1]);
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(bareFenceRegex, '').trim();
    return { toolCalls, cleanText };
  }

  // 4. Format: [Tool Call: run_command({"CommandLine": "..."})] or [ASSISTANT TOOL CALL: ...]
  const bracketToolCallRegex = /\[(?:Tool Call|TOOL CALL|ToolCall|ASSISTANT TOOL CALL):\s*([a-zA-Z0-9_\-]+)\s*\(([\s\S]*?)\)\]/gi;
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

  // 5. Raw JSON object containing "name" and "args" (if the model didn't use fences)
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

  // 6. Direct invocation: tool_name({"CommandLine": "..."}) or tool_name({"Path": "..."})
  const directFnRegex = /(?:^|\n)\s*([a-zA-Z0-9_\-]+)\s*\(\s*(\{[\s\S]*?\})\s*\)\s*(?:\n|$)/g;
  while ((match = directFnRegex.exec(text)) !== null) {
    const fnName = match[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'console', 'require', 'import'].includes(fnName)) continue;
    try {
      const args = JSON.parse(match[2]);
      toolCalls.push({ name: fnName, args });
    } catch {}
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(directFnRegex, '').trim();
    return { toolCalls, cleanText };
  }

  // 7. ReAct format: Action: <name>\nAction Input: {...}
  const reactRegex = /Action:\s*([a-zA-Z0-9_\-]+)\s*\n+Action Input:\s*(\{[\s\S]*?\})/gi;
  while ((match = reactRegex.exec(text)) !== null) {
    const name = match[1];
    let args = {};
    try { args = JSON.parse(match[2].trim()); } catch {}
    toolCalls.push({ name, args });
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(reactRegex, '').trim();
    return { toolCalls, cleanText };
  }

  // 8. XML tag format: <function_call name="...">{"arg": "val"}</function_call>
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
  parts.push(ANTIGRAVITY_IDE_SYSTEM_PROMPT);
  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    const sysTexts = systemInstruction.parts.map((p) => (typeof p === 'string' ? p : p.text || '')).filter(Boolean);
    if (sysTexts.length) parts.push(`# Instructions\n${sysTexts.join('\n')}`);
  }
  if (Array.isArray(contents)) {
    const optimized = optimizeConversationTurns(contents, 1200, 4, 8);
    for (const turn of optimized) {
      const hasFunctionResponse = Array.isArray(turn.parts) && turn.parts.some((p) => p && p.functionResponse);
      const role = String(turn.role || 'user').toUpperCase();
      let roleLabel;
      if (hasFunctionResponse) {
        roleLabel = 'User (Tool Result):';
      } else if (role === 'MODEL') {
        roleLabel = 'Assistant:';
      } else {
        roleLabel = 'User:';
      }
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

  // 1. ALWAYS inject the fundamental Antigravity IDE Identity & Environment persona
  parts.push(ANTIGRAVITY_IDE_SYSTEM_PROMPT);

  // 2. Extract Tools from payload and prepend tool calling capabilities
  const tools = extractToolsFromPayload(bodyJson);
  if (tools.length > 0) {
    parts.push(buildToolInstructionPrompt(tools));
  }

  // 3. Extract external System Instruction passed by Antigravity / Cloud Code
  if (typeof sysInst === 'string' && sysInst.trim()) {
    parts.push(`# Additional Workspace Instructions\n${sysInst.trim()}`);
  } else if (sysInst && typeof sysInst === 'object') {
    if (typeof sysInst.text === 'string' && sysInst.text.trim()) {
      parts.push(`# Additional Workspace Instructions\n${sysInst.text.trim()}`);
    } else if (Array.isArray(sysInst.parts)) {
      const texts = sysInst.parts.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).filter(Boolean);
      if (texts.length) parts.push(`# Additional Workspace Instructions\n${texts.join('\n')}`);
    }
  }

  // 4. Extract Contents / Turns with sliding window context optimization
  const rawTurnsList = Array.isArray(contents) ? contents : (contents && typeof contents === 'object' ? [contents] : (Array.isArray(turns) ? turns : null));
  const turnsList = optimizeConversationTurns(rawTurnsList, 1200, 4, 8);
  if (turnsList) {
    for (const turn of turnsList) {
      if (!turn) continue;
      const hasFunctionResponse = Array.isArray(turn.parts) && turn.parts.some((p) => p && p.functionResponse);
      const role = String(turn.role || turn.author || 'USER').toUpperCase();
      let roleLabel;
      if (hasFunctionResponse) {
        roleLabel = 'User (Tool Result):';
      } else if (role === 'MODEL') {
        roleLabel = 'Assistant:';
      } else {
        roleLabel = 'User:';
      }
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
    const full = parts.join('\n\n');
    if (tools.length > 0 && !full.trim().endsWith('Assistant:')) {
      return enforcePromptBudget(full + '\n\nAssistant:');
    }
    return enforcePromptBudget(full);
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

/* =========================================================================
   [ARGON PIPELINE: DISABLED] handleChatCompletions (Reverse-engineered Bard Web API)
   =========================================================================
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

      // Antigravity Agent Mode ultra-quota activation (action: 12)
      const genReq = buildGenerateRequest(prompt, modelHeader, account.session, 100000 + attempts, {
        agentMode: true,
        action: 12,
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
        let streamRemainderBuf = Buffer.alloc(0);
        let streamedLength = 0;

        upstreamRes.body.on('data', (chunk) => {
          const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          streamRemainderBuf = Buffer.concat([streamRemainderBuf, chunkBuf]);
          const { frames, remainder } = parseGoogleFrames(streamRemainderBuf);
          streamRemainderBuf = remainder;

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
========================================================================= */

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
async function forwardToGoogleCloudCode(req, res, reqBuffer, timeoutMs = 300000, maxRetries = 2) {
  let attempt = 0;

  const tryForward = () => {
    return new Promise((resolve) => {
      attempt++;
      const upstreamUrl = new URL(req.url, 'https://daily-cloudcode-pa.googleapis.com');
      const headers = { ...req.headers };

      // Clean conflicting or hop-by-hop headers
      delete headers.host;
      delete headers['transfer-encoding']; // CRITICAL: prevent sending both chunked and content-length to upstream
      delete headers['connection'];
      delete headers['keep-alive'];
      headers['host'] = 'daily-cloudcode-pa.googleapis.com';
      headers['connection'] = 'close';

      if (reqBuffer && reqBuffer.length > 0) {
        headers['content-length'] = String(Buffer.byteLength(reqBuffer));
      } else {
        delete headers['content-length'];
      }

      const options = {
        hostname: 'daily-cloudcode-pa.googleapis.com',
        port: 443,
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers,
        agent: httpAgent || directHttpsAgent,
        timeout: timeoutMs,
      };

      let aborted = false;
      const upstreamReq = https.request(options, (upstreamRes) => {
        const resHeaders = { ...upstreamRes.headers };
        delete resHeaders['connection'];
        delete resHeaders['keep-alive'];
        delete resHeaders['transfer-encoding'];
        res.writeHead(upstreamRes.statusCode, resHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => resolve(true));
      });

      upstreamReq.on('timeout', () => {
        console.warn(`[JIGIT Gateway] Upstream Cloud Code request timed out after ${timeoutMs}ms (attempt ${attempt}): ${req.url}`);
        upstreamReq.destroy();
      });

      // ONLY destroy upstream if the client response is aborted before completion
      const onClientClose = () => {
        if (!res.writableEnded) {
          aborted = true;
          upstreamReq.destroy();
        }
      };
      res.once('close', onClientClose);

      upstreamReq.on('error', async (err) => {
        console.error(`[JIGIT Gateway] Upstream Cloud Code error (attempt ${attempt}/${maxRetries + 1}): ${err.message}`);

        if (aborted || res.writableEnded || res.headersSent) {
          resolve(false);
          return;
        }

        // Retry transient socket errors (socket hang up, ECONNRESET, bad record mac)
        if (attempt <= maxRetries) {
          console.warn(`[JIGIT Gateway] Retrying upstream request to Cloud Code in 300ms (attempt ${attempt + 1})...`);
          await new Promise((r) => setTimeout(r, 300));
          const retryOk = await tryForward();
          resolve(retryOk);
          return;
        }

        if (!res.headersSent) {
          sendError(res, 502, `Cloud Code upstream error: ${err.message}`);
        }
        resolve(false);
      });

      if (reqBuffer && reqBuffer.length > 0) {
        upstreamReq.write(reqBuffer);
      }
      upstreamReq.end();
    });
  };

  return await tryForward();
}

// Forward user quota from Google Cloud Code transparently
async function forwardUserQuota(req, res, reqBuffer) {
  return await forwardToGoogleCloudCode(req, res, reqBuffer, 30000);
}

async function forwardAvailableModels(req, res, reqBuffer) {
  // Transparent proxy to Google Cloud Code - native Antigravity models
  return await forwardToGoogleCloudCode(req, res, reqBuffer, 30000);
}

async function _legacyForwardAvailableModels(req, res, reqBuffer) {
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
      agent: httpAgent || directHttpsAgent,
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

            json.models['gemini-3.8-flash-medium'] = {
              displayName: 'Gemini 3.8 Flash (Thinking Medium)',
              description: 'Balanced latency coding model with Ultra-Quota pool',
              supportsImages: true,
              supportsThinking: true,
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
            json.models['gemini-3.8-flash-high'] = {
              displayName: 'Gemini 3.8 Flash (Thinking High)',
              description: 'Extended depth reasoning Flash model with Ultra-Quota pool',
              supportsImages: true,
              supportsThinking: true,
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

            // Uncap Claude Sonnet, Argon, and Flash models so Antigravity UI never flags individual baseline quota exhaustion
            for (const key of Object.keys(json.models)) {
              if (key.includes('sonnet') || key.includes('claude') || key.includes('opus') || key.includes('argon') || key.includes('flash')) {
                const m = json.models[key];
                if (m && typeof m === 'object') {
                  m.quotaInfo = {
                    remainingFraction: 1.0,
                    resetTime: '2099-01-01T00:00:00Z',
                  };
                  m.disabled = false;
                }
              }
            }
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

function dumpDebugPayload(prefix, req, bodyJson, rawBuf) {
  try {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const debugDir = path.join(programData, 'geminUp', 'argon');
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    const dumpPath = path.join(debugDir, 'last_intercept_debug.json');
    const info = {
      timestamp: new Date().toISOString(),
      prefix,
      url: req.url,
      method: req.method,
      headers: req.headers,
      bodyJson,
      rawLength: rawBuf ? rawBuf.length : 0,
    };
    fs.writeFileSync(dumpPath, JSON.stringify(info, null, 2), 'utf8');
  } catch {}
}

/* =========================================================================
   [ARGON PIPELINE: DISABLED] handleCloudCodeGenerateContent (Bard web interface & account pool)
   =========================================================================
async function handleCloudCodeGenerateContent(req, res, bodyJson, rawBuf, isStream = true) {
  const redirectConfig = getRedirectConfig();
  dumpDebugPayload('handleCloudCodeGenerateContent', req, bodyJson, rawBuf);

  // Search comprehensively for model identifiers only across structural model fields (NEVER conversation history text)
  const reqObj = (bodyJson && typeof bodyJson === 'object') ? (bodyJson.request || bodyJson) : {};
  const rawModel = String(
    bodyJson?.model ||
    reqObj.model ||
    bodyJson?.modelName ||
    reqObj.modelName ||
    bodyJson?.modelId ||
    reqObj.modelId ||
    bodyJson?.model_id ||
    reqObj.model_id ||
    bodyJson?.modelConfiguration?.model ||
    reqObj.modelConfiguration?.model ||
    reqObj.labels?.model_enum ||
    ''
  ).toLowerCase().trim();

  const headerModel = String(req.headers['x-goog-model'] || req.headers['x-model'] || '').toLowerCase().trim();
  const effectiveModel = rawModel || headerModel || 'gemini-4-argon';

  const isSonnet = effectiveModel.includes('sonnet') || effectiveModel.includes('claude') || effectiveModel.includes('opus');
  const isFlash = effectiveModel.includes('flash');
  const isPro = effectiveModel.includes('pro');
  const isArgon = effectiveModel.includes('argon') || (!isSonnet && !isFlash && !isPro);

  const humanModelName = isSonnet
    ? 'Claude Sonnet 4.6 (Argon Route)'
    : isFlash
      ? (effectiveModel.includes('lite') ? 'Gemini 3.5 Flash-Lite'
        : effectiveModel.includes('medium') ? 'Gemini 3.8 Flash (Thinking Medium)'
        : effectiveModel.includes('high') ? 'Gemini 3.8 Flash (Thinking High)'
        : effectiveModel.includes('low') ? 'Gemini 3.8 Flash (Thinking Low)'
        : 'Gemini 3.8 Flash')
      : isPro
        ? 'Gemini 3.1 Pro'
        : (effectiveModel.includes('medium') ? 'Gemini 4 Argon (Thinking Medium)'
          : effectiveModel.includes('high') ? 'Gemini 4 Argon (Thinking High)'
          : 'Gemini 4 Argon');

  // Intercept Argon, Sonnet (always mapped to Argon Ultra-Quota), Flash, and Pro models to serve via Ultra-Quota pool with JIGIT Engine compression
  const isTargeted = isArgon || isSonnet || isFlash || isPro;

  // If this model is not targeted for pool routing, pass through to Google Cloud Code (routed via SOCKS5 tunnel)
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
    console.warn('[Argon Gateway] No prompt text extracted from payload. Serving fail-closed notice rather than falling back to Google Cloud Code quota.');
    return sendCloudCodeError(400, 'Не удалось извлечь текст запроса из контекста Antigravity IDE. Повторите запрос.');
  }

  if (isSonnet) {
    console.info(`[Argon Gateway] [PIPE ACTIVE] Intercepted Claude Sonnet 4.6 request -> Redirecting to Gemini 4 Argon Ultra-Quota pool (${pool.accounts.length} accounts active)`);
  } else if (isFlash) {
    console.info(`[Argon Gateway] [PIPE ACTIVE] Intercepted ${humanModelName} request -> Serving with pool (${pool.accounts.length} accounts active)`);
  } else if (isPro) {
    console.info(`[Argon Gateway] [PIPE ACTIVE] Intercepted Gemini 3.1 Pro request -> Serving with pool (${pool.accounts.length} accounts active)`);
  } else {
    console.info(`[Argon Gateway] [PIPE ACTIVE] Intercepted Gemini 4 Argon Ultra-Quota request -> Serving with pool (${pool.accounts.length} accounts active)`);
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
                parts: [{ text: `\n\n⚠️ **[geminUp Gateway: ${humanModelName}]**\n\n${message}` }],
              },
              finishReason: 'STOP',
            },
          ],
        },
      };
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      }
      res.end();
      return;
    }
    return sendJson(res, 200, {
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: `⚠️ **[geminUp Gateway: ${humanModelName}]**\n\n${message}` }],
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
        ? 'Claude Sonnet перенаправлен на Gemini 4 Argon, но все Google-аккаунты в пуле Ultra-Quota сейчас исчерпаны или требуют обновления.\n\nВключен **режим Fail-Closed**, чтобы предотвратить случайный расход квоты Claude Sonnet в IDE.\n\nОбнови куки через: .\\geminUp.ps1 -Action argon-cookie'
        : `Все Google-аккаунты в пуле Ultra-Quota для ${humanModelName} сейчас исчерпаны или требуют обновления. Обнови куки через: .\\geminUp.ps1 -Action argon-cookie`;
      return sendCloudCodeError(429, msg);
    }
    return await forwardToGoogleCloudCode(req, res, rawBuf);
  }

  let attempts = 0;
  const maxAttempts = Math.max(6, pool.accounts.length * 3);

  // Client connection tracking
  let clientAborted = false;
  let activeUpstreamRes = null;

  req.on('close', () => {
    clientAborted = true;
    if (activeUpstreamRes && activeUpstreamRes.body && typeof activeUpstreamRes.body.destroy === 'function') {
      try { activeUpstreamRes.body.destroy(); } catch { }
    }
  });

  // Track if SSE headers were emitted to client
  let sseHeadersSent = false;
  const ensureSseHeaders = () => {
    if (!sseHeadersSent && isStream && !res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      sseHeadersSent = true;
    }
  };

  let accumulatedContent = '';
  let accumulatedThoughts = '';
  let streamedContentLength = 0;

  let lastAttemptError = null;
  let lastStreamError = null;
  while (attempts < maxAttempts) {
    attempts++;
    if (clientAborted || res.writableEnded || res.destroyed) {
      return;
    }

    try {
      if (!account.session || !account.session.accessToken) {
        await pool.refreshAccountSession(account);
      }

      const upstreamId = resolveModelUpstream(isSonnet ? 'claude-sonnet-4-6' : effectiveModel, account);
      const capacity = account.modelCapacity || 1;
      const capacityField = account.modelCapacityField || 12;
      const modelHeader = buildModelHeader(upstreamId, capacity, capacityField);

      // Antigravity Agent Mode ultra-quota activation (action: 12)
      const genReq = buildGenerateRequest(prompt, modelHeader, account.session, 200000 + attempts, {
        agentMode: true,
        action: 12,
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

      activeUpstreamRes = upstreamRes;
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
        ensureSseHeaders();

        let streamRemainderBuf = Buffer.alloc(0);
        let streamError = null;
        let streamFinishedCleanly = false;

        const streamResult = await new Promise((resolve) => {
          upstreamRes.body.on('data', (chunk) => {
            if (clientAborted || res.writableEnded || res.destroyed) return;
            const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            streamRemainderBuf = Buffer.concat([streamRemainderBuf, chunkBuf]);
            const { frames, remainder } = parseGoogleFrames(streamRemainderBuf);
            streamRemainderBuf = remainder;

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

                  const toolTagIdx = accumulatedContent.search(/```(?:tool_call|toolcall|tool|json)?|\[(?:Tool Call|TOOL CALL|ToolCall|ASSISTANT TOOL CALL):|<(?:function_call|tool_call)|Action:\s*[a-zA-Z0-9_\-]+/i);

                  if (hasTools) {
                    if (toolTagIdx !== -1) {
                      // Tool call block detected: stream any text preceding the tool block as thoughts
                      const preamble = accumulatedContent.slice(0, toolTagIdx).trim();
                      if (preamble.length > streamedContentLength) {
                        const deltaThoughts = preamble.slice(streamedContentLength);
                        streamedContentLength = preamble.length;
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
                    } else if (accumulatedContent.length < 400) {
                      // Buffer early text (< 400 chars) while waiting to see if a tool call appears
                    } else {
                      // No tool syntax and content exceeded 400 chars: clearly a text answer, stream as regular text
                      const deltaText = accumulatedContent.slice(streamedContentLength);
                      streamedContentLength = accumulatedContent.length;
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
                  } else {
                    const deltaText = accumulatedContent.slice(streamedContentLength);
                    streamedContentLength = accumulatedContent.length;
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
            streamFinishedCleanly = true;
            resolve({ ok: !streamError, error: streamError });
          });

          upstreamRes.body.on('error', (err) => {
            console.warn(`[Argon Gateway] Upstream stream event: ${err.message}`);
            resolve({ ok: false, error: err });
          });
        });

        if (clientAborted || res.writableEnded || res.destroyed) {
          return;
        }

        // Failover condition:
        // 1. streamResult.ok === false or streamError is set
        // 2. OR streamedContentLength === 0 and accumulatedContent is completely empty (Google finished stream with 0 text/tool calls)
        const streamProducedNoContent = streamedContentLength === 0 && (!accumulatedContent || accumulatedContent.trim().length === 0);
        if (!streamResult.ok || streamError || streamProducedNoContent) {
          const err = streamResult.error || streamError;
          lastStreamError = err;
          const errMsg = err?.message || (streamProducedNoContent ? 'Upstream returned empty body' : 'Upstream stream error');
          if (streamedContentLength === 0 && attempts < maxAttempts) {
            console.warn(`[Argon Gateway] Upstream error/empty on "${account.label}" (${errMsg}). Failing over & reconnecting (Attempt ${attempts}/${maxAttempts})...`);
            if (err?.upstreamStatus === 429 || err?.upstreamCode === 1037) {
              pool.markExhausted(account.id);
            } else if (err?.upstreamCode === 1155) {
              // Upstream model overloaded (1155): wait with backoff before retry (do NOT exhaust account)
              const backoffMs = 1500 + attempts * 500 + Math.floor(Math.random() * 500);
              console.warn(`[Argon Gateway] Upstream 1155 Overload on "${account.label}". Waiting ${backoffMs}ms before rotating (Attempt ${attempts}/${maxAttempts})...`);
              await new Promise((r) => setTimeout(r, backoffMs));
            }
            // Explicitly rotate to next account in pool
            account = pool.rotateActiveAccount() || account;
            continue;
          }
        }
        // If we reached here, finish the response
        let { toolCalls, cleanText } = extractToolCallsFromOutput(accumulatedContent);
        if (toolCalls.length === 0 && accumulatedThoughts) {
          const thoughtToolCheck = extractToolCallsFromOutput(accumulatedThoughts);
          if (thoughtToolCheck.toolCalls.length > 0) {
            toolCalls = thoughtToolCheck.toolCalls;
          }
        }

        if (toolCalls.length > 0) {
          const parts = [];
          if (cleanText && cleanText.trim().length > 0 && streamedContentLength === 0) {
            parts.push({
              text: cleanText.trim(),
              thought: true,
            });
          }
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
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(toolCc)}\n\n`);
          }
          res.end();
          return;
        }

        if (accumulatedContent.length > streamedContentLength) {
          const remainingText = accumulatedContent.slice(streamedContentLength);
          if (remainingText.length > 0) {
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
            if (!res.writableEnded && !res.destroyed) {
              res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
            }
            streamedContentLength += remainingText.length;
          }
        }

        if (streamedContentLength === 0) {
          let fallbackText = '';
          if (cleanText && cleanText.trim().length > 0) {
            fallbackText = cleanText.trim();
          } else if (lastStreamError?.upstreamCode === 1155) {
            fallbackText = `⚠️ [geminUp Gateway] Upstream Google ${humanModelName} is temporarily overloaded (Error 1155). Please retry your request in a few moments.`;
          } else if (lastStreamError?.message) {
            fallbackText = `⚠️ [geminUp Gateway] Upstream ${humanModelName} generation failed: ${lastStreamError.message}. Please retry your request.`;
          } else {
            fallbackText = `⚠️ [geminUp Gateway] Upstream Google ${humanModelName} completed without generating output text. Please retry your request.`;
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
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
          }
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
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify(finalCc)}\n\n`);
        }
        res.end();
        return;
      }

      // Non-streaming response collection
      const fullText = await upstreamRes.text();
      const { frames } = parseGoogleFrames(fullText);
      const parsed = parseGeminiStream(frames);
      const { toolCalls, cleanText } = extractToolCallsFromOutput(parsed.content || '');

      const parts = [];
      if (toolCalls.length > 0) {
        if (cleanText && cleanText.trim().length > 0) {
          parts.push({ text: cleanText.trim(), thought: true });
        }
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
        const fallback = '[Argon Gateway: Upstream Gemini model returned empty response.]';
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
      lastAttemptError = err?.message || JSON.stringify(err);
      console.warn(`[Argon Gateway] CC Attempt ${attempts} failed on account "${account.label}": ${err.message}`);
      if (err.upstreamStatus === 429 || err.upstreamCode === 1037) {
        pool.markExhausted(account.id);
      } else if (err.upstreamCode === 1096 || err.upstreamStatus === 401) {
        pool.markError(account.id, 'Session expired; re-auth required');
      } else if (err?.upstreamCode === 1155) {
        const backoffMs = 1500 + attempts * 500 + Math.floor(Math.random() * 500);
        console.warn(`[Argon Gateway] Upstream 1155 Overload in catch on "${account.label}". Waiting ${backoffMs}ms before rotating (Attempt ${attempts}/${maxAttempts})...`);
        await new Promise((r) => setTimeout(r, backoffMs));
      } else {
        // Network / socket error (e.g. ECONNRESET, aborted, timeout): back off briefly before failover
        await new Promise((r) => setTimeout(r, 800));
      }

      account = pool.rotateActiveAccount() || pool.getActiveAccount();
      if (!account) {
        if (isSonnet || isArgon || redirectConfig.failClosed) {
          const msg = isSonnet
            ? 'Все Google-аккаунты в пуле Ultra-Quota исчерпаны или требуют обновления.\n\nВключен режим Fail-Closed: Claude Sonnet заблокирован от списания квоты. Обнови куки через: .\\geminUp.ps1 -Action argon-cookie'
            : 'Все аккаунты в пуле geminUp исчерпаны. Обнови куки в меню.';
          return sendCloudCodeError(429, msg);
        }
        return await forwardToGoogleCloudCode(req, res, rawBuf);
      }
    }
  }

  return sendCloudCodeError(
    502,
    `[geminUp Gateway] Upstream Google ${humanModelName} pool request failed (${lastAttemptError || 'Upstream temporarily unavailable'}). Please retry your request.`
  );
}
========================================================================= */

function extractConversationId(bodyJson, rawStr) {
  // 1. Direct JSON properties
  if (bodyJson) {
    const candidate =
      bodyJson.conversationId ||
      bodyJson.conversation_id ||
      bodyJson.request?.conversationId ||
      bodyJson.request?.conversation_id ||
      bodyJson.metadata?.conversationId;
    if (candidate && typeof candidate === 'string') return candidate;

    // Check systemInstruction
    const sys = bodyJson.systemInstruction || bodyJson.request?.systemInstruction;
    if (sys && Array.isArray(sys.parts)) {
      for (const p of sys.parts) {
        if (typeof p.text === 'string') {
          const m = p.text.match(/(?:Conversation ID:\s*|brain[\\\/]+)([a-f0-9-]{36})/i);
          if (m) return m[1];
        }
      }
    }
  }

  // 2. Fallback regex on raw request payload string
  if (typeof rawStr === 'string') {
    const m = rawStr.match(/(?:Conversation ID:\s*|brain[\\\/]+)([a-f0-9-]{36})/i);
    if (m) return m[1];
  }

  return null;
}

/**
 * JIGIT-Powered Antigravity Cloud Code Pipeline
 * Transparent proxy to Antigravity's official Google Cloud Code backend (https://daily-cloudcode-pa.googleapis.com).
 * Uses native Antigravity authorization headers (Bearer tokens from the IDE) without Google account cookies.
 * Intercepts conversation turns and compresses large tool outputs (read_file, run_command, logs) into capsules,
 * cutting token consumption by 70-90% while keeping full context restorable via MCP jigit_restore_capsule.
 * Scopes memory capsules strictly to the active conversation/chat session.
 */
async function handleCloudCodeWithJigit(req, res, rawBuf, isStream = true) {
  let optimizedBuf = rawBuf;

  try {
    const raw = rawBuf.toString('utf8');
    if (raw && raw.trim().startsWith('{')) {
      const bodyJson = JSON.parse(raw);
      dumpDebugPayload('handleCloudCodeWithJigit', req, bodyJson, rawBuf);

      const conversationId = extractConversationId(bodyJson, raw);
      if (conversationId) {
        setActiveConversation(conversationId);
      }

      const hasReqObj = bodyJson && typeof bodyJson.request === 'object' && bodyJson.request !== null;
      const targetReq = hasReqObj ? bodyJson.request : bodyJson;
      const targetContents = targetReq?.contents;

      // Ensure model compatibility (map legacy argon model aliases to native Antigravity models)
      const rawModel = String(bodyJson.model || targetReq.model || '').toLowerCase();
      if (rawModel.includes('argon')) {
        const fallbackModel = 'gemini-3.8-flash';
        if (hasReqObj && bodyJson.request.model) bodyJson.request.model = fallbackModel;
        if (bodyJson.model) bodyJson.model = fallbackModel;
      }

      // Context optimization via JIGIT Engine
      if (Array.isArray(targetContents) && targetContents.length > 0) {
        const originalChars = JSON.stringify(targetContents).length;
        const optimizedContents = runJigitPipeline(targetContents, { conversationId });
        if (hasReqObj) {
          bodyJson.request.contents = optimizedContents;
        } else {
          bodyJson.contents = optimizedContents;
        }
        const optimizedChars = JSON.stringify(optimizedContents).length;
        const savedChars = originalChars - optimizedChars;
        if (savedChars > 0) {
          const chatTag = conversationId ? ` [Chat: ${conversationId.slice(0, 8)}]` : '';
          console.info(`[JIGIT Token Saver]${chatTag} Compacted context: ${originalChars} -> ${optimizedChars} chars (saved ${savedChars} chars / ~${Math.round(savedChars / 4)} tokens)`);
        }
      }

      optimizedBuf = Buffer.from(JSON.stringify(bodyJson), 'utf8');
    } else {
      dumpDebugPayload('handleCloudCodeWithJigit', req, null, rawBuf);
    }
  } catch (err) {
    console.warn(`[JIGIT Token Saver] Error during context compression: ${err.message}. Forwarding original request.`);
    optimizedBuf = rawBuf;
  }

  // Forward to Antigravity's native Google Cloud Code endpoint with 300s streaming timeout
  return await forwardToGoogleCloudCode(req, res, optimizedBuf, 300000);
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
    return sendJson(res, 200, {
      status: 'ok',
      name: 'geminUp JIGIT Gateway',
      version: '3.0.0',
      mode: 'native_cloudcode_jigit',
      argon_pool: 'disabled',
      jigit: { active: true },
    });
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
    return await forwardToGoogleCloudCode(req, res, rawBuf, 30000);
  }

  // Chat completions (OpenAI format notice: ARGON Google account pool disabled)
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    return sendJson(res, 200, {
      id: 'chatcmpl-jigit',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'geminUp Gateway is running in native Antigravity mode with JIGIT Engine token saver (ARGON Google account pool disabled).',
          },
          finish_reason: 'stop',
        },
      ],
    });
  }

  // Antigravity Cloud Code Protocol: fetchAvailableModels (native catalog forwarded)
  if (pathname.includes(':fetchAvailableModels')) {
    const rawBuf = await readRawBody();
    return await forwardAvailableModels(req, res, rawBuf);
  }

  // Antigravity Cloud Code Protocol: retrieveUserQuotaSummary / retrieveUserQuota (native quota forwarded)
  if (pathname.includes(':retrieveUserQuotaSummary') || pathname.includes(':retrieveUserQuota')) {
    const rawBuf = await readRawBody();
    return await forwardUserQuota(req, res, rawBuf);
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

  // Antigravity Cloud Code Protocol: streamGenerateContent / generateContent (JIGIT Token Saver Pipeline)
  if (req.method === 'POST' && (pathname === '/v1internal:streamGenerateContent' || pathname === '/v1internal:generateContent' || pathname.endsWith(':streamGenerateContent') || pathname.endsWith(':generateContent'))) {
    try {
      const rawBuf = await readRawBody();
      const isStream = parsedUrl.searchParams.get('alt') === 'sse' || pathname.includes('streamGenerateContent');
      return await handleCloudCodeWithJigit(req, res, rawBuf, isStream);
    } catch (err) {
      return sendError(res, 400, err.message);
    }
  }

  // Admin API: Pool Status
  if (req.method === 'GET' && (pathname === '/admin/api/status' || pathname === '/admin/api/cookies')) {
    return sendJson(res, 200, {
      ok: true,
      port: config.port,
      mode: 'native_cloudcode_jigit',
      argon_pipeline: 'disabled',
      totalAccounts: 0,
      activeAccountId: null,
      jigit: { active: true },
    });
  }

  // Admin API: Keep-Alive Diagnostic Status
  if (req.method === 'GET' && pathname === '/admin/api/keepalive') {
    return sendJson(res, 200, { running: false, activeIntervals: 0, notice: 'Keep-alive disabled in native Antigravity mode.' });
  }

  // Admin API: Add Account
  if (req.method === 'POST' && (pathname === '/admin/api/accounts' || pathname === '/admin/api/cookies')) {
    return sendJson(res, 200, {
      ok: true,
      notice: 'Google accounts pool is disabled. JIGIT Engine operates directly with native Antigravity credentials.',
    });
  }

  // Admin API: Delete Account
  if (req.method === 'DELETE' && pathname.startsWith('/admin/api/accounts/')) {
    return sendJson(res, 200, { ok: true });
  }

  // Admin API: Refresh / Check Account
  if (req.method === 'POST' && (pathname.match(/^\/admin\/api\/accounts\/[^/]+\/refresh$/) || pathname.match(/^\/admin\/api\/cookies\/[^/]+\/check$/))) {
    return sendJson(res, 200, { ok: true, notice: 'Native Antigravity mode active.' });
  }

  // Admin API: Trigger Keep-Alive
  if (req.method === 'POST' && pathname === '/admin/api/keepalive') {
    return sendJson(res, 200, { ok: true, status: 'disabled_in_native_mode' });
  }

  // Admin API: Hot Reload / Monkey Patch Modules in flight without process restart
  if (req.method === 'POST' && pathname === '/admin/api/reload') {
    try {
      const reloaded = [];
      const modulesToReload = [
        './jigit-engine',
        './capsule-store',
        './stream-parser',
        './wire-format',
        './quota',
        './mcp-registration',
      ];
      for (const modName of modulesToReload) {
        try {
          const resolved = require.resolve(modName);
          delete require.cache[resolved];
          const loaded = require(resolved);
          if (modName === './jigit-engine') {
            jigitEngine = loaded;
          }
          reloaded.push(modName);
        } catch (e) {
          console.warn(`[Argon Hot Reload] Error reloading ${modName}: ${e.message}`);
        }
      }
      return sendJson(res, 200, {
        ok: true,
        reloaded,
        timestamp: new Date().toISOString(),
        message: 'Hot monkey-patch applied successfully in flight.',
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Default fallback for any other Cloud Code endpoints: forward transparently
  const rawBuf = await readRawBody();
  return await forwardToGoogleCloudCode(req, res, rawBuf);
});

if (require.main === module) {
  // Ensure Antigravity MCP memory registration (checks and registers once on startup)
  try {
    const mcpStatus = ensureMcpRegistered();
    if (mcpStatus.registered) {
      console.info(`[Argon Gateway] MCP Integration: ${mcpStatus.reason}`);
    } else {
      console.info(`[Argon Gateway] MCP Integration: Active and healthy (${mcpStatus.reason})`);
    }
  } catch (err) {
    console.warn(`[Argon Gateway] MCP Integration notice: ${err.message}`);
  }

  server.listen(config.port, config.host, () => {
    console.info(`[geminUp JIGIT Gateway] Listening on http://${config.host}:${config.port} (Proxy: ${config.proxy || 'direct'})`);
    console.info(`[geminUp JIGIT Gateway] Mode: Native Antigravity Endpoints + JIGIT Engine Token Saver (ARGON Account Pool Disabled)`);
  });
}

module.exports = {
  extractToolsFromPayload,
  buildToolInstructionPrompt,
  extractToolCallsFromOutput,
  extractPromptFromAnyPayload,
  formatCloudCodeContentsToPrompt,
  ANTIGRAVITY_IDE_SYSTEM_PROMPT,
  server,
  pool,
};
