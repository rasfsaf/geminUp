const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

function createSocks5Connection(proxyHost, proxyPort, targetHost, targetPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    socket.setNoDelay(true);
    let stage = 0;
    let timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SOCKS5 proxy connection to ${proxyHost}:${proxyPort} timed out`));
    }, timeoutMs);

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SOCKS5 proxy error: ${err.message}`));
    });

    socket.on('connect', () => {
      // Step 1: Send client greeting (VER=5, NMETHODS=1, METHOD=0 [No Auth])
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
      stage = 1;
    });

    socket.on('data', (data) => {
      if (stage === 1) {
        // Server choice
        if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
          clearTimeout(timer);
          socket.destroy();
          return reject(new Error('SOCKS5 proxy rejected authentication or unsupported version'));
        }

        // Step 2: Send connect command (VER=5, CMD=1, RSV=0, ATYP=3 [Domain], TargetHost, TargetPort)
        const hostBuf = Buffer.from(targetHost, 'utf8');
        const req = Buffer.alloc(4 + 1 + hostBuf.length + 2);
        req[0] = 0x05;
        req[1] = 0x01; // CONNECT
        req[2] = 0x00; // RSV
        req[3] = 0x03; // DOMAINNAME
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(targetPort, 5 + hostBuf.length);

        stage = 2;
        socket.write(req);
      } else if (stage === 2) {
        // Step 3: Server connect response
        if (data.length < 4 || data[0] !== 0x05 || data[1] !== 0x00) {
          clearTimeout(timer);
          socket.destroy();
          return reject(new Error(`SOCKS5 proxy failed to connect to destination (rep code: ${data[1]})`));
        }

        clearTimeout(timer);
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        resolve(socket);
      }
    });
  });
}

function createAgent(proxyUrl) {
  if (!proxyUrl) {
    return new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: 180000,
    });
  }

  const parsed = new URL(proxyUrl);
  if (parsed.protocol.startsWith('socks')) {
    const proxyHost = parsed.hostname;
    const proxyPort = Number(parsed.port) || 1080;

    return new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: 180000,
      createConnection(options, callback) {
        createSocks5Connection(proxyHost, proxyPort, options.host, Number(options.port) || 443)
          .then((rawSocket) => {
            const tlsSocket = tls.connect({
              socket: rawSocket,
              servername: options.servername || options.host,
            });
            tlsSocket.setNoDelay(true);
            tlsSocket.once('error', (err) => callback(err));
            tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
          })
          .catch((err) => callback(err));
      },
    });
  }

  // Fallback for standard HTTP proxy
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60000,
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 180000,
  });
}

const directHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 180000,
});

function doRequest(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: options.agent,
      maxHeaderSize: 131072,
    };

    const req = transport.request(reqOptions, (res) => {
      resolve({
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers,
        rawCookies: res.headers['set-cookie'] || [],
        body: res,
        text() {
          return new Promise((resResolve, resReject) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resResolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', resReject);
          });
        },
        async json() {
          const raw = await this.text();
          return JSON.parse(raw);
        },
      });
    });

    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy();
        return reject(new Error('Request aborted'));
      }
      options.signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Request aborted'));
      });
    }

    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy();
        reject(new Error(`Request to ${url.hostname} timed out after ${options.timeoutMs}ms`));
      });
    }

    req.once('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

module.exports = {
  createAgent,
  createSocks5Connection,
  directHttpsAgent,
  doRequest,
};
