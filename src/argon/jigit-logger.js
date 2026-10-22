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
    // item: { type, name, originalSize, compactedSize, capsuleId, details }
    const saved = Math.max(0, item.originalSize - item.compactedSize);
    const pct = item.originalSize > 0 ? ((saved / item.originalSize) * 100).toFixed(1) : '0.0';
    this.items.push({
      type: item.type || 'Item',
      name: item.name || '',
      originalSize: item.originalSize,
      compactedSize: item.compactedSize,
      savedChars: saved,
      savedTokens: Math.round(saved / 4),
      reductionPct: `${pct}%`,
      capsuleId: item.capsuleId || '',
      details: item.details || '',
    });
  }

  finalize(originalTotal, compactedTotal) {
    this.originalChars = originalTotal;
    this.compactedChars = compactedTotal;
    this.savedChars = Math.max(0, originalTotal - compactedTotal);
    this.savedTokens = Math.round(this.savedChars / 4);
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
  LOG_FILE,
};
