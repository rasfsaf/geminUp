/**
 * JIGIT Engine Diagnostic Logger & Compression Metrics
 * Tracks real-time token savings, compacted items (tools, logs, images), and formats clean inspection logs.
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

// Cumulative in-memory statistics
const cumulativeStats = {
  totalRuns: 0,
  totalItemsCompacted: 0,
  totalOriginalChars: 0,
  totalCompactedChars: 0,
  totalSavedChars: 0,
  totalSavedTokens: 0,
};

/**
 * Calibrated token heuristics for modern Antigravity model families:
 * - Gemini 3.1 Pro / 3.8 Flash / Gemini 4 Argon: ~4.1 chars/tok code, ~3.1 chars/tok ru
 * - Claude Sonnet 4.6 / Opus 4.6 (thinking): ~3.75 chars/tok code, ~2.7 chars/tok ru
 * - Claude 5.5 family (next-gen BPE 160k): ~3.82 chars/tok code, ~2.85 chars/tok ru
 * - GPT-OSS-120B (o200k): ~3.95 chars/tok code, ~2.9 chars/tok ru
 *
 * Weighted composite ratio:
 * - Pure code / ASCII / JSON / CLI tool output: 3.82 chars/token
 * - Cyrillic / Multilingual text: 2.80 chars/token
 */
function estimateTokensFromChars(charCount, sampleText = '') {
  if (!charCount || charCount <= 0) return 0;
  if (!sampleText || typeof sampleText !== 'string' || sampleText.length === 0) {
    // Default weighted blend for tool/file dumps (95% code/ASCII, 5% text)
    return Math.round(charCount / 3.78);
  }

  // Sample inspection up to first 2048 chars for character distribution
  const inspectLen = Math.min(sampleText.length, 2048);
  let cyrillicCount = 0;
  for (let i = 0; i < inspectLen; i++) {
    const code = sampleText.charCodeAt(i);
    if ((code >= 0x0400 && code <= 0x04FF) || (code >= 0x0500 && code <= 0x052F)) {
      cyrillicCount++;
    }
  }

  const cyrillicRatio = cyrillicCount / inspectLen;
  // Blend: code (3.82) vs cyrillic (2.80)
  const effectiveCharsPerToken = (3.82 * (1 - cyrillicRatio)) + (2.80 * cyrillicRatio);
  return Math.round(charCount / effectiveCharsPerToken);
}

class CompressionTracker {
  constructor(options = {}) {
    this.conversationId = options.conversationId || 'default';
    this.chatTag = options.conversationId ? ` [Chat: ${options.conversationId.slice(0, 8)}]` : '';
    this.originalChars = 0;
    this.compactedChars = 0;
    this.items = [];
    this.timestamp = new Date();
  }

  recordItem(item) {
    // item: { type, name, originalSize, compactedSize, capsuleId, details, sampleText }
    const saved = Math.max(0, item.originalSize - item.compactedSize);
    const pct = item.originalSize > 0 ? ((saved / item.originalSize) * 100).toFixed(1) : '0.0';
    const estimatedSavedTokens = estimateTokensFromChars(saved, item.sampleText || item.details || '');
    this.items.push({
      type: item.type || 'Item',
      name: item.name || '',
      originalSize: item.originalSize,
      compactedSize: item.compactedSize,
      savedChars: saved,
      savedTokens: estimatedSavedTokens,
      reductionPct: `${pct}%`,
      capsuleId: item.capsuleId || '',
      details: item.details || '',
    });
  }

  finalize(originalTotal, compactedTotal) {
    this.originalChars = originalTotal;
    this.compactedChars = compactedTotal;
    this.savedChars = Math.max(0, originalTotal - compactedTotal);

    let itemsSavedTokens = 0;
    for (const it of this.items) {
      itemsSavedTokens += it.savedTokens || 0;
    }
    this.savedTokens = itemsSavedTokens > 0
      ? itemsSavedTokens
      : estimateTokensFromChars(this.savedChars);

    this.reductionPct = originalTotal > 0
      ? ((this.savedChars / originalTotal) * 100).toFixed(1)
      : '0.0';

    if (this.savedChars > 0 || this.items.length > 0) {
      cumulativeStats.totalRuns++;
      cumulativeStats.totalItemsCompacted += this.items.length;
      cumulativeStats.totalOriginalChars += this.originalChars;
      cumulativeStats.totalCompactedChars += this.compactedChars;
      cumulativeStats.totalSavedChars += this.savedChars;
      cumulativeStats.totalSavedTokens += this.savedTokens;
    }
  }

  getSummaryString() {
    if (this.items.length === 0 && this.savedChars <= 0) {
      return `[Jewish Tokenizer]${this.chatTag} No reduction needed (payload within baseline limits)`;
    }

    const lines = [];
    lines.push(
      `[Jewish Tokenizer]${this.chatTag} ✂️ Compacted: ${this.items.length} items | ` +
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
        `${prefix} ${label}${extra} ${it.originalSize.toLocaleString()} -> ${it.compactedSize.toLocaleString()} chars (-${it.reductionPct})${capTag}`
      );
    });

    return lines.join('\n');
  }

  writeToLogFile() {
    if (this.items.length === 0 && this.savedChars <= 0) return;
    try {
      const logDir = path.dirname(LOG_FILE);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

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

      const entry = `[${logRecord.timestamp}] ${this.getSummaryString()}\nJSON:${JSON.stringify(logRecord)}\n\n`;
      fs.appendFileSync(LOG_FILE, entry, 'utf8');
    } catch (_) {}
  }
}

function createCompressionTracker(options = {}) {
  return new CompressionTracker(options);
}

function logCompressionSummary(tracker) {
  if (!tracker) return;
  const summary = tracker.getSummaryString();
  console.info(summary);
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
  };
}

function resetCumulativeStats() {
  cumulativeStats.totalRuns = 0;
  cumulativeStats.totalItemsCompacted = 0;
  cumulativeStats.totalOriginalChars = 0;
  cumulativeStats.totalCompactedChars = 0;
  cumulativeStats.totalSavedChars = 0;
  cumulativeStats.totalSavedTokens = 0;
}

module.exports = {
  createCompressionTracker,
  logCompressionSummary,
  getCumulativeStats,
  resetCumulativeStats,
  estimateTokensFromChars,
  LOG_FILE,
};
