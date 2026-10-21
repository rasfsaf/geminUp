const { nested } = require('./wire-format');

const XSSI_PREFIX = ")]}'";

const ERROR_MESSAGES = new Map([
  [1013, 'Gemini temporarily unable to process request'],
  [1037, 'Gemini quota exhausted for this model / account'],
  [1050, 'Gemini rejected model change inside conversation history'],
  [1052, 'Gemini rejected model header'],
  [1060, 'Gemini IP temporarily blocked or restricted'],
  [1076, 'Gemini rejected media attachment in request'],
  [1096, 'Gemini session authentication expired; re-authorization required'],
  [1155, 'Gemini model temporarily overloaded'],
]);

function createStreamError(code) {
  const message = ERROR_MESSAGES.get(code) || `Gemini upstream returned error code ${code}`;
  const error = new Error(message);
  error.upstreamCode = code;
  if (code === 1037) error.upstreamStatus = 429;
  else if (code === 1013 || code === 1155) error.upstreamStatus = 503;
  else if (code === 1096) error.upstreamStatus = 401;
  else error.upstreamStatus = 400;
  return error;
}

function parseGoogleFrames(input) {
  let buffer = String(input || '');
  if (buffer.startsWith(XSSI_PREFIX)) buffer = buffer.slice(XSSI_PREFIX.length).trimStart();
  const frames = [];
  let position = 0;
  while (position < buffer.length) {
    while (/\s/.test(buffer[position] || '')) position += 1;
    if (position >= buffer.length) break;
    const marker = /^(\d+)/.exec(buffer.slice(position));
    if (!marker) {
      break;
    }
    const length = Number(marker[1]);
    const start = position + marker[1].length;
    const end = start + length;
    if (end > buffer.length) {
      // Incomplete frame, wait for next network packet
      break;
    }
    const raw = buffer.slice(start, end).trim();
    position = end;
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) frames.push(...parsed);
    else frames.push(parsed);
  }
  return { frames, remainder: buffer.slice(position) };
}

function parseGeminiStream(frames) {
  let content = '';
  let thoughts = '';
  let metadata = null;
  let errorToThrow = null;

  for (const part of frames) {
    const errorCode = Number(nested(part, [5, 2, 0, 1, 0], 0));
    if (errorCode) {
      errorToThrow = createStreamError(errorCode);
      if (errorCode !== 1100) throw errorToThrow;
    }

    const encoded = nested(part, [2]);
    if (typeof encoded !== 'string') continue;
    let payload;
    try { payload = JSON.parse(encoded); } catch { continue; }

    if (Array.isArray(payload[1])) metadata = payload[1];
    const candidates = Array.isArray(payload[4]) ? payload[4] : [];
    for (const candidate of candidates) {
      const candidateText = nested(candidate, [1, 0], '');
      const candidateThoughts = nested(candidate, [37, 0, 0], '');
      if (typeof candidateText === 'string' && candidateText.length >= content.length) {
        content = candidateText;
      }
      if (typeof candidateThoughts === 'string' && candidateThoughts.length >= thoughts.length) {
        thoughts = candidateThoughts;
      }
    }
  }

  return { content, thoughts, metadata, error: errorToThrow };
}

module.exports = {
  createStreamError,
  parseGoogleFrames,
  parseGeminiStream,
};
