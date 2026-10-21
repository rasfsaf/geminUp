const crypto = require('node:crypto');

const MODEL_HEADER_KEY = 'x-goog-ext-525001261-jspb';
const GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const BATCH_PATH = '/_/BardChatUi/data/batchexecute';
const DEFAULT_METADATA = ['', '', '', null, null, null, null, null, null, ''];

function nested(value, path, fallback = undefined) {
  let current = value;
  for (const key of path) {
    if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), key)) return fallback;
    current = current[key];
  }
  return current === undefined ? fallback : current;
}

function buildModelHeader(modelId, capacity = 1, capacityField = 12) {
  if (!modelId) {
    return '[1,null,null,null,null,null,null,null,[4]]';
  }
  const header = [1, null, null, null, modelId, null, null, 0, [4]];
  while (header.length <= capacityField) header.push(null);
  header[capacityField] = capacity;
  return JSON.stringify(header);
}

function parseModelHeader(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ''));
  } catch (error) {
    throw new Error(`Gemini model header contains invalid JSON: ${error.message}`);
  }
  const modelId = parsed?.[4] || null;
  let capacityField = 12;
  if (parsed[13] !== null && parsed[13] !== undefined) capacityField = 13;
  const capacity = Number(parsed[capacityField]);
  return {
    modelId,
    capacity: Number.isFinite(capacity) ? capacity : 1,
    capacityField,
    value: JSON.stringify(parsed),
  };
}

function buildBatchRequest(rpcId, payload, session, requestId) {
  const params = new URLSearchParams({
    rpcids: rpcId,
    hl: session?.language || 'en',
    _reqid: String(requestId),
    rt: 'c',
    'source-path': '/app',
  });
  if (session?.buildLabel) params.set('bl', session.buildLabel);
  if (session?.sessionId) params.set('f.sid', session.sessionId);
  const body = new URLSearchParams({
    'f.req': JSON.stringify([[[rpcId, payload, null, 'generic']]]),
  });
  if (session?.accessToken) body.set('at', session.accessToken);
  return { params, body };
}

function buildGenerateRequest(prompt, modelHeader, session, requestId, options = {}) {
  if (!String(prompt || '').trim()) throw new Error('Gemini prompt is empty');

  const message = [prompt, 0, null, null, null, null, 0];
  const request = new Array(69).fill(null);
  request[0] = message;
  request[1] = [session?.language || 'en'];
  request[2] = options.metadata || DEFAULT_METADATA;
  request[6] = [1];
  request[7] = 1;
  request[10] = 1;
  request[11] = 0;
  request[17] = [[0]];
  request[18] = 0;
  request[27] = 1;
  request[30] = [4];
  request[41] = [1];
  request[45] = options.temporary === false ? null : 1;
  request[53] = 0;
  request[59] = crypto.randomUUID().toUpperCase();
  request[61] = [];
  request[68] = 2;

  // Antigravity Agent Mode quota activation:
  // action 12 = Antigravity (Agent Mode)
  // action 16 = Antigravity (Code Execution)
  request[49] = options.action !== undefined ? options.action : 12;

  const params = new URLSearchParams({
    hl: session?.language || 'en',
    _reqid: String(requestId),
    rt: 'c',
  });
  if (session?.buildLabel) params.set('bl', session.buildLabel);
  if (session?.sessionId) params.set('f.sid', session.sessionId);

  const body = new URLSearchParams({
    'f.req': JSON.stringify([null, JSON.stringify(request)]),
  });
  if (session?.accessToken) body.set('at', session.accessToken);

  const headers = {
    [MODEL_HEADER_KEY]: modelHeader || '[1,null,null,null,null,null,null,null,[4]]',
    'x-goog-ext-525005358-jspb': JSON.stringify([request[59], 1]),
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-73010990-jspb': '[0]',
  };

  return { params, body, headers };
}

function parsePageTokens(html) {
  const fields = {
    buildLabel: 'cfb2h',
    sessionId: 'FdrFJe',
    language: 'TuX5cc',
  };
  const result = {};
  const sourceHtml = String(html || '');
  const accessMatch = sourceHtml.match(/"SNlM0e"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (accessMatch) {
    try { result.accessToken = JSON.parse(`"${accessMatch[1]}"`); } catch { result.accessToken = accessMatch[1]; }
  }
  for (const [key, source] of Object.entries(fields)) {
    const match = sourceHtml.match(new RegExp(`"${source}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (!match) continue;
    try { result[key] = JSON.parse(`"${match[1]}"`); } catch { result[key] = match[1]; }
  }
  if (!result.accessToken) {
    throw new Error('Gemini /app did not return SNlM0e access token. The provided session cookie is expired or not logged in. Please log in to gemini.google.com and provide a fresh cookie.');
  }
  result.language = result.language || 'en';
  return result;
}

function extractAvailableModels(parts) {
  for (const part of parts || []) {
    const encoded = nested(part, [2]);
    if (typeof encoded !== 'string') continue;
    let body;
    try { body = JSON.parse(encoded); } catch { continue; }
    const legacyStatusCode = nested(body, [14]);
    const statusCode = Number.isInteger(legacyStatusCode)
      ? legacyStatusCode
      : (body[0] === 1 ? 1000 : null);
    const rawModels = nested(body, [15], []);
    if (!Array.isArray(rawModels)) continue;
    const tierFlags = Array.isArray(body[16]) ? body[16] : [];
    const capabilityFlags = Array.isArray(body[17]) ? body[17] : [];
    let capacity = 1;
    let capacityField = 12;
    if (tierFlags.includes(21)) capacityField = 13;
    else if (tierFlags.includes(22)) { capacity = 2; capacityField = 13; }
    else if (capabilityFlags.includes(115)) capacity = 4;
    else if (tierFlags.includes(16) || capabilityFlags.includes(106)) capacity = 3;
    else if (tierFlags.includes(8) || (!capabilityFlags.includes(106) && capabilityFlags.includes(19))) capacity = 2;
    return {
      statusCode,
      capacity,
      capacityField,
      models: rawModels.filter(Array.isArray).map((item) => ({
        id: String(item[0] || ''),
        displayName: String(item[1] || ''),
        description: String(item[2] || ''),
      })).filter((item) => item.id && item.displayName),
    };
  }
  return { statusCode: null, capacity: 1, capacityField: 12, models: [] };
}

module.exports = {
  BATCH_PATH,
  DEFAULT_METADATA,
  GENERATE_PATH,
  MODEL_HEADER_KEY,
  buildBatchRequest,
  buildGenerateRequest,
  buildModelHeader,
  extractAvailableModels,
  nested,
  parseModelHeader,
  parsePageTokens,
};
