const http = require('node:http');
const crypto = require('node:crypto');
const { AccountPool, BASE_URL, USER_AGENT } = require('./account-pool');
const { createAgent, doRequest } = require('./http-client');
const {
  GENERATE_PATH,
  buildGenerateRequest,
  buildModelHeader,
} = require('./wire-format');
const {
  parseGoogleFrames,
  parseGeminiStream,
} = require('./stream-parser');

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

pool.startKeepAliveLoop();

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

function formatCloudCodeContentsToPrompt(contents, systemInstruction) {
  const parts = [];
  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    const sysTexts = systemInstruction.parts.map((p) => (typeof p === 'string' ? p : p.text || '')).filter(Boolean);
    if (sysTexts.length) parts.push(`[SYSTEM INSTRUCTION]\n${sysTexts.join('\n')}`);
  }
  if (Array.isArray(contents)) {
    for (const turn of contents) {
      const role = String(turn.role || 'user').toUpperCase();
      const textParts = [];
      for (const p of turn.parts || []) {
        if (typeof p === 'string') textParts.push(p);
        else if (p && p.text) textParts.push(p.text);
        else if (p && p.inlineData) textParts.push(`[Attached Data: ${p.inlineData.mimeType || 'binary'}]`);
        else if (p && p.functionCall) textParts.push(`[Tool Call: ${p.functionCall.name}(${JSON.stringify(p.functionCall.args || {})})]`);
        else if (p && p.functionResponse) textParts.push(`[Tool Result: ${p.functionResponse.name} -> ${JSON.stringify(p.functionResponse.response || {})}]`);
      }
      if (textParts.length > 0) {
        parts.push(`[${role}]\n${textParts.join('\n')}`);
      }
    }
  }
  return parts.join('\n\n');
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
  const prompt = formatMessagesToPrompt(bodyJson.messages);

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

      // Antigravity Agent Mode quota activation (action: 12)
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
        timeoutMs: 60000,
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

        upstreamRes.body.on('data', (chunk) => {
          streamRemainder += chunk.toString('utf8');
          const { frames, remainder } = parseGoogleFrames(streamRemainder);
          streamRemainder = remainder;

          if (frames.length > 0) {
            try {
              const parsed = parseGeminiStream(frames);
              if (parsed.content && parsed.content.length > accumulatedContent.length) {
                const deltaText = parsed.content.slice(accumulatedContent.length);
                accumulatedContent = parsed.content;

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
            } catch (pErr) {
              if (pErr.upstreamStatus === 429) {
                pool.markExhausted(account.id);
              }
            }
          }
        });

        upstreamRes.body.on('end', () => {
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

      account.lastUsedAt = new Date().toISOString();
      pool.save();

      return sendJson(res, 200, {
        id: cmplId,
        object: 'chat.completion',
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: parsed.content || '',
            },
            finish_reason: 'stop',
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

async function handleCloudCodeGenerateContent(req, res, bodyJson, isStream = true) {
  const modelName = bodyJson.model || 'gemini-4-argon';
  let prompt = '';
  if (Array.isArray(bodyJson.contents)) {
    prompt = formatCloudCodeContentsToPrompt(bodyJson.contents, bodyJson.systemInstruction);
  } else if (Array.isArray(bodyJson.messages)) {
    prompt = formatMessagesToPrompt(bodyJson.messages);
  } else if (typeof bodyJson.prompt === 'string') {
    prompt = bodyJson.prompt;
  }

  if (!prompt.trim()) {
    return sendError(res, 400, 'Cloud Code generateContent prompt/contents cannot be empty');
  }

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

      // Antigravity Agent Mode quota activation (action: 12)
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
        timeoutMs: 60000,
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

      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        let accumulatedContent = '';
        let streamRemainder = '';

        upstreamRes.body.on('data', (chunk) => {
          streamRemainder += chunk.toString('utf8');
          const { frames, remainder } = parseGoogleFrames(streamRemainder);
          streamRemainder = remainder;

          if (frames.length > 0) {
            try {
              const parsed = parseGeminiStream(frames);
              if (parsed.content && parsed.content.length > accumulatedContent.length) {
                const deltaText = parsed.content.slice(accumulatedContent.length);
                accumulatedContent = parsed.content;

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
                res.write(`data: ${JSON.stringify(ccDelta)}\n\n`);
              }
            } catch (pErr) {
              if (pErr.upstreamStatus === 429) {
                pool.markExhausted(account.id);
              }
            }
          }
        });

        upstreamRes.body.on('end', () => {
          const finalCc = {
            response: {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [],
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
          res.write(`data: ${JSON.stringify(finalCc)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });

        upstreamRes.body.on('error', (err) => {
          console.error(`[Argon Gateway] Cloud Code stream error: ${err.message}`);
          res.end();
        });

        account.lastUsedAt = new Date().toISOString();
        pool.save();
        return;
      }

      const fullText = await upstreamRes.text();
      const { frames } = parseGoogleFrames(fullText);
      const parsed = parseGeminiStream(frames);

      account.lastUsedAt = new Date().toISOString();
      pool.save();

      return sendJson(res, 200, {
        response: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: parsed.content || '' }],
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
        return sendError(res, 429, 'All accounts exhausted during failover.', 'quota_exhausted');
      }
    }
  }

  return sendError(res, 502, 'Failed to complete Cloud Code generation after exhausting failover pool.', 'upstream_error');
}

// HTTP Server
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

  // Read request body helper
  const readBody = () => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });

  // Chat completions
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    try {
      const body = await readBody();
      return await handleChatCompletions(req, res, body);
    } catch (err) {
      return sendError(res, 400, err.message);
    }
  }

  // Antigravity Cloud Code Protocol: fetchAvailableModels
  if ((req.method === 'GET' || req.method === 'POST') && (pathname === '/v1internal:fetchAvailableModels' || pathname.endsWith(':fetchAvailableModels'))) {
    return sendJson(res, 200, CLOUD_CODE_CATALOG);
  }

  // Antigravity Cloud Code Protocol: loadCodeAssist
  if (req.method === 'POST' && (pathname === '/v1internal:loadCodeAssist' || pathname.endsWith(':loadCodeAssist'))) {
    return sendJson(res, 200, {
      userTier: {
        id: 'tier_enterprise_unlocked',
        name: 'Antigravity Pro (geminUp Unlocked)',
        description: 'Autonomous Agent Mode Enabled',
      },
      currentTier: 'tier_enterprise_unlocked',
      ineligible: false,
      allowedModelIds: [
        'gemini-4-argon',
        'gemini-4-argon-thinking-medium',
        'gemini-3.8-flash',
        'gemini-3.1-pro',
        'claude-sonnet-4-6',
        'claude-sonnet-4',
      ],
    });
  }

  // Antigravity Cloud Code Protocol: retrieveUserQuotaSummary / retrieveUserQuota
  if (req.method === 'POST' && (pathname === '/v1internal:retrieveUserQuotaSummary' || pathname === '/v1internal:retrieveUserQuota' || pathname.includes(':retrieveUserQuota'))) {
    return sendJson(res, 200, {
      buckets: [
        {
          quotaType: 'QUOTA_TYPE_AGENT',
          remainingFraction: 1.0,
          resetTime: '2099-01-01T00:00:00Z',
        },
        {
          quotaType: 'QUOTA_TYPE_CHAT',
          remainingFraction: 1.0,
          resetTime: '2099-01-01T00:00:00Z',
        },
      ],
    });
  }

  // Antigravity Cloud Code Protocol: countTokens
  if (req.method === 'POST' && (pathname === '/v1internal:countTokens' || pathname.endsWith(':countTokens'))) {
    try {
      const body = await readBody();
      const promptLen = JSON.stringify(body).length;
      return sendJson(res, 200, { totalTokens: Math.max(1, Math.round(promptLen / 4)) });
    } catch {
      return sendJson(res, 200, { totalTokens: 100 });
    }
  }

  // Antigravity Cloud Code Protocol: streamGenerateContent / generateContent
  if (req.method === 'POST' && (pathname === '/v1internal:streamGenerateContent' || pathname === '/v1internal:generateContent' || pathname.endsWith(':streamGenerateContent') || pathname.endsWith(':generateContent'))) {
    try {
      const body = await readBody();
      const isStream = parsedUrl.searchParams.get('alt') === 'sse' || pathname.includes('streamGenerateContent');
      return await handleCloudCodeGenerateContent(req, res, body, isStream);
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
    });
  }

  // Admin API: Add Account
  if (req.method === 'POST' && (pathname === '/admin/api/accounts' || pathname === '/admin/api/cookies')) {
    try {
      const body = await readBody();
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

  return sendError(res, 404, `Endpoint ${req.method} ${pathname} not found`);
});

server.listen(config.port, config.host, () => {
  console.info(`[Argon Gateway] Listening on http://${config.host}:${config.port}/v1 (Proxy: ${config.proxy || 'direct'})`);
  console.info(`[Argon Gateway] Pool loaded: ${pool.accounts.length} account(s), Active: ${pool.activeAccountId || 'None'}`);
});
