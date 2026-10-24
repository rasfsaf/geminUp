const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

function createSocks5Connection(proxyHost, proxyPort, username, password, targetHost, targetPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    socket.setNoDelay(true);
    let timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SOCKS5 proxy connection to ${proxyHost}:${proxyPort} timed out`));
    }, timeoutMs);

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SOCKS5 proxy error: ${err.message}`));
    });

    socket.once('connect', () => {
      // Step 1: Handshake. Methods: 0x00 (No Auth), 0x02 (User/Pass RFC 1929)
      const methods = username ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00];
      socket.write(Buffer.from(methods));
    });

    let state = 'AUTH_CHOICE';

    socket.on('data', (chunk) => {
      if (state === 'AUTH_CHOICE') {
        if (chunk[0] !== 0x05) {
          clearTimeout(timer);
          socket.destroy();
          return reject(new Error('Invalid SOCKS5 version in response'));
        }
        const method = chunk[1];
        if (method === 0x02) {
          if (!username) {
            clearTimeout(timer);
            socket.destroy();
            return reject(new Error('SOCKS5 server requires authentication but none provided'));
          }
          const uBuf = Buffer.from(username, 'utf8');
          const pBuf = Buffer.from(password || '', 'utf8');
          const authReq = Buffer.concat([
            Buffer.from([0x01, uBuf.length]),
            uBuf,
            Buffer.from([pBuf.length]),
            pBuf
          ]);
          state = 'AUTH_RESP';
          socket.write(authReq);
        } else if (method === 0x00) {
          state = 'CONNECT_RESP';
          sendConnect();
        } else {
          clearTimeout(timer);
          socket.destroy();
          return reject(new Error('SOCKS5 auth method rejected by proxy: ' + method));
        }
      } else if (state === 'AUTH_RESP') {
        if (chunk[1] !== 0x00) {
          clearTimeout(timer);
          socket.destroy();
          return reject(new Error('SOCKS5 authentication failed with code: ' + chunk[1]));
        }
        state = 'CONNECT_RESP';
        sendConnect();
      } else if (state === 'CONNECT_RESP') {
        if (chunk[1] !== 0x00) {
          clearTimeout(timer);
          socket.destroy();
          return reject(new Error('SOCKS5 CONNECT failed with rep code: ' + chunk[1]));
        }
        clearTimeout(timer);
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        resolve(socket);
      }
    });

    function sendConnect() {
      // CMD=1 (CONNECT), RSV=0, ATYP=3 (Domain name - resolves remotely)
      const hBuf = Buffer.from(targetHost, 'utf8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hBuf.length]),
        hBuf,
        Buffer.from([ (targetPort >> 8) & 0xFF, targetPort & 0xFF ])
      ]);
      socket.write(req);
    }
  });
}

function createHttpConnectTunnel(proxyHost, proxyPort, targetHost, targetPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    socket.setNoDelay(true);
    let timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Proxy connection to ${proxyHost}:${proxyPort} timed out`));
    }, timeoutMs);

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Proxy socket error: ${err.message}`));
    });

    socket.on('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
    });

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        if (buffer.startsWith('HTTP/1.1 200') || buffer.startsWith('HTTP/1.0 200') || buffer.includes(' 200 ')) {
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`Proxy tunnel rejected: ${buffer.split('\r\n')[0]}`));
        }
      }
    };
    socket.on('data', onData);
  });
}

function createAgent(proxyUrl) {
  const effectiveProxy = proxyUrl || 'socks5://127.0.0.1:8877';
  const isSocks = effectiveProxy.startsWith('socks5://') || effectiveProxy.startsWith('socks://');

  if (isSocks) {
    const parsed = new URL(effectiveProxy);
    const proxyHost = parsed.hostname;
    const proxyPort = Number(parsed.port) || 1080;
    const username = parsed.username ? decodeURIComponent(parsed.username) : '';
    const password = parsed.password ? decodeURIComponent(parsed.password) : '';

    return new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 120000,
      createConnection(options, callback) {
        createSocks5Connection(proxyHost, proxyPort, username, password, options.host, Number(options.port) || 443)
          .then((rawSocket) => {
            const tlsSocket = tls.connect({
              socket: rawSocket,
              servername: options.servername || options.host,
            });
            tlsSocket.setNoDelay(true);
            const onError = (err) => {
              rawSocket.destroy();
              callback(err);
            };
            tlsSocket.once('error', onError);
            tlsSocket.once('secureConnect', () => {
              tlsSocket.removeListener('error', onError);
              callback(null, tlsSocket);
            });
          })
          .catch((err) => callback(err));
      },
    });
  }

  const parsed = new URL(effectiveProxy);
  const proxyHost = parsed.hostname || '127.0.0.1';
  const proxyPort = Number(parsed.port) || 8877;

  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 64,
    maxFreeSockets: 16,
    timeout: 120000,
    createConnection(options, callback) {
      createHttpConnectTunnel(proxyHost, proxyPort, options.host, Number(options.port) || 443)
        .then((rawSocket) => {
          const tlsSocket = tls.connect({
            socket: rawSocket,
            servername: options.servername || options.host,
          });
          tlsSocket.setNoDelay(true);
          const onError = (err) => {
            rawSocket.destroy();
            callback(err);
          };
          tlsSocket.once('error', onError);
          tlsSocket.once('secureConnect', () => {
            tlsSocket.removeListener('error', onError);
            callback(null, tlsSocket);
          });
        })
        .catch((err) => callback(err));
    },
  });
}

const directHttpsAgent = new https.Agent({
  keepAlive: false,
  timeout: 300000,
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
