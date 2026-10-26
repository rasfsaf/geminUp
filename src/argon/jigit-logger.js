/**
 * JIGIT Engine Diagnostic Logger & Compression Metrics
 * Tracks real-time token savings, compacted items (tools, logs, images), and formats clean inspection logs.
 * Maintains persistent cumulative statistics across sessions with automatic log rotation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function getLogDir() {
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const primary = path.join(programData, 'geminUp', 'argon', 'logs');
    try {
      if (!fs.existsSync(primary)) fs.mkdirSync(primary, { recursive: true });
      return primary;
    } catch (_) {}
  }
  const fallback = path.join(os.homedir(), '.geminup', 'argon', 'logs');
  try {
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch (_) {}
  return path.join(__dirname, '..', '..', 'logs');
}

const LOG_FILE = path.join(getLogDir(), 'compression.log');
const STATS_FILE = path.join(getLogDir(), 'cumulative_stats.json');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB max log size before rotation

// Load persistent cumulative statistics from disk
function loadCumulativeStats() {
  const defaults = {
    totalRuns: 0,
    totalItemsCompacted: 0,
    totalOriginalChars: 0,
    totalCompactedChars: 0,
    totalSavedChars: 0,
    totalSavedTokens: 0,
    overallReductionPct: '0.0%',
    updatedAt: new Date().toISOString(),
  };

  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      return { ...defaults, ...data };
    }
  } catch (_) {}

  return defaults;
}

const cumulativeStats = loadCumulativeStats();

function saveCumulativeStats() {
  try {
    const overallPct = cumulativeStats.totalOriginalChars > 0
      ? ((cumulativeStats.totalSavedChars / cumulativeStats.totalOriginalChars) * 100).toFixed(1)
      : '0.0';
    cumulativeStats.overallReductionPct = `${overallPct}%`;
    cumulativeStats.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(cumulativeStats, null, 2), 'utf8');
  } catch (_) {}
}

function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const keepBytes = 2 * 1024 * 1024; // Keep latest 2 MB
      const buf = Buffer.alloc(keepBytes);
      const fd = fs.openSync(LOG_FILE, 'r');
      fs.readSync(fd, buf, 0, keepBytes, stat.size - keepBytes);
      fs.closeSync(fd);

      let offset = 0;
      while (offset < 1000 && buf[offset] !== 0x0A) offset++;
      fs.writeFileSync(LOG_FILE, buf.slice(offset + 1));
    }
  } catch (_) {}
}

/**
 * Accurately estimates token count based on content characteristics and target LLM tokenizer.
 * SentencePiece (Gemini 256k) and BPE (Claude 128k/160k, OpenAI 200k) compress code and English at ~3.82 chars/token,
 * while Cyrillic/multilingual text compresses at ~2.80 chars/token.
 */
function estimateTokens(charCount, sampleText = '') {
  if (charCount <= 0) return 0;
  if (!sampleText || typeof sampleText !== 'string' || sampleText.length === 0) {
    return Math.round(charCount / 3.78);
  }

  const inspectLen = Math.min(sampleText.length, 2048);
  let cyrillicCount = 0;
  for (let i = 0; i < inspectLen; i++) {
    const code = sampleText.charCodeAt(i);
    if ((code >= 0x0400 && code <= 0x04FF) || (code >= 0x0500 && code <= 0x052F)) {
      cyrillicCount++;
    }
  }

  const cyrillicRatio = cyrillicCount / inspectLen;
  const effectiveCharsPerToken = (3.82 * (1 - cyrillicRatio)) + (2.80 * cyrillicRatio);
  return Math.round(charCount / effectiveCharsPerToken);
}

class CompressionTracker {
  constructor(options = {}) {
    this.conversationId = options.conversationId || 'unknown';
    this.chatTag = this.conversationId !== 'unknown' ? ` [${this.conversationId.slice(0, 8)}]` : '';
    this.timestamp = new Date();
    this.items = [];
    this.originalChars = 0;
    this.compactedChars = 0;
    this.savedChars = 0;
    this.savedTokens = 0;
    this.reductionPct = '0.0';
  }

  recordItem(item) {
    const orig = Number(item.originalSize) || 0;
    const comp = Number(item.compactedSize) || 0;
    const saved = Math.max(0, orig - comp);
    const tokens = estimateTokens(saved, item.sampleText || item.name || '');

    this.items.push({
      type: item.type || 'Generic',
      name: item.name || '',
      originalSize: orig,
      compactedSize: comp,
      savedChars: saved,
      savedTokens: tokens,
      reductionPct: orig > 0 ? ((saved / orig) * 100).toFixed(1) + '%' : '0.0%',
      capsuleId: item.capsuleId || '',
      details: item.details || '',
    });
  }

  finalize(originalChars, compactedChars) {
    this.originalChars = originalChars;
    this.compactedChars = compactedChars;
    this.savedChars = Math.max(0, originalChars - compactedChars);
    this.savedTokens = estimateTokens(this.savedChars);
    this.reductionPct = originalChars > 0
      ? ((this.savedChars / originalChars) * 100).toFixed(1)
      : '0.0';

    if (this.savedChars > 0 || this.items.length > 0) {
      cumulativeStats.totalRuns += 1;
      cumulativeStats.totalItemsCompacted += this.items.length;
      cumulativeStats.totalOriginalChars += this.originalChars;
      cumulativeStats.totalCompactedChars += this.compactedChars;
      cumulativeStats.totalSavedChars += this.savedChars;
      cumulativeStats.totalSavedTokens += this.savedTokens;
      saveCumulativeStats();
    }
  }

  formatSummary() {
    if (this.items.length === 0 && this.savedChars <= 0) {
      return `[Jewish Tokenizer]${this.chatTag} ✨ Context within safe limits. Zero overhead pass-through.`;
    }

    const lines = [];
    lines.push(
      `[Jewish Tokenizer]${this.chatTag} 💎 Compacted: ${this.items.length} items | ` +
      `${this.originalChars.toLocaleString()} -> ${this.compactedChars.toLocaleString()} chars ` +
      `(Saved ${this.savedChars.toLocaleString()} chars / ~${this.savedTokens.toLocaleString()} tokens, -${this.reductionPct}%)`
    );

    this.items.forEach((it, idx) => {
      const isLast = idx === this.items.length - 1;
      const prefix = isLast ? '   └──' : '   ├──';
      const label = it.name ? `[${it.type}: ${it.name}]` : `[${it.type}]`;
      const capTag = it.capsuleId ? ` [capsule: ${it.capsuleId}]` : '';
      const extra = it.details ? ` (${it.details})` : '';
      lines.push(
        `${prefix} ${label}${extra} ${it.originalSize.toLocaleString()} -> ${it.compactedSize.toLocaleString()} chars ` +
        `(-${it.reductionPct})${capTag}`
      );
    });

    return lines.join('\n');
  }

  writeToLogFile() {
    if (this.items.length === 0 && this.savedChars <= 0) return;
    try {
      rotateLogIfNeeded();

      const logRecord = {
        timestamp: this.timestamp.toISOString(),
        conversationId: this.conversationId,
        originalChars: this.originalChars,
        compactedChars: this.compactedChars,
        savedChars: this.savedChars,
        savedTokens: this.savedTokens,
        reductionPct: `${this.reductionPct}%`,
        itemsCount: this.items.length,
        items: this.items,
      };

      const entry = `${this.formatSummary()}\nJSON:${JSON.stringify(logRecord)}\n\n`;
      fs.appendFileSync(LOG_FILE, entry, 'utf8');
    } catch (_) {}
  }
}

function createCompressionTracker(options = {}) {
  return new CompressionTracker(options);
}

function logCompressionSummary(tracker) {
  if (!tracker) return;
  console.info(tracker.formatSummary());
  tracker.writeToLogFile();
}

function getCumulativeStats() {
  const overallPct = cumulativeStats.totalOriginalChars > 0
    ? ((cumulativeStats.totalSavedChars / cumulativeStats.totalOriginalChars) * 100).toFixed(1)
    : '0.0';
  return {
    ...cumulativeStats,
    overallReductionPct: `${overallPct}%`,
    logFilePath: LOG_FILE,
    statsFilePath: STATS_FILE,
  };
}

function resetCumulativeStats() {
  cumulativeStats.totalRuns = 0;
  cumulativeStats.totalItemsCompacted = 0;
  cumulativeStats.totalOriginalChars = 0;
  cumulativeStats.totalCompactedChars = 0;
  cumulativeStats.totalSavedChars = 0;
  cumulativeStats.totalSavedTokens = 0;
  cumulativeStats.overallReductionPct = '0.0%';
  saveCumulativeStats();
}

module.exports = {
  createCompressionTracker,
  logCompressionSummary,
  estimateTokens,
  getCumulativeStats,
  resetCumulativeStats,
  LOG_FILE,
  STATS_FILE,
};
