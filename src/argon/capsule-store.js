/**
 * JIGIT Capsule Store
 * Persistent LRU storage for compacted conversation turns, tool outputs, and build logs.
 * Supports per-conversation isolation so MCP memory is strictly scoped to the active chat session.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function getCapsuleDir() {
  const custom = process.env.ARGON_CAPSULE_DIR;
  let dir = custom;
  if (!dir) {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    dir = path.join(programData, 'geminUp', 'argon', 'capsules');
  }
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

const MAX_CAPSULES_PER_CONVO = 150;
const MAX_GLOBAL_CAPSULES = 300;

function setActiveConversation(conversationId) {
  if (!conversationId || typeof conversationId !== 'string') return;
  try {
    const dir = getCapsuleDir();
    const metaPath = path.join(dir, 'active_conversation.json');
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ conversationId, updatedAt: Date.now() }, null, 2),
      'utf8'
    );
  } catch (e) {}
}

function getActiveConversationId() {
  try {
    const dir = getCapsuleDir();
    const metaPath = path.join(dir, 'active_conversation.json');
    if (fs.existsSync(metaPath)) {
      const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (data && data.conversationId) return data.conversationId;
    }
  } catch (e) {}
  return null;
}

function saveCapsule(capsuleId, content, metadata = {}) {
  if (!capsuleId || typeof content !== 'string') return;
  try {
    const dir = getCapsuleDir();
    const convoId = metadata.conversationId || getActiveConversationId() || 'global';
    const convoDir = path.join(dir, convoId);
    if (!fs.existsSync(convoDir)) {
      fs.mkdirSync(convoDir, { recursive: true });
    }

    const record = {
      id: capsuleId,
      conversationId: convoId,
      category: metadata.category || 'General',
      filepath: metadata.filepath || null,
      length: content.length,
      timestamp: Date.now(),
      content,
    };
    const jsonStr = JSON.stringify(record);

    // Save in conversation folder
    fs.writeFileSync(path.join(convoDir, `${capsuleId}.json`), jsonStr, 'utf8');

    // Also save in root capsule dir for instant global lookup by capsuleId
    fs.writeFileSync(path.join(dir, `${capsuleId}.json`), jsonStr, 'utf8');

    pruneOldCapsules(convoDir, MAX_CAPSULES_PER_CONVO);
    pruneOldCapsules(dir, MAX_GLOBAL_CAPSULES);
  } catch (err) {
    // Non-blocking
  }
}

function getCapsule(capsuleId, conversationOrOptions = null) {
  if (!capsuleId) return null;
  const conversationId = typeof conversationOrOptions === 'string'
    ? conversationOrOptions
    : (conversationOrOptions && typeof conversationOrOptions === 'object' ? conversationOrOptions.conversationId : null);
  try {
    const dir = getCapsuleDir();

    // 1. Check conversation folder if provided
    if (conversationId && conversationId !== 'all' && conversationId !== '*') {
      const convoFile = path.join(dir, conversationId, `${capsuleId}.json`);
      if (fs.existsSync(convoFile)) {
        return JSON.parse(fs.readFileSync(convoFile, 'utf8'));
      }
    }

    // 2. Check root dir
    const rootFile = path.join(dir, `${capsuleId}.json`);
    if (fs.existsSync(rootFile)) {
      return JSON.parse(fs.readFileSync(rootFile, 'utf8'));
    }

    // 3. Fallback: check subdirectories
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const subFile = path.join(dir, ent.name, `${capsuleId}.json`);
        if (fs.existsSync(subFile)) {
          return JSON.parse(fs.readFileSync(subFile, 'utf8'));
        }
      }
    }
  } catch (err) {
    return null;
  }
  return null;
}

function listCapsules(limit = 20, conversationId = null) {
  try {
    const dir = getCapsuleDir();
    if (!fs.existsSync(dir)) return [];

    const convoId = conversationId || getActiveConversationId();
    let targetDir = dir;
    let filterConvo = false;

    if (convoId && convoId !== 'all' && convoId !== '*') {
      const specificDir = path.join(dir, convoId);
      if (fs.existsSync(specificDir)) {
        targetDir = specificDir;
      } else {
        filterConvo = true;
      }
    }

    const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.json') && f !== 'active_conversation.json');
    const items = [];

    for (const f of files) {
      try {
        const full = path.join(targetDir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) continue;
        const raw = fs.readFileSync(full, 'utf8');
        const parsed = JSON.parse(raw);
        if (filterConvo && parsed.conversationId && parsed.conversationId !== convoId) {
          continue;
        }
        items.push({
          id: parsed.id,
          conversationId: parsed.conversationId || convoId || 'global',
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

function searchCapsules(query, limit = 5, conversationId = null) {
  if (!query) return [];
  const q = String(query).toLowerCase();
  try {
    const dir = getCapsuleDir();
    if (!fs.existsSync(dir)) return [];

    const convoId = conversationId || getActiveConversationId();
    let targetDir = dir;
    let filterConvo = false;

    if (convoId && convoId !== 'all' && convoId !== '*') {
      const specificDir = path.join(dir, convoId);
      if (fs.existsSync(specificDir)) {
        targetDir = specificDir;
      } else {
        filterConvo = true;
      }
    }

    const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.json') && f !== 'active_conversation.json');
    const matched = [];

    for (const f of files) {
      try {
        const full = path.join(targetDir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) continue;
        const raw = fs.readFileSync(full, 'utf8');
        const parsed = JSON.parse(raw);
        if (filterConvo && parsed.conversationId && parsed.conversationId !== convoId) {
          continue;
        }
        if (parsed.content && parsed.content.toLowerCase().includes(q)) {
          matched.push({
            id: parsed.id,
            conversationId: parsed.conversationId || convoId || 'global',
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

function pruneOldCapsules(dir, max = MAX_GLOBAL_CAPSULES) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'active_conversation.json');
    if (files.length <= max) return;
    const stats = files.map((f) => ({
      file: f,
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }));
    stats.sort((a, b) => a.mtime - b.mtime);
    const toRemove = stats.slice(0, files.length - max);
    for (const item of toRemove) {
      try {
        fs.unlinkSync(path.join(dir, item.file));
      } catch (e) {}
    }
  } catch (err) {}
}

module.exports = {
  getCapsuleDir,
  setActiveConversation,
  getActiveConversationId,
  saveCapsule,
  getCapsule,
  listCapsules,
  searchCapsules,
};
