const { nested } = require('./wire-format');

const GEMINI_QUOTA_RPC_ID = 'qpEbW';

const GEMINI_QUOTA_CONTEXTS = Object.freeze([
  { mode: null, action: 2, label: 'Chat (5h limit)' },
  { mode: 1, action: 2, label: 'Files' },
  { mode: 1, action: 4, label: 'Gemini Pro' },
  { mode: 6, action: 6, label: 'Gemini Thinking' },
  { mode: 1, action: 15, label: 'Deep Think' },
  { mode: null, action: 12, label: 'Antigravity (Agent mode)' },
  { mode: 1, action: 12, label: 'Antigravity (Agent Pro)' },
  { mode: 2, action: 12, label: 'Antigravity (Agent Premium)' },
  { mode: 7, action: 12, label: 'Antigravity (Agent Workspace)' },
  { mode: null, action: 16, label: 'Antigravity (Code Interpreter)' },
  { mode: 1, action: 16, label: 'Antigravity (Code Execution)' },
  { mode: 2, action: 16, label: 'Antigravity (Code Execution Pro)' },
  { mode: 7, action: 16, label: 'Antigravity (Code Execution Workspace)' },
]);

function quotaContextKey(mode, action, unit) {
  return `${mode ?? 'any'}:${action ?? 'any'}:${unit ?? 'unknown'}`;
}

function quotaContextLabel(mode, action) {
  return GEMINI_QUOTA_CONTEXTS.find((item) => item.mode === mode && item.action === action)?.label
    || `Mode ${mode ?? 'any'} / action ${action ?? 'any'}`;
}

function timestampToIso(value) {
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  if (Array.isArray(value)) {
    const seconds = Number(value[0]);
    const nanos = Number(value[1] || 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
    }
  }
  if (value && typeof value === 'object') {
    return timestampToIso(value.seconds ?? value.timestamp ?? value.value);
  }
  return null;
}

function normalizeQuotaItem(raw) {
  if (!Array.isArray(raw) || !Array.isArray(raw[0])) return null;
  const mode = Number.isInteger(raw[0][0]) ? raw[0][0] : null;
  const action = Number.isInteger(raw[0][1]) ? raw[0][1] : null;
  const unit = Number.isInteger(raw[1]) ? raw[1] : null;
  const usedAbsolute = Number(raw[2]);
  const resetAt = timestampToIso(raw[3]) || new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const limit = Number.isFinite(Number(raw[4])) ? Number(raw[4]) : null;
  const remaining = Number.isFinite(Number(raw[5])) ? Number(raw[5]) : null;
  if (action === null || !Number.isFinite(usedAbsolute)) return null;

  let usedPercent = 0;
  if (limit > 0) {
    usedPercent = (usedAbsolute / limit) * 100;
  } else if (remaining !== null && (usedAbsolute + remaining) > 0) {
    usedPercent = (usedAbsolute / (usedAbsolute + remaining)) * 100;
  } else {
    usedPercent = usedAbsolute;
  }

  const status = usedPercent >= 100 || remaining === 0
    ? 'exhausted' : usedPercent >= 90 ? 'warning' : 'available';
  return {
    key: quotaContextKey(mode, action, unit),
    label: quotaContextLabel(mode, action),
    mode,
    action,
    unit,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    remaining,
    limit,
    resetAt,
    status,
  };
}

function parseGeminiQuotaFrames(parts, now = Date.now()) {
  for (const part of parts || []) {
    const encoded = nested(part, [2]);
    if (typeof encoded !== 'string') continue;
    let body;
    try { body = JSON.parse(encoded); } catch { continue; }
    const rawCandidates = Array.isArray(body?.[0]) ? body[0] : (Array.isArray(body) ? body : []);
    const items = [];
    for (const rawItem of rawCandidates) {
      if (!Array.isArray(rawItem)) continue;
      const item = normalizeQuotaItem(rawItem);
      if (item) {
        items.push(item);
      } else {
        for (const subItem of rawItem) {
          const nestedItem = normalizeQuotaItem(subItem);
          if (nestedItem) items.push(nestedItem);
        }
      }
    }
    if (!items.length) continue;

    const status = items.some((item) => item.status === 'exhausted')
      ? 'exhausted' : items.some((item) => item.status === 'warning') ? 'warning' : 'available';
    return { status, updatedAt: new Date(now).toISOString(), items };
  }
  return { status: 'unknown', updatedAt: new Date(now).toISOString(), items: [] };
}

function buildQuotaPayload(contexts = GEMINI_QUOTA_CONTEXTS) {
  return JSON.stringify([contexts.map(({ mode, action }) => [mode, action])]);
}

module.exports = {
  GEMINI_QUOTA_CONTEXTS,
  GEMINI_QUOTA_RPC_ID,
  buildQuotaPayload,
  normalizeQuotaItem,
  parseGeminiQuotaFrames,
  quotaContextKey,
};
