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

/**
 * Parses Google chunked wire format from Buffer or string.
 * CRITICAL: Google upstream wire format transmits byte-length markers, NOT character length.
 * Parsing in byte domain prevents multibyte UTF-8 characters (Russian, CJK, emoji) from truncating or crashing frames.
 */
function parseGoogleFrames(input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'utf8');

  // Strip XSSI prefix
  const xssiBytes = Buffer.from(XSSI_PREFIX);
  if (buf.length >= xssiBytes.length && buf.subarray(0, xssiBytes.length).equals(xssiBytes)) {
    buf = buf.subarray(xssiBytes.length);
  }

  const frames = [];
  let pos = 0;

  while (pos < buf.length) {
    // Skip whitespace (spaces, newlines, carriage returns, tabs)
    while (pos < buf.length && (buf[pos] === 32 || buf[pos] === 10 || buf[pos] === 13 || buf[pos] === 9)) {
      pos++;
    }
    if (pos >= buf.length) break;

    // Read ASCII digit length marker
    let digitEnd = pos;
    while (digitEnd < buf.length && buf[digitEnd] >= 48 && buf[digitEnd] <= 57) {
      digitEnd++;
    }
    if (digitEnd === pos) {
      break;
    }

    const length = parseInt(buf.subarray(pos, digitEnd).toString('ascii'), 10);
    // In Google wire format, the length marker is followed by optional whitespace / newline delimiter before payload
    let start = digitEnd;
    while (start < buf.length && (buf[start] === 32 || buf[start] === 10 || buf[start] === 13 || buf[start] === 9)) {
      start++;
    }
    const end = start + length;

    if (end > buf.length) {
      // Incomplete frame, wait for next network chunk
      break;
    }

    const frameBuf = buf.subarray(start, end);
    pos = end;

    const rawStr = frameBuf.toString('utf8').trim();
    if (!rawStr) continue;

    try {
      const parsed = JSON.parse(rawStr);
      frames.push(parsed);
    } catch {
      continue;
    }
  }

  const remainderBuf = buf.subarray(pos);
  return {
    frames,
    remainder: remainderBuf,
    // Provide string representation for backward compatibility
    remainderStr: remainderBuf.toString('utf8'),
  };
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
