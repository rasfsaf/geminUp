/**
 * JIGIT Capsule Store
 * Persistent LRU storage for compacted conversation turns, tool outputs, and build logs.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function getCapsuleDir() {
  const custom = process.env.ARGON_CAPSULE_DIR;
  if (custom) return custom;
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const dir = path.join(programData, 'geminUp', 'argon', 'capsules');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    const fallback = path.join(os.tmpdir(), 'geminUp', 'argon', 'capsules');
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  return dir;
}

const MAX_CAPSULES = 200;

function saveCapsule(capsuleId, content, metadata = {}) {
  if (!capsuleId || typeof content !== 'string') return;
  try {
    const dir = getCapsuleDir();
    const filePath = path.join(dir, `${capsuleId}.json`);
    const record = {
      id: capsuleId,
      category: metadata.category || 'General',
      filepath: metadata.filepath || null,
      length: content.length,
      timestamp: Date.now(),
      content,
    };
    fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');
    pruneOldCapsules(dir);
  } catch (err) {
    // Non-blocking: fail quietly if disk is full or read-only
  }
}

function getCapsule(capsuleId) {
  if (!capsuleId) return null;
  try {
    const dir = getCapsuleDir();
    const filePath = path.join(dir, `${capsuleId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data;
    }
  } catch (err) {
    return null;
  }
  return null;
}

function listCapsules(limit = 20) {
  try {
    const dir = getCapsuleDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const items = [];
    for (const f of files) {
      try {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        const raw = fs.readFileSync(full, 'utf8');
        const parsed = JSON.parse(raw);
        items.push({
          id: parsed.id,
          category: parsed.category,
          filepath: parsed.filepath,
          length: parsed.length,
          timestamp: parsed.timestamp || stat.mtimeMs,
          preview: parsed.content ? parsed.content.slice(0, 200).replace(/[\r\n]+/g, ' ') : '',
        });
      } catch (e) {
        // Skip corrupted item
      }
    }
    items.sort((a, b) => b.timestamp - a.timestamp);
    return items.slice(0, limit);
  } catch (err) {
    return [];
  }
}

function searchCapsules(query, limit = 5) {
  if (!query) return [];
  const q = String(query).toLowerCase();
  try {
    const dir = getCapsuleDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const matched = [];
    for (const f of files) {
      try {
        const full = path.join(dir, f);
        const raw = fs.readFileSync(full, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.content && parsed.content.toLowerCase().includes(q)) {
          matched.push({
            id: parsed.id,
            category: parsed.category,
            filepath: parsed.filepath,
            length: parsed.length,
            timestamp: parsed.timestamp,
            matchSnippet: extractSnippet(parsed.content, q),
          });
          if (matched.length >= limit) break;
        }
      } catch (e) {}
    }
    return matched;
  } catch (err) {
    return [];
  }
}

function extractSnippet(text, query) {
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text.slice(0, 300);
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + query.length + 150);
  return (start > 0 ? '...' : '') + text.slice(start, end).replace(/[\r\n]+/g, ' ') + (end < text.length ? '...' : '');
}

function pruneOldCapsules(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length <= MAX_CAPSULES) return;
    const stats = files.map((f) => ({
      file: f,
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }));
    stats.sort((a, b) => a.mtime - b.mtime);
    const toRemove = stats.slice(0, files.length - MAX_CAPSULES);
    for (const item of toRemove) {
      try {
        fs.unlinkSync(path.join(dir, item.file));
      } catch (e) {}
    }
  } catch (err) {}
}

module.exports = {
  getCapsuleDir,
  saveCapsule,
  getCapsule,
  listCapsules,
  searchCapsules,
};
