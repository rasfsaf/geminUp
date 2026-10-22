const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { doRequest } = require('./http-client');
const {
  BATCH_PATH,
  buildBatchRequest,
  extractAvailableModels,
  parsePageTokens,
} = require('./wire-format');
const {
  GEMINI_QUOTA_RPC_ID,
  buildQuotaPayload,
  parseGeminiQuotaFrames,
} = require('./quota');

const BASE_URL = 'https://gemini.google.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function getDefaultStoragePath() {
  if (process.env.ARGON_ACCOUNTS_FILE) {
    return process.env.ARGON_ACCOUNTS_FILE;
  }
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const targetDir = path.join(programData, 'geminUp', 'argon');
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    return path.join(targetDir, 'accounts.json');
  } catch {
    return path.join(__dirname, 'accounts.json');
  }
}

class AccountPool {
  constructor(options = {}) {
    this.storagePath = options.storagePath || getDefaultStoragePath();
    this.agent = options.agent || null;
    this.accounts = [];
    this.activeAccountId = null;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs || 15 * 60 * 1000; // 15 minutes
    this.keepAliveTimer = null;
    this.load();
  }

  setAgent(agent) {
    this.agent = agent;
  }

  load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
        this.activeAccountId = parsed.activeAccountId || (this.accounts[0]?.id || null);

        // Ensure each account has a baseline Antigravity Agent Mode quota record
        for (const acc of this.accounts) {
          if (!acc.quota) {
            acc.quota = { status: 'available', updatedAt: new Date().toISOString(), items: [] };
          }
          if (!Array.isArray(acc.quota.items)) {
            acc.quota.items = [];
          }
          let ag = acc.quota.items.find((x) => x.action === 12);
          if (!ag) {
            const served = acc.requestsServed || 0;
            const remaining = Math.max(0, 2400 - (served % 2400));
            ag = {
              key: 'any:12:12',
              label: 'Antigravity (Agent Mode)',
              mode: null,
              action: 12,
              unit: 12,
              usedPercent: Math.round(((2400 - remaining) / 2400) * 100),
              remaining,
              limit: 2400,
              status: acc.status === 'exhausted' ? 'exhausted' : 'available',
            };
            acc.quota.items.unshift(ag);
          } else if (ag.limit === 100) {
            ag.limit = 2400;
            ag.remaining = Math.max(0, 2400 - (acc.requestsServed || 0));
            ag.status = 'available';
          }
        }
      }
    } catch (err) {
      console.warn(`[Argon Pool] Could not load accounts from ${this.storagePath}: ${err.message}`);
      this.accounts = [];
      this.activeAccountId = null;
    }
  }

  save() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        version: 1,
        activeAccountId: this.activeAccountId,
        updatedAt: new Date().toISOString(),
        accounts: this.accounts,
      };
      fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Argon Pool] Failed to save accounts to ${this.storagePath}: ${err.message}`);
    }
  }

  parseCookieInput(input) {
    if (!input) throw new Error('Cookie input is empty');
    const cookies = [];

    let obj = null;
    if (typeof input === 'object' && input !== null) {
      obj = input;
    } else {
      let rawStr = String(input).trim();
      rawStr = rawStr.replace(/^\uFEFF/, '').trim();
      rawStr = rawStr.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
      rawStr = rawStr.replace(/^cookie:\s*/i, '').trim();

      // Check if input is a Netscape / curl format cookie file (tab-separated lines)
      if (rawStr.includes('# Netscape HTTP Cookie File') || (rawStr.includes('\t') && rawStr.split('\n').some(l => l.split('\t').length >= 7))) {
        const lines = rawStr.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const parts = line.split('\t');
          if (parts.length >= 7) {
            const domain = parts[0].trim();
            const pathVal = parts[2].trim() || '/';
            const expires = parseInt(parts[4].trim(), 10) || -1;
            const name = parts[5].trim();
            const value = parts.slice(6).join('\t').trim();
            if (name && value) {
              cookies.push({
                name,
                value,
                domain: domain || '.google.com',
                path: pathVal,
                expires,
              });
            }
          }
        }
      } else if (rawStr.startsWith('{') || rawStr.startsWith('[')) {
        try {
          obj = JSON.parse(rawStr);
        } catch { }
      }

      if (!obj && cookies.length === 0) {
        // Parse key=value; key2=value2
        const pairs = rawStr.split(';');
        for (const pair of pairs) {
          const idx = pair.indexOf('=');
          if (idx <= 0) continue;
          const name = pair.slice(0, idx).trim();
          const value = pair.slice(idx + 1).trim();
          if (name && value) {
            cookies.push({
              name,
              value,
              domain: '.google.com',
              path: '/',
              expires: -1,
            });
          }
        }
      }
    }

    if (obj) {
      const list = Array.isArray(obj) ? obj : (Array.isArray(obj.cookies) ? obj.cookies : []);
      for (const c of list) {
        if (c && c.name && c.value) {
          cookies.push({
            name: String(c.name).trim(),
            value: String(c.value).trim(),
            domain: String(c.domain || '.google.com'),
            path: String(c.path || '/'),
            expires: c.expires || -1,
          });
        }
      }
    }

    if (cookies.length === 0) {
      throw new Error('No valid cookies found in input');
    }

    return cookies;
  }

  buildCookieHeader(cookies) {
    if (!Array.isArray(cookies)) return '';
    const now = Date.now() / 1000;
    return cookies
      .filter((c) => !c.expires || c.expires < 0 || c.expires > now)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  absorbSetCookies(account, setCookieHeaders) {
    if (!setCookieHeaders || setCookieHeaders.length === 0) return false;
    let changed = false;
    account.cookies = account.cookies || [];

    for (const raw of setCookieHeaders) {
      const parts = raw.split(';').map((p) => p.trim());
      const sep = parts[0].indexOf('=');
      if (sep <= 0) continue;
      const name = parts[0].slice(0, sep).trim();
      const value = parts[0].slice(sep + 1).trim();

      const attrs = {};
      for (let i = 1; i < parts.length; i++) {
        const eq = parts[i].indexOf('=');
        if (eq === -1) attrs[parts[i].toLowerCase()] = true;
        else attrs[parts[i].slice(0, eq).toLowerCase()] = parts[i].slice(eq + 1);
      }

      const existingIdx = account.cookies.findIndex((c) => c.name === name);
      const newCookie = {
        name,
        value,
        domain: attrs.domain || '.google.com',
        path: attrs.path || '/',
        expires: attrs.expires ? Date.parse(attrs.expires) / 1000 : -1,
      };

      if (existingIdx >= 0) {
        if (account.cookies[existingIdx].value !== value) {
          account.cookies[existingIdx] = newCookie;
          changed = true;
        }
      } else {
        account.cookies.push(newCookie);
        changed = true;
      }
    }

    if (changed) {
      account.cookieString = this.buildCookieHeader(account.cookies);
      account.updatedAt = new Date().toISOString();
      this.save();
    }
    return changed;
  }

  async addAccount(input, label = '') {
    const cookies = this.parseCookieInput(input);
    const cookieString = this.buildCookieHeader(cookies);

    const hasSecure1Psid = cookies.some((c) => c.name === '__Secure-1PSID');
    const hasSapisid = cookies.some((c) => c.name === 'SAPISID');
    if (!hasSecure1Psid && !hasSapisid) {
      console.warn('[Argon Pool] Warning: Neither __Secure-1PSID nor SAPISID detected in provided cookie.');
    }

    const id = `acc_${crypto.randomBytes(4).toString('hex')}`;
    const account = {
      id,
      label: label.trim() || `Google Account ${this.accounts.length + 1}`,
      cookies,
      cookieString,
      session: null,
      quota: null,
      availableModels: [],
      status: 'standby',
      exhaustedUntil: null,
      errorReason: null,
      requestsServed: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      lastKeepAliveAt: null,
    };

    // Initialize session and verify with Google
    await this.refreshAccountSession(account);

    this.accounts.push(account);
    if (!this.activeAccountId) {
      this.activeAccountId = id;
      account.status = 'active';
    }
    this.save();
    return account;
  }

  removeAccount(id) {
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    this.accounts.splice(idx, 1);
    if (this.activeAccountId === id) {
      this.activeAccountId = this.accounts[0]?.id || null;
      if (this.activeAccountId) {
        const next = this.accounts.find((a) => a.id === this.activeAccountId);
        if (next && next.status === 'standby') next.status = 'active';
      }
    }
    this.save();
    return true;
  }

  async refreshAccountSession(account) {
    const cookieHeader = account.cookieString || this.buildCookieHeader(account.cookies);
    const headers = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en;q=0.9',
      'user-agent': USER_AGENT,
      cookie: cookieHeader,
    };

    // Step 1: GET /app to absorb rolling cookies and parse tokens
    const appRes = await doRequest(`${BASE_URL}/app`, {
      method: 'GET',
      headers,
      agent: this.agent,
      timeoutMs: 15000,
    });

    this.absorbSetCookies(account, appRes.rawCookies);

    if (appRes.status >= 400) {
      account.status = 'error';
      account.errorReason = `HTTP ${appRes.status} on /app`;
      this.save();
      throw new Error(`Failed to initialize account: HTTP ${appRes.status} on /app`);
    }

    const html = await appRes.text();
    const session = parsePageTokens(html);
    account.session = session;

    // Step 2: Fetch models (RPC otAQ7b)
    try {
      const modelsReq = buildBatchRequest('otAQ7b', '[]', session, 100000);
      const modelsRes = await doRequest(`${BASE_URL}${BATCH_PATH}?${modelsReq.params}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
          'user-agent': USER_AGENT,
          cookie: account.cookieString || this.buildCookieHeader(account.cookies),
        },
        body: modelsReq.body.toString(),
        agent: this.agent,
        timeoutMs: 15000,
      });

      this.absorbSetCookies(account, modelsRes.rawCookies);
      const modelsRaw = await modelsRes.text();
      const { frames } = require('./stream-parser').parseGoogleFrames(modelsRaw);
      const discovered = extractAvailableModels(frames);
      account.availableModels = discovered.models || [];
      account.modelCapacity = discovered.capacity || 1;
      account.modelCapacityField = discovered.capacityField || 12;
    } catch (mErr) {
      console.warn(`[Argon Pool] Account ${account.id} model discovery notice: ${mErr.message}`);
    }

    // Step 3: Fetch Quotas (RPC qpEbW)
    try {
      const quotaReq = buildBatchRequest(GEMINI_QUOTA_RPC_ID, buildQuotaPayload(), session, 100001);
      const quotaRes = await doRequest(`${BASE_URL}${BATCH_PATH}?${quotaReq.params}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
          'user-agent': USER_AGENT,
          cookie: account.cookieString || this.buildCookieHeader(account.cookies),
        },
        body: quotaReq.body.toString(),
        agent: this.agent,
        timeoutMs: 15000,
      });

      this.absorbSetCookies(account, quotaRes.rawCookies);
      const quotaRaw = await quotaRes.text();
      const { frames } = require('./stream-parser').parseGoogleFrames(quotaRaw);
      const parsedQuota = parseGeminiQuotaFrames(frames);
      const existingAg = account.quota?.items?.find((x) => x.action === 12);
      if (parsedQuota && Array.isArray(parsedQuota.items)) {
        if (existingAg && !parsedQuota.items.some((x) => x.action === 12)) {
          parsedQuota.items.unshift(existingAg);
        }
        account.quota = parsedQuota;
      }
    } catch (qErr) {
      console.warn(`[Argon Pool] Account ${account.id} quota check notice: ${qErr.message}`);
    }

    account.lastKeepAliveAt = new Date().toISOString();
    account.status = account.status === 'error' ? 'standby' : account.status;
    this.save();
    return account;
  }

  getActiveAccount() {
    const now = Date.now();

    // Check currently active account
    let current = this.accounts.find((a) => a.id === this.activeAccountId);
    if (current) {
      // Check if exhausted period has expired
      if (current.status === 'exhausted' && current.exhaustedUntil) {
        if (Date.parse(current.exhaustedUntil) <= now) {
          current.status = 'active';
          current.exhaustedUntil = null;
        }
      }

      if (current.status === 'active' || current.status === 'standby') {
        current.status = 'active';
        return current;
      }
    }

    // Failover: pick first available healthy standby account
    for (const acc of this.accounts) {
      if (acc.status === 'exhausted' && acc.exhaustedUntil) {
        if (Date.parse(acc.exhaustedUntil) <= now) {
          acc.status = 'standby';
          acc.exhaustedUntil = null;
        }
      }

      if (acc.status === 'standby') {
        this.activeAccountId = acc.id;
        acc.status = 'active';
        this.save();
        console.info(`[Argon Pool] Sticky failover switched active account to "${acc.label}" (${acc.id})`);
        return acc;
      }
    }

    return null;
  }

  markExhausted(accountId, resetAtIso = null) {
    const acc = this.accounts.find((a) => a.id === accountId);
    if (!acc) return;
    const resetTime = resetAtIso || new Date(Date.now() + 5 * 3600 * 1000).toISOString();
    acc.status = 'exhausted';
    acc.exhaustedUntil = resetTime;
    acc.updatedAt = new Date().toISOString();
    console.warn(`[Argon Pool] Account "${acc.label}" (${acc.id}) marked exhausted until ${resetTime}`);

    // Rotate active pointer to the next standby account if needed
    if (this.activeAccountId === accountId) {
      const next = this.accounts.find((a) => a.id !== accountId && a.status === 'standby');
      if (next) {
        this.activeAccountId = next.id;
        next.status = 'active';
        console.info(`[Argon Pool] Rotated active account to standby "${next.label}" (${next.id})`);
      } else {
        console.warn('[Argon Pool] All accounts in pool are currently exhausted or unavailable.');
      }
    }
    this.save();
  }

  markError(accountId, reason) {
    const acc = this.accounts.find((a) => a.id === accountId);
    if (!acc) return;
    acc.status = 'error';
    acc.errorReason = reason;
    acc.updatedAt = new Date().toISOString();
    console.warn(`[Argon Pool] Account "${acc.label}" (${acc.id}) marked error: ${reason}`);

    if (this.activeAccountId === accountId) {
      const next = this.accounts.find((a) => a.id !== accountId && (a.status === 'standby' || a.status === 'active'));
      if (next) {
        this.activeAccountId = next.id;
        next.status = 'active';
        console.info(`[Argon Pool] Errored active account rotated to "${next.label}" (${next.id})`);
      }
    }
    this.save();
  }

  rotateActiveAccount() {
    const available = this.accounts.filter((a) => a.status === 'active' || a.status === 'standby');
    if (available.length <= 1) return this.getActiveAccount();
    const currentIdx = available.findIndex((a) => a.id === this.activeAccountId);
    const nextIdx = (currentIdx + 1) % available.length;
    const next = available[nextIdx];
    this.activeAccountId = next.id;
    next.status = 'active';
    for (const a of available) {
      if (a.id !== next.id) a.status = 'standby';
    }
    this.save();
    console.info(`[Argon Pool] Explicitly rotated active account to "${next.label}" (${next.id})`);
    return next;
  }

  startKeepAliveLoop() {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(async () => {
      console.info('[Argon Pool] Running periodic session keep-alive heartbeat...');
      for (const acc of this.accounts) {
        try {
          await this.refreshAccountSession(acc);
          console.info(`[Argon Pool] Keep-alive OK for "${acc.label}" (${acc.id})`);
        } catch (err) {
          console.warn(`[Argon Pool] Keep-alive failed for "${acc.label}": ${err.message}`);
        }
      }
    }, this.keepAliveIntervalMs);
  }

  stopKeepAliveLoop() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  getStatus() {
    const active = this.accounts.find((a) => a.id === this.activeAccountId);
    return {
      totalAccounts: this.accounts.length,
      activeAccountId: this.activeAccountId,
      activeAccountLabel: active?.label || 'None',
      accounts: this.accounts.map((a) => ({
        id: a.id,
        label: a.label,
        status: a.status,
        exhaustedUntil: a.exhaustedUntil,
        modelsCount: a.availableModels?.length || 0,
        quota: a.quota,
        requestsServed: a.requestsServed || 0,
        lastKeepAliveAt: a.lastKeepAliveAt,
        lastUsedAt: a.lastUsedAt,
      })),
    };
  }
}

module.exports = {
  AccountPool,
  BASE_URL,
  USER_AGENT,
};
