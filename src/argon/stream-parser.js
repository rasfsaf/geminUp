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
 * Supports character-domain UTF-16 length markers and multibyte UTF-8 payloads (Russian, CJK, emojis).
 */
function parseGoogleFrames(input) {
  let text = typeof input === 'string' ? input : (Buffer.isBuffer(input) ? input.toString('utf8') : String(input || ''));

  // Strip XSSI prefix )]}'
  if (text.startsWith(XSSI_PREFIX)) {
    text = text.slice(XSSI_PREFIX.length);
  }

  const frames = [];
  let pos = 0;

  while (pos < text.length) {
    // Skip any whitespace (spaces, newlines, carriage returns)
    while (pos < text.length && /\s/.test(text[pos])) {
      pos++;
    }
    if (pos >= text.length) break;

    // Read ASCII digit length marker
    let digitEnd = pos;
    while (digitEnd < text.length && text[digitEnd] >= '0' && text[digitEnd] <= '9') {
      digitEnd++;
    }
    if (digitEnd === pos) break;

    const charLen = parseInt(text.slice(pos, digitEnd), 10);
    let start = digitEnd;
    while (start < text.length && (text[start] === ' ' || text[start] === '\r')) {
      start++;
    }
    if (start < text.length && text[start] === '\n') {
      start++; // skip delimiter \n
    }

    let end = start + charLen;
    if (end > text.length) {
      // Incomplete frame, wait for next network packet
      break;
    }

    let rawStr = text.slice(start, end).trim();
    let parsed = null;
    let actualEnd = end;

    try {
      parsed = JSON.parse(rawStr);
    } catch {
      // Fuzzy boundary adjustment for variations in length calculation
      for (const off of [-1, 1, -2, 2, -3, 3]) {
        try {
          const altStr = text.slice(start, end + off).trim();
          parsed = JSON.parse(altStr);
          actualEnd = end + off;
          break;
        } catch {}
      }
    }

    if (parsed) {
      frames.push(parsed);
      pos = actualEnd;
    } else {
      // Robust fallback: search for envelope closing ']]'
      const bracketIdx = text.indexOf(']]', start);
      if (bracketIdx !== -1 && bracketIdx < start + charLen + 60) {
        try {
          parsed = JSON.parse(text.slice(start, bracketIdx + 2).trim());
          frames.push(parsed);
          pos = bracketIdx + 2;
        } catch {
          pos = end;
        }
      } else {
        pos = end;
      }
    }
  }

  const remainderStr = text.slice(pos);
  return {
    frames,
    remainder: Buffer.from(remainderStr, 'utf8'),
    remainderStr,
  };
}

function parseGeminiStream(frames) {
  let content = '';
  let thoughts = '';
  let metadata = null;
  let errorToThrow = null;

  for (const envelope of frames) {
    // Envelope can be [[...]] or [...]
    const parts = Array.isArray(envelope) ? (Array.isArray(envelope[0]) ? envelope : [envelope]) : [];
    for (const part of parts) {
      if (!Array.isArray(part)) continue;

      // Extract error codes (e.g. 1155 overloaded, 1037 quota)
      const errorCode = Number(nested(part, [5, 2, 0, 1, 0], 0));
      if (errorCode) {
        errorToThrow = createStreamError(errorCode);
        if (errorCode !== 1100) throw errorToThrow;
      }

      const encoded = part[2];
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
  }

  return { content, thoughts, metadata, error: errorToThrow };
}

module.exports = {
  createStreamError,
  parseGoogleFrames,
  parseGeminiStream,
};
