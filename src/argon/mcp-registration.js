/**
 * Antigravity IDE MCP Auto-Registration & Health Check
 * Ensures 'jigit-memory' MCP server is configured in Antigravity's mcp_config.json.
 * On startup: checks once. If already healthy and valid, skips write. If missing/broken, registers.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function getAntigravityMcpConfigPaths() {
  const userHome = os.homedir();
  return [
    path.join(userHome, '.gemini', 'config', 'mcp_config.json'),
    path.join(userHome, '.gemini', 'antigravity', 'mcp_config.json'),
  ];
}

function getExpectedMcpServerScriptPath() {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const installedPath = path.join(programData, 'geminUp', 'argon', 'mcp-server.js');
  if (fs.existsSync(installedPath)) {
    return installedPath;
  }
  // Fallback to local source path if running in dev repo
  return path.resolve(__dirname, 'mcp-server.js');
}

/**
 * Validates and updates Antigravity IDE mcp_config.json
 * @returns {{ registered: boolean, reason: string }}
 */
function ensureMcpRegistered() {
  const targetScript = getExpectedMcpServerScriptPath();
  const configPaths = getAntigravityMcpConfigPaths();

  let modifiedAny = false;
  let statusMessage = 'Healthy';

  for (const cfgPath of configPaths) {
    try {
      // Resolve symlink if present
      let realPath = cfgPath;
      if (fs.existsSync(cfgPath)) {
        try {
          const stat = fs.lstatSync(cfgPath);
          if (stat.isSymbolicLink()) {
            realPath = fs.realpathSync(cfgPath);
          }
        } catch (e) {}
      }

      const dir = path.dirname(realPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let config = { mcpServers: {} };
      if (fs.existsSync(realPath)) {
        const raw = fs.readFileSync(realPath, 'utf8').trim();
        if (raw) {
          try {
            config = JSON.parse(raw);
          } catch (e) {
            config = { mcpServers: {} };
          }
        }
      }

      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        config.mcpServers = {};
      }

      const existing = config.mcpServers['jigit-memory'];
      const isHealthy =
        existing &&
        existing.command === 'node' &&
        Array.isArray(existing.args) &&
        existing.args[0] === targetScript;

      if (isHealthy) {
        continue; // Already healthy and pointing to the right script, skip writing
      }

      // Register or update
      config.mcpServers['jigit-memory'] = {
        command: 'node',
        args: [targetScript],
      };

      fs.writeFileSync(realPath, JSON.stringify(config, null, 2), 'utf8');
      modifiedAny = true;
      statusMessage = `Registered 'jigit-memory' in ${realPath}`;
    } catch (err) {
      console.warn(`[Argon MCP Registration] Warning for ${cfgPath}: ${err.message}`);
    }
  }

  return {
    registered: modifiedAny,
    reason: statusMessage,
    scriptPath: targetScript,
  };
}

module.exports = {
  ensureMcpRegistered,
  getExpectedMcpServerScriptPath,
};
