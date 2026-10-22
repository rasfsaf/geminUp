const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const COOLDOWN_MS = 3 * 60 * 1000; // 3-minute cooldown between keep-alive pings across accounts
const IDLE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours (keeps Google __Secure-1PSIDTS rolling token alive)
const TICK_INTERVAL_MS = 30 * 1000; // Check state every 30 seconds

class KeepAliveManager {
  constructor(accountPool, options = {}) {
    this.pool = accountPool;
    this.storagePath = options.statePath || this.getDefaultStatePath();
    this.cooldownMs = options.cooldownMs || COOLDOWN_MS;
    this.idleIntervalMs = options.idleIntervalMs || IDLE_INTERVAL_MS;
    this.timer = null;
    this.isProcessing = false;
    this.state = {
      version: 1,
      bootTime: this.estimateBootTime(),
      lastHeartbeat: new Date().toISOString(),
      lastShutdown: null,
      lastRequestSentAt: null,
      recentEvents: [],
    };
    this.loadState();
    this.initProcessHooks();
  }

  getDefaultStatePath() {
    const baseDir = this.pool.storagePath
      ? path.dirname(this.pool.storagePath)
      : (process.env.ProgramData ? path.join(process.env.ProgramData, 'geminUp', 'argon') : __dirname);
    return path.join(baseDir, 'keepalive-state.json');
  }

  estimateBootTime() {
    const uptimeSec = os.uptime();
    return new Date(Date.now() - uptimeSec * 1000).toISOString();
  }

  loadState() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.state = {
          ...this.state,
          ...parsed,
        };

        // Detect system downtime / sleep / reboot since last heartbeat
        const lastHb = Date.parse(this.state.lastHeartbeat || 0);
        if (lastHb > 0) {
          const gapMs = Date.now() - lastHb;
          if (gapMs > 2 * 60 * 1000) {
            const gapMin = Math.round(gapMs / 60000);
            const eventMsg = `System resume detected. PC downtime/sleep: ${gapMin} min.`;
            console.info(`[Argon KeepAlive] ${eventMsg}`);
            this.state.recentEvents = this.state.recentEvents || [];
            this.state.recentEvents.unshift({
              type: 'system_resume',
              downtimeMinutes: gapMin,
              resumedAt: new Date().toISOString(),
            });
            if (this.state.recentEvents.length > 20) this.state.recentEvents.pop();
          }
        }
      }
    } catch (err) {
      console.warn(`[Argon KeepAlive] Could not read ${this.storagePath}: ${err.message}`);
    }
    this.state.lastHeartbeat = new Date().toISOString();
    this.saveState();
  }

  saveState() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      console.error(`[Argon KeepAlive] Failed to write state: ${err.message}`);
    }
  }

  initProcessHooks() {
    const onExit = () => {
      this.state.lastShutdown = new Date().toISOString();
      this.state.lastHeartbeat = new Date().toISOString();
      this.saveState();
    };
    process.on('SIGINT', () => { onExit(); process.exit(0); });
    process.on('SIGTERM', () => { onExit(); process.exit(0); });
    process.on('beforeExit', onExit);
  }

  start() {
    if (this.timer) return;
    console.info(`[Argon KeepAlive] 24h idle account health manager active (Cooldown: ${Math.round(this.cooldownMs / 60000)}m).`);
    // Run initial tick immediately
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    const now = Date.now();

    // Detect sleep/wake gap on running timer
    const lastHb = Date.parse(this.state.lastHeartbeat || 0);
    if (lastHb > 0 && (now - lastHb) > 2 * 60 * 1000) {
      const gapMin = Math.round((now - lastHb) / 60000);
      console.info(`[Argon KeepAlive] System wake detected during operation (Gap: ${gapMin} min).`);
      this.state.recentEvents = this.state.recentEvents || [];
      this.state.recentEvents.unshift({
        type: 'sleep_wake',
        downtimeMinutes: gapMin,
        resumedAt: new Date(now).toISOString(),
      });
      if (this.state.recentEvents.length > 20) this.state.recentEvents.pop();
    }
    this.state.lastHeartbeat = new Date(now).toISOString();
    this.saveState();

    if (this.isProcessing) return;

    // Check cooldown since the last keepalive request
    const lastSent = Date.parse(this.state.lastRequestSentAt || 0) || 0;
    const timeSinceLast = now - lastSent;
    if (timeSinceLast < this.cooldownMs) {
      // Cooldown in progress
      return;
    }

    // Find accounts due for keepalive
    const dueAccounts = this.getDueAccounts(now);
    if (dueAccounts.length === 0) return;

    // Pick the most overdue account (FIFO / oldest activity)
    const target = dueAccounts[0];
    this.isProcessing = true;

    try {
      console.info(`[Argon KeepAlive] Sending scheduled 24h health check for idle account "${target.label}" (${target.id})...`);
      this.state.lastRequestSentAt = new Date().toISOString();
      this.saveState();

      await this.pool.refreshAccountSession(target);

      target.lastKeepAliveAt = new Date().toISOString();
      target.updatedAt = new Date().toISOString();
      this.pool.save();

      console.info(`[Argon KeepAlive] Account "${target.label}" health check OK. Next check cooldown: ${Math.round(this.cooldownMs / 60000)}m.`);
    } catch (err) {
      console.warn(`[Argon KeepAlive] Health check failed for "${target.label}": ${err.message}`);
    } finally {
      this.isProcessing = false;
      this.saveState();
    }
  }

  getDueAccounts(now = Date.now()) {
    const list = [];
    for (const acc of this.pool.accounts) {
      // Ignore permanently broken accounts
      if (acc.status === 'error') continue;

      // Calculate timestamp of last activity (either actual request, keepalive, or creation)
      const lastUsed = Date.parse(acc.lastUsedAt || 0) || 0;
      const lastKa = Date.parse(acc.lastKeepAliveAt || 0) || 0;
      const created = Date.parse(acc.createdAt || 0) || 0;
      const lastActivity = Math.max(lastUsed, lastKa, created);

      const elapsedMs = now - lastActivity;
      if (elapsedMs >= this.idleIntervalMs) {
        list.push({
          ...acc,
          lastActivity,
          elapsedHours: Math.round((elapsedMs / (3600 * 1000)) * 10) / 10,
        });
      }
    }

    // Sort by longest inactive first
    list.sort((a, b) => a.lastActivity - b.lastActivity);
    return list;
  }

  getStatus() {
    const now = Date.now();
    const lastSent = Date.parse(this.state.lastRequestSentAt || 0) || 0;
    const cooldownRemainingSec = Math.max(0, Math.ceil((this.cooldownMs - (now - lastSent)) / 1000));
    const dueAccounts = this.getDueAccounts(now);

    return {
      active: Boolean(this.timer),
      cooldownMinutes: Math.round(this.cooldownMs / 60000),
      cooldownRemainingSec,
      lastRequestSentAt: this.state.lastRequestSentAt,
      lastHeartbeat: this.state.lastHeartbeat,
      bootTime: this.state.bootTime,
      lastShutdown: this.state.lastShutdown,
      dueCount: dueAccounts.length,
      dueAccounts: dueAccounts.map((a) => ({ id: a.id, label: a.label, elapsedHours: a.elapsedHours })),
      recentEvents: (this.state.recentEvents || []).slice(0, 5),
    };
  }
}

module.exports = {
  KeepAliveManager,
  COOLDOWN_MS,
  IDLE_INTERVAL_MS,
};
