using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace GeminUp
{
    internal sealed class TransportConfig
    {
        public int Version { get; set; }
        public int ListenPort { get; set; }
        public string ProtectedProxy { get; set; }
        public string[] ProxyPatterns { get; set; }
        public string UpdatedAtUtc { get; set; }
    }

    internal sealed class ProxyDefinition
    {
        public string Host { get; set; }
        public int Port { get; set; }
        public string Username { get; set; }
        public string Password { get; set; }

        public string SafeDescription
        {
            get { return Host + ":" + Port.ToString(CultureInfo.InvariantCulture); }
        }
    }

    internal static class ConfigStore
    {
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("geminUp.Config.v2");

        public static readonly string[] DefaultPatterns = new[]
        {
            "gemini.google.com",
            "aistudio.google.com",
            "ai.google.dev",
            "makersuite.google.com",
            "bard.google.com",
            "accounts.google.*",
            "oauth2.googleapis.com",
            "www.googleapis.com",
            "generativelanguage.googleapis.com",
            "push.clients6.google.com",
            "alkalimakersuite-pa.clients6.google.com",
            "*.googleusercontent.com",
            "usercontent.google.com",
            "*.gstatic.com",
            "apis.google.com",
            "ogs.google.com",
            "consent.google.com",
            "myaccount.google.com",
            "www.google.com",
            "antigravity.google",
            "antigravity.google.com",
            "*.antigravity.google",
            "cloudcode-pa.googleapis.com",
            "daily-cloudcode-pa.googleapis.com",
            "*.cloudcode-pa.googleapis.com"
        };

        public static ProxyDefinition ParseProxy(string input)
        {
            string normalized = (input ?? string.Empty).Trim().TrimStart('\uFEFF').Replace("\u00A0", string.Empty);
            if (normalized.Length == 0)
            {
                throw new ArgumentException("SOCKS5 value is empty.");
            }

            if (normalized.StartsWith("socks5://", StringComparison.OrdinalIgnoreCase))
            {
                Uri uri;
                if (!Uri.TryCreate(normalized, UriKind.Absolute, out uri) ||
                    !string.Equals(uri.Scheme, "socks5", StringComparison.OrdinalIgnoreCase) ||
                    string.IsNullOrWhiteSpace(uri.Host) || uri.Port < 1)
                {
                    throw new ArgumentException("Invalid socks5:// URL.");
                }

                string username = string.Empty;
                string password = string.Empty;
                if (!string.IsNullOrEmpty(uri.UserInfo))
                {
                    string[] credentials = uri.UserInfo.Split(new[] { ':' }, 2);
                    username = Uri.UnescapeDataString(credentials[0]);
                    password = credentials.Length > 1 ? Uri.UnescapeDataString(credentials[1]) : string.Empty;
                }
                return ValidateProxy(new ProxyDefinition
                {
                    Host = uri.Host,
                    Port = uri.Port,
                    Username = username,
                    Password = password
                });
            }

            string[] parts = normalized.Split(new[] { ':' }, 4);
            if (parts.Length != 4)
            {
                throw new ArgumentException("Expected host:port:username:password or socks5://username:password@host:port.");
            }
            int port;
            if (!int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out port))
            {
                throw new ArgumentException("SOCKS5 port is not a number.");
            }
            return ValidateProxy(new ProxyDefinition
            {
                Host = parts[0].Trim(),
                Port = port,
                Username = parts[2],
                Password = parts[3]
            });
        }

        private static ProxyDefinition ValidateProxy(ProxyDefinition proxy)
        {
            if (string.IsNullOrWhiteSpace(proxy.Host) || proxy.Host.Length > 253)
            {
                throw new ArgumentException("SOCKS5 host is invalid.");
            }
            if (proxy.Port < 1 || proxy.Port > 65535)
            {
                throw new ArgumentException("SOCKS5 port must be between 1 and 65535.");
            }
            if (Encoding.UTF8.GetByteCount(proxy.Username ?? string.Empty) > 255 ||
                Encoding.UTF8.GetByteCount(proxy.Password ?? string.Empty) > 255)
            {
                throw new ArgumentException("SOCKS5 username/password exceeds the protocol limit of 255 UTF-8 bytes.");
            }
            return proxy;
        }

        public static string[] LoadPatterns(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return DefaultPatterns;
            if (!File.Exists(path)) throw new FileNotFoundException("Domain routing file does not exist.", path);
            string[] patterns = File.ReadAllLines(path, Encoding.UTF8)
                .Select(line => line.Trim())
                .Where(line => line.Length > 0 && !line.StartsWith("#", StringComparison.Ordinal))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            if (patterns.Length == 0) throw new InvalidDataException("Domain routing file contains no patterns.");
            new RouteMatcher(patterns);
            return patterns;
        }

        public static void Save(string path, ProxyDefinition proxy, string[] proxyPatterns)
        {
            string plain = proxy.Host + "\n" + proxy.Port.ToString(CultureInfo.InvariantCulture) + "\n" +
                           (proxy.Username ?? string.Empty) + "\n" + (proxy.Password ?? string.Empty);
            byte[] clearBytes = Encoding.UTF8.GetBytes(plain);
            byte[] encrypted = null;
            try
            {
                encrypted = ProtectedData.Protect(clearBytes, Entropy, DataProtectionScope.LocalMachine);
                TransportConfig config = new TransportConfig
                {
                    Version = 2,
                    ListenPort = 8877,
                    ProtectedProxy = Convert.ToBase64String(encrypted),
                    ProxyPatterns = proxyPatterns,
                    UpdatedAtUtc = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                };
                string directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
                    Directory.CreateDirectory(directory);
                string temporary = path + ".tmp";
                File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(config), new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally
            {
                Array.Clear(clearBytes, 0, clearBytes.Length);
                if (encrypted != null) Array.Clear(encrypted, 0, encrypted.Length);
            }
        }

        public static TransportConfig LoadConfig(string path)
        {
            if (!File.Exists(path)) throw new FileNotFoundException("Transport config does not exist.", path);
            string json = File.ReadAllText(path, Encoding.UTF8);
            TransportConfig config = new JavaScriptSerializer().Deserialize<TransportConfig>(json);
            if (config == null || config.Version != 2 || config.ListenPort < 1024 ||
                string.IsNullOrWhiteSpace(config.ProtectedProxy) || config.ProxyPatterns == null ||
                config.ProxyPatterns.Length == 0)
            {
                throw new InvalidDataException("Transport config is malformed or unsupported.");
            }
            return config;
        }

        public static ProxyDefinition DecryptProxy(TransportConfig config)
        {
            byte[] encrypted = Convert.FromBase64String(config.ProtectedProxy);
            byte[] clearBytes = null;
            try
            {
                clearBytes = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.LocalMachine);
                string[] parts = Encoding.UTF8.GetString(clearBytes).Split(new[] { '\n' }, 4);
                if (parts.Length != 4) throw new InvalidDataException("Protected SOCKS5 data is malformed.");
                int port;
                if (!int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out port))
                    throw new InvalidDataException("Protected SOCKS5 port is malformed.");
                return ValidateProxy(new ProxyDefinition
                {
                    Host = parts[0], Port = port, Username = parts[2], Password = parts[3]
                });
            }
            finally
            {
                Array.Clear(encrypted, 0, encrypted.Length);
                if (clearBytes != null) Array.Clear(clearBytes, 0, clearBytes.Length);
            }
        }
    }

    internal static class Socks5Connector
    {
        private const int TimeoutMs = 15000;

        public static async Task<TcpClient> ConnectAsync(ProxyDefinition proxy, string targetHost, int targetPort)
        {
            TcpClient client = new TcpClient();
            client.NoDelay = true;
            try
            {
                try
                {
                    await AsyncIo.WithTimeout(client.ConnectAsync(proxy.Host, proxy.Port), TimeoutMs,
                        "Connection timed out.").ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    throw new IOException("Cannot connect to SOCKS5 endpoint " + proxy.SafeDescription + ": " + error.Message, error);
                }
                NetworkStream stream = client.GetStream();
                bool hasCredentials = !string.IsNullOrEmpty(proxy.Username);
                byte[] greeting = hasCredentials
                    ? new byte[] { 0x05, 0x02, 0x00, 0x02 }
                    : new byte[] { 0x05, 0x01, 0x00 };
                await AsyncIo.WithTimeout(stream.WriteAsync(greeting, 0, greeting.Length), TimeoutMs,
                    "SOCKS5 greeting timed out.").ConfigureAwait(false);
                byte[] methodReply = await ReadExactAsync(stream, 2).ConfigureAwait(false);
                if (methodReply[0] != 0x05 || methodReply[1] == 0xff)
                    throw new IOException("SOCKS5 proxy rejected all authentication methods.");

                if (methodReply[1] == 0x02)
                {
                    byte[] username = Encoding.UTF8.GetBytes(proxy.Username ?? string.Empty);
                    byte[] password = Encoding.UTF8.GetBytes(proxy.Password ?? string.Empty);
                    byte[] auth = new byte[3 + username.Length + password.Length];
                    auth[0] = 0x01;
                    auth[1] = (byte)username.Length;
                    Buffer.BlockCopy(username, 0, auth, 2, username.Length);
                    auth[2 + username.Length] = (byte)password.Length;
                    Buffer.BlockCopy(password, 0, auth, 3 + username.Length, password.Length);
                    try
                    {
                        await AsyncIo.WithTimeout(stream.WriteAsync(auth, 0, auth.Length), TimeoutMs,
                            "SOCKS5 authentication timed out.").ConfigureAwait(false);
                    }
                    finally
                    {
                        Array.Clear(auth, 0, auth.Length);
                        Array.Clear(username, 0, username.Length);
                        Array.Clear(password, 0, password.Length);
                    }
                    byte[] authReply = await ReadExactAsync(stream, 2).ConfigureAwait(false);
                    if (authReply[0] != 0x01 || authReply[1] != 0x00)
                        throw new IOException("SOCKS5 username/password authentication failed.");
                }
                else if (methodReply[1] != 0x00)
                {
                    throw new IOException("SOCKS5 proxy selected an unsupported authentication method.");
                }

                byte[] hostBytes = Encoding.ASCII.GetBytes(targetHost.TrimEnd('.'));
                if (hostBytes.Length == 0 || hostBytes.Length > 255)
                    throw new ArgumentException("Target hostname cannot be encoded for SOCKS5.");
                byte[] request = new byte[7 + hostBytes.Length];
                request[0] = 0x05;
                request[1] = 0x01;
                request[2] = 0x00;
                request[3] = 0x03;
                request[4] = (byte)hostBytes.Length;
                Buffer.BlockCopy(hostBytes, 0, request, 5, hostBytes.Length);
                request[5 + hostBytes.Length] = (byte)((targetPort >> 8) & 0xff);
                request[6 + hostBytes.Length] = (byte)(targetPort & 0xff);
                await AsyncIo.WithTimeout(stream.WriteAsync(request, 0, request.Length), TimeoutMs,
                    "SOCKS5 CONNECT request timed out.").ConfigureAwait(false);

                byte[] reply = await ReadExactAsync(stream, 4).ConfigureAwait(false);
                if (reply[0] != 0x05 || reply[1] != 0x00)
                    throw new IOException("SOCKS5 CONNECT failed with status " + reply[1].ToString(CultureInfo.InvariantCulture) + ".");
                await ConsumeBoundAddressAsync(stream, reply[3]).ConfigureAwait(false);
                return client;
            }
            catch
            {
                client.Close();
                throw;
            }
        }

        private static async Task<byte[]> ReadExactAsync(Stream stream, int count)
        {
            byte[] buffer = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int read = await AsyncIo.WithTimeout(stream.ReadAsync(buffer, offset, count - offset), TimeoutMs,
                    "SOCKS5 response timed out.").ConfigureAwait(false);
                if (read <= 0) throw new EndOfStreamException("SOCKS5 proxy closed the connection unexpectedly.");
                offset += read;
            }
            return buffer;
        }

        private static async Task ConsumeBoundAddressAsync(Stream stream, byte addressType)
        {
            if (addressType == 0x01) await ReadExactAsync(stream, 4).ConfigureAwait(false);
            else if (addressType == 0x04) await ReadExactAsync(stream, 16).ConfigureAwait(false);
            else if (addressType == 0x03)
            {
                int length = (await ReadExactAsync(stream, 1).ConfigureAwait(false))[0];
                await ReadExactAsync(stream, length).ConfigureAwait(false);
            }
            else throw new IOException("SOCKS5 proxy returned an unknown address type.");
            await ReadExactAsync(stream, 2).ConfigureAwait(false);
        }
    }

    internal static class AsyncIo
    {
        public static async Task WithTimeout(Task operation, int timeoutMs, string message)
        {
            using (CancellationTokenSource timer = new CancellationTokenSource())
            {
                Task delay = Task.Delay(timeoutMs, timer.Token);
                if (await Task.WhenAny(operation, delay).ConfigureAwait(false) != operation)
                {
                    Observe(operation);
                    throw new TimeoutException(message);
                }
                timer.Cancel();
                await operation.ConfigureAwait(false);
            }
        }

        public static async Task<T> WithTimeout<T>(Task<T> operation, int timeoutMs, string message)
        {
            using (CancellationTokenSource timer = new CancellationTokenSource())
            {
                Task delay = Task.Delay(timeoutMs, timer.Token);
                if (await Task.WhenAny(operation, delay).ConfigureAwait(false) != operation)
                {
                    Observe(operation);
                    throw new TimeoutException(message);
                }
                timer.Cancel();
                return await operation.ConfigureAwait(false);
            }
        }

        private static void Observe(Task operation)
        {
            operation.ContinueWith(task =>
            {
                Exception ignored = task.Exception;
            }, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
        }
    }

    internal sealed class RouteMatcher
    {
        private readonly Regex[] patterns;

        public RouteMatcher(IEnumerable<string> sourcePatterns)
        {
            patterns = sourcePatterns.Select(pattern =>
            {
                string normalized = (pattern ?? string.Empty).Trim().TrimEnd('.').ToLowerInvariant();
                if (normalized.Length == 0) throw new InvalidDataException("Empty proxy pattern in config.");
                string regex = "^" + Regex.Escape(normalized).Replace("\\*", ".*") + "$";
                if (normalized.StartsWith("*.", StringComparison.Ordinal))
                {
                    string root = normalized.Substring(2);
                    regex = "^(?:.*\\.)?" + Regex.Escape(root) + "$";
                }
                return new Regex(regex, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
            }).ToArray();
        }

        public bool UsesSocks(string host)
        {
            string normalized = (host ?? string.Empty).Trim().TrimEnd('.');
            return normalized.Length > 0 && patterns.Any(pattern => pattern.IsMatch(normalized));
        }
    }

    internal sealed class FileLogger
    {
        private readonly string path;
        private readonly object gate = new object();

        public FileLogger(string pathValue) { path = pathValue; }

        public void Write(string level, string message)
        {
            string line = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + " [" + level + "] " + message;
            lock (gate)
            {
                string directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
                    Directory.CreateDirectory(directory);
                File.AppendAllText(path, line + Environment.NewLine, new UTF8Encoding(false));
            }
        }
    }

    internal sealed class LocalTransport
    {
        private const int MaxHeaderBytes = 65536;
        private const int ClientIoTimeoutMs = 30000;
        private readonly TransportConfig config;
        private readonly ProxyDefinition upstream;
        private readonly RouteMatcher matcher;
        private readonly FileLogger logger;
        private readonly SemaphoreSlim slots = new SemaphoreSlim(256, 256);
        private TcpListener listener;

        public LocalTransport(TransportConfig configValue, ProxyDefinition proxy, FileLogger fileLogger)
        {
            config = configValue;
            upstream = proxy;
            matcher = new RouteMatcher(config.ProxyPatterns);
            logger = fileLogger;
        }

        public void Run()
        {
            RunAsync().GetAwaiter().GetResult();
        }

        private async Task RunAsync()
        {
            listener = new TcpListener(IPAddress.Loopback, config.ListenPort);
            listener.Start(256);
            logger.Write("OK", "Transport listening on 127.0.0.1:" + config.ListenPort.ToString(CultureInfo.InvariantCulture) + ".");
            while (true)
            {
                await slots.WaitAsync().ConfigureAwait(false);
                TcpClient client = null;
                try
                {
                    client = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                    Task handler = HandleClientAndReleaseAsync(client);
                }
                catch
                {
                    if (client != null) client.Close();
                    slots.Release();
                    throw;
                }
            }
        }

        private async Task HandleClientAndReleaseAsync(TcpClient client)
        {
            try
            {
                await HandleClientAsync(client).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                logger.Write("WARN", "Client connection failed: " + error.Message);
            }
            finally
            {
                client.Close();
                slots.Release();
            }
        }

        private async Task HandleClientAsync(TcpClient client)
        {
            client.NoDelay = true;
            NetworkStream clientStream = client.GetStream();
            HeaderReadResult request = await ReadHeadersAsync(clientStream).ConfigureAwait(false);
            string headerText = Encoding.GetEncoding("ISO-8859-1").GetString(request.Headers);
            string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0) throw new InvalidDataException("Empty HTTP proxy request.");
            string[] requestParts = lines[0].Split(new[] { ' ' }, 3);
            if (requestParts.Length != 3) throw new InvalidDataException("Malformed HTTP request line.");

            string method = requestParts[0].ToUpperInvariant();
            string host;
            int port;
            TcpClient target;
            if (method == "CONNECT")
            {
                ParseAuthority(requestParts[1], 443, out host, out port);
                bool throughSocks = matcher.UsesSocks(host);
                Exception openError = null;
                try
                {
                    target = await OpenTargetAsync(host, port, throughSocks).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    target = null;
                    openError = error;
                }
                if (openError != null)
                {
                    if (throughSocks) logger.Write("ERROR", "Protected route unavailable for " + host + ": " + openError.Message);
                    await SendProxyErrorAsync(clientStream, throughSocks, openError.Message).ConfigureAwait(false);
                    return;
                }
                using (target)
                {
                    byte[] established = Encoding.ASCII.GetBytes("HTTP/1.1 200 Connection Established\r\nProxy-Agent: geminUp/1.3\r\n\r\n");
                    await AsyncIo.WithTimeout(clientStream.WriteAsync(established, 0, established.Length),
                        ClientIoTimeoutMs, "Client response timed out.").ConfigureAwait(false);
                    if (request.Trailing.Length > 0)
                    {
                        NetworkStream targetStream = target.GetStream();
                        await AsyncIo.WithTimeout(targetStream.WriteAsync(request.Trailing, 0, request.Trailing.Length),
                            ClientIoTimeoutMs, "Initial tunnel write timed out.").ConfigureAwait(false);
                    }
                    await RelayAsync(client, target).ConfigureAwait(false);
                }
                return;
            }

            Uri destination;
            if (!Uri.TryCreate(requestParts[1], UriKind.Absolute, out destination) ||
                (destination.Scheme != "http" && destination.Scheme != "https"))
            {
                throw new InvalidDataException("Only absolute HTTP proxy requests are supported.");
            }
            host = destination.Host;
            port = destination.IsDefaultPort ? (destination.Scheme == "https" ? 443 : 80) : destination.Port;
            bool proxyRoute = matcher.UsesSocks(host);
            Exception routeError = null;
            try
            {
                target = await OpenTargetAsync(host, port, proxyRoute).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                target = null;
                routeError = error;
            }
            if (routeError != null)
            {
                if (proxyRoute) logger.Write("ERROR", "Protected route unavailable for " + host + ": " + routeError.Message);
                await SendProxyErrorAsync(clientStream, proxyRoute, routeError.Message).ConfigureAwait(false);
                return;
            }

            using (target)
            {
                string path = string.IsNullOrEmpty(destination.PathAndQuery) ? "/" : destination.PathAndQuery;
                lines[0] = method + " " + path + " " + requestParts[2];
                string rewritten = string.Join("\r\n", lines.Where(line =>
                    !line.StartsWith("Proxy-Connection:", StringComparison.OrdinalIgnoreCase)));
                byte[] outgoingHeader = Encoding.GetEncoding("ISO-8859-1").GetBytes(rewritten);
                NetworkStream targetStream = target.GetStream();
                await AsyncIo.WithTimeout(targetStream.WriteAsync(outgoingHeader, 0, outgoingHeader.Length),
                    ClientIoTimeoutMs, "HTTP request write timed out.").ConfigureAwait(false);
                if (request.Trailing.Length > 0)
                {
                    await AsyncIo.WithTimeout(targetStream.WriteAsync(request.Trailing, 0, request.Trailing.Length),
                        ClientIoTimeoutMs, "HTTP request body write timed out.").ConfigureAwait(false);
                }
                await RelayAsync(client, target).ConfigureAwait(false);
            }
        }

        private async Task<TcpClient> OpenTargetAsync(string host, int port, bool throughSocks)
        {
            if (throughSocks) return await Socks5Connector.ConnectAsync(upstream, host, port).ConfigureAwait(false);
            TcpClient direct = new TcpClient();
            direct.NoDelay = true;
            try
            {
                await AsyncIo.WithTimeout(direct.ConnectAsync(host, port), 15000,
                    "Direct connection timed out.").ConfigureAwait(false);
                return direct;
            }
            catch { direct.Close(); throw; }
        }

        private static async Task<HeaderReadResult> ReadHeadersAsync(Stream stream)
        {
            MemoryStream buffer = new MemoryStream();
            byte[] chunk = new byte[4096];
            while (true)
            {
                int previousLength = checked((int)buffer.Length);
                int read = await AsyncIo.WithTimeout(stream.ReadAsync(chunk, 0, chunk.Length), ClientIoTimeoutMs,
                    "Client HTTP headers timed out.").ConfigureAwait(false);
                if (read <= 0) throw new EndOfStreamException("Client closed before sending HTTP headers.");
                buffer.Write(chunk, 0, read);
                byte[] bytes = buffer.GetBuffer();
                int totalLength = checked((int)buffer.Length);
                for (int index = Math.Max(0, previousLength - 3); index <= totalLength - 4; index++)
                {
                    if (bytes[index] != 13 || bytes[index + 1] != 10 ||
                        bytes[index + 2] != 13 || bytes[index + 3] != 10) continue;
                    int headerLength = index + 4;
                    if (headerLength > MaxHeaderBytes)
                        throw new InvalidDataException("HTTP proxy headers exceed 64 KiB.");
                    byte[] headers = new byte[headerLength];
                    Buffer.BlockCopy(bytes, 0, headers, 0, headerLength);
                    byte[] trailing = new byte[totalLength - headerLength];
                    if (trailing.Length > 0)
                        Buffer.BlockCopy(bytes, headerLength, trailing, 0, trailing.Length);
                    return new HeaderReadResult(headers, trailing);
                }
                if (totalLength >= MaxHeaderBytes)
                    throw new InvalidDataException("HTTP proxy headers exceed 64 KiB.");
            }
        }

        private static void ParseAuthority(string authority, int defaultPort, out string host, out int port)
        {
            Uri uri;
            if (!Uri.TryCreate("https://" + authority, UriKind.Absolute, out uri) || string.IsNullOrWhiteSpace(uri.Host))
                throw new InvalidDataException("Malformed CONNECT authority.");
            host = uri.Host;
            port = uri.IsDefaultPort ? defaultPort : uri.Port;
        }

        private static async Task SendProxyErrorAsync(Stream stream, bool protectedRoute, string reason)
        {
            string title = protectedRoute ? "Gemini proxy offline" : "Network connection failed";
            string safeReason = WebUtility.HtmlEncode(reason ?? "Unknown error");
            string body = "<!doctype html><meta charset=utf-8><title>" + title + "</title>" +
                          "<style>body{background:#050805;color:#3cff68;font:16px Consolas,monospace;padding:40px}" +
                          "h1{font-size:24px}pre{white-space:pre-wrap;color:#ff6b6b}</style><h1>" + title +
                          "</h1><p>Direct fallback is disabled.</p><pre>" + safeReason + "</pre>";
            byte[] bodyBytes = Encoding.UTF8.GetBytes(body);
            string headers = "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html; charset=utf-8\r\n" +
                             "Content-Length: " + bodyBytes.Length.ToString(CultureInfo.InvariantCulture) +
                             "\r\nConnection: close\r\n\r\n";
            byte[] headerBytes = Encoding.ASCII.GetBytes(headers);
            await AsyncIo.WithTimeout(stream.WriteAsync(headerBytes, 0, headerBytes.Length), ClientIoTimeoutMs,
                "Client error response timed out.").ConfigureAwait(false);
            await AsyncIo.WithTimeout(stream.WriteAsync(bodyBytes, 0, bodyBytes.Length), ClientIoTimeoutMs,
                "Client error response timed out.").ConfigureAwait(false);
        }

        private static async Task RelayAsync(TcpClient left, TcpClient right)
        {
            NetworkStream leftStream = left.GetStream();
            NetworkStream rightStream = right.GetStream();
            Task leftToRight = leftStream.CopyToAsync(rightStream, 81920);
            Task rightToLeft = rightStream.CopyToAsync(leftStream, 81920);
            Exception relayError = null;
            try
            {
                Task completed = await Task.WhenAny(leftToRight, rightToLeft).ConfigureAwait(false);
                await completed.ConfigureAwait(false);
                if (completed == leftToRight)
                {
                    TryShutdown(right, SocketShutdown.Send);
                    await rightToLeft.ConfigureAwait(false);
                }
                else
                {
                    TryShutdown(left, SocketShutdown.Send);
                    await leftToRight.ConfigureAwait(false);
                }
            }
            catch (Exception error)
            {
                relayError = error;
            }
            if (relayError != null)
            {
                TryShutdown(left, SocketShutdown.Both);
                TryShutdown(right, SocketShutdown.Both);
                try { await Task.WhenAll(leftToRight, rightToLeft).ConfigureAwait(false); }
                catch { }
                ExceptionDispatchInfo.Capture(relayError).Throw();
            }
        }

        private static void TryShutdown(TcpClient client, SocketShutdown direction)
        {
            try { client.Client.Shutdown(direction); }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
        }

        private sealed class HeaderReadResult
        {
            public readonly byte[] Headers;
            public readonly byte[] Trailing;

            public HeaderReadResult(byte[] headers, byte[] trailing)
            {
                Headers = headers;
                Trailing = trailing;
            }
        }
    }

    internal static class AntigravityLauncher
    {
        private static readonly string[] ProxyVariables = new[]
        {
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GRPC_PROXY",
            "http_proxy", "https_proxy", "all_proxy", "grpc_proxy"
        };

        public static int Launch(string configPath, string targetPath, string encodedArguments)
        {
            if (string.IsNullOrWhiteSpace(targetPath))
                throw new ArgumentException("Antigravity target path is empty.");
            string fullTarget = Path.GetFullPath(targetPath);
            if (!File.Exists(fullTarget))
                throw new FileNotFoundException("Antigravity executable does not exist.", fullTarget);
            if (!string.Equals(Path.GetFileName(fullTarget), "Antigravity.exe", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Launcher target must be Antigravity.exe.");
            if (string.Equals(fullTarget, Process.GetCurrentProcess().MainModule.FileName, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Launcher cannot target itself.");

            TransportConfig config = ConfigStore.LoadConfig(configPath);
            EnsureLocalTransport(config.ListenPort);
            string proxyUrl = "http://127.0.0.1:" + config.ListenPort.ToString(CultureInfo.InvariantCulture);
            string originalArguments = DecodeArguments(encodedArguments);

            ProcessStartInfo start = new ProcessStartInfo
            {
                FileName = fullTarget,
                WorkingDirectory = Path.GetDirectoryName(fullTarget),
                UseShellExecute = false,
                Arguments = JoinArguments(originalArguments,
                    "--proxy-server=" + proxyUrl + " --disable-quic")
            };
            foreach (string variable in ProxyVariables)
                start.EnvironmentVariables[variable] = proxyUrl;
            AppendNoProxy(start, "NO_PROXY");
            AppendNoProxy(start, "no_proxy");
            start.EnvironmentVariables["GEMINUP_ANTIGRAVITY"] = "1";

            Process process = Process.Start(start);
            if (process == null) throw new InvalidOperationException("Windows did not start Antigravity.");
            return 0;
        }

        private static void EnsureLocalTransport(int port)
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect(IPAddress.Loopback, port, null, null);
                try
                {
                    if (!result.AsyncWaitHandle.WaitOne(2000))
                        throw new IOException("geminUp local transport is not running on 127.0.0.1:" +
                            port.ToString(CultureInfo.InvariantCulture) + ".");
                    client.EndConnect(result);
                }
                finally
                {
                    result.AsyncWaitHandle.Close();
                }
            }
        }

        private static string DecodeArguments(string encodedArguments)
        {
            if (string.IsNullOrWhiteSpace(encodedArguments)) return string.Empty;
            byte[] bytes = Convert.FromBase64String(encodedArguments);
            try
            {
                if (bytes.Length > 32768) throw new ArgumentException("Antigravity shortcut arguments are too long.");
                return new UTF8Encoding(false, true).GetString(bytes);
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
            }
        }

        private static string JoinArguments(string first, string second)
        {
            if (string.IsNullOrWhiteSpace(first)) return second;
            return first.Trim() + " " + second;
        }

        private static void AppendNoProxy(ProcessStartInfo start, string name)
        {
            string current = start.EnvironmentVariables[name] ?? string.Empty;
            List<string> entries = current.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(value => value.Trim())
                .Where(value => value.Length > 0)
                .ToList();
            foreach (string local in new[] { "localhost", "127.0.0.1", "::1" })
            {
                if (!entries.Contains(local, StringComparer.OrdinalIgnoreCase)) entries.Add(local);
            }
            start.EnvironmentVariables[name] = string.Join(",", entries.ToArray());
        }
    }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            try
            {
                if (args.Length == 0) return Usage("Missing command.");
                string command = args[0].ToLowerInvariant();
                string configPath = GetOption(args, "--config", true);
                if (command == "configure") return Configure(configPath, GetOption(args, "--domains", false));
                if (command == "refresh-domains") return RefreshDomains(configPath, GetOption(args, "--domains", true));
                if (command == "test") return Test(configPath);
                if (command == "launch-antigravity")
                    return AntigravityLauncher.Launch(configPath, GetOption(args, "--target", true),
                        GetOption(args, "--original-arguments", false));
                if (command == "run")
                {
                    string pidPath = GetOption(args, "--pid", true);
                    string logPath = GetOption(args, "--log", true);
                    string mutexName = GetOption(args, "--mutex", false);
                    return Run(configPath, pidPath, logPath, mutexName);
                }
                return Usage("Unknown command: " + command);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("ERROR: " + error.Message);
                return 1;
            }
        }

        private static int Configure(string configPath, string domainsPath)
        {
            string input = Console.In.ReadLine();
            ProxyDefinition proxy = ConfigStore.ParseProxy(input);
            VerifyProxy(proxy);
            string[] patterns = ConfigStore.LoadPatterns(domainsPath);
            ConfigStore.Save(configPath, proxy, patterns);
            Console.WriteLine("OK: SOCKS5 " + proxy.SafeDescription + " verified and stored with machine-scoped Windows DPAPI.");
            Console.WriteLine("OK: " + patterns.Length.ToString(CultureInfo.InvariantCulture) + " protected domain patterns loaded.");
            return 0;
        }

        private static int Test(string configPath)
        {
            TransportConfig config = ConfigStore.LoadConfig(configPath);
            ProxyDefinition proxy = ConfigStore.DecryptProxy(config);
            VerifyProxy(proxy);
            Console.WriteLine("OK: SOCKS5 " + proxy.SafeDescription + " reaches Gemini with valid TLS.");
            return 0;
        }

        private static int RefreshDomains(string configPath, string domainsPath)
        {
            TransportConfig config = ConfigStore.LoadConfig(configPath);
            ProxyDefinition proxy = ConfigStore.DecryptProxy(config);
            string[] patterns = ConfigStore.LoadPatterns(domainsPath);
            ConfigStore.Save(configPath, proxy, patterns);
            Console.WriteLine("OK: " + patterns.Length.ToString(CultureInfo.InvariantCulture) +
                " protected domain patterns refreshed without changing SOCKS5 credentials.");
            return 0;
        }

        private static void VerifyProxy(ProxyDefinition proxy)
        {
            using (TcpClient client = Socks5Connector.ConnectAsync(proxy, "gemini.google.com", 443).GetAwaiter().GetResult())
            using (SslStream tls = new SslStream(client.GetStream(), false))
            {
                tls.ReadTimeout = 15000;
                tls.WriteTimeout = 15000;
                tls.AuthenticateAsClient("gemini.google.com");
                if (!tls.IsAuthenticated || !tls.IsEncrypted)
                    throw new IOException("Gemini TLS verification through SOCKS5 failed.");
            }
        }

        private static int Run(string configPath, string pidPath, string logPath, string mutexName)
        {
            if (string.IsNullOrWhiteSpace(mutexName)) mutexName = "Global\\geminUp_Service";
            if (!Regex.IsMatch(mutexName, "^(?:Global|Local)\\\\[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant))
                throw new ArgumentException("Invalid mutex name.");
            bool created;
            using (Mutex mutex = new Mutex(true, mutexName, out created))
            {
                if (!created) throw new InvalidOperationException("geminUp is already running on this PC.");
                TransportConfig config = ConfigStore.LoadConfig(configPath);
                ProxyDefinition proxy = ConfigStore.DecryptProxy(config);
                FileLogger logger = new FileLogger(logPath);
                string pidDirectory = Path.GetDirectoryName(pidPath);
                if (!string.IsNullOrEmpty(pidDirectory) && !Directory.Exists(pidDirectory))
                    Directory.CreateDirectory(pidDirectory);
                File.WriteAllText(pidPath, Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture), new UTF8Encoding(false));
                try
                {
                    logger.Write("INFO", "Starting geminUp with SOCKS5 " + proxy.SafeDescription + ".");
                    new LocalTransport(config, proxy, logger).Run();
                }
                finally
                {
                    try { if (File.Exists(pidPath)) File.Delete(pidPath); } catch { }
                }
            }
            return 0;
        }

        private static string GetOption(string[] args, string name, bool required)
        {
            for (int index = 1; index < args.Length - 1; index++)
            {
                if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
            }
            if (required) throw new ArgumentException("Missing required option " + name + ".");
            return null;
        }

        private static int Usage(string error)
        {
            Console.Error.WriteLine("ERROR: " + error);
            Console.Error.WriteLine("Usage: geminUp.exe configure --config PATH [--domains PATH]");
            Console.Error.WriteLine("       geminUp.exe refresh-domains --config PATH --domains PATH");
            Console.Error.WriteLine("       geminUp.exe test --config PATH");
            Console.Error.WriteLine("       geminUp.exe run --config PATH --pid PATH --log PATH");
            Console.Error.WriteLine("       geminUp.exe launch-antigravity --config PATH --target PATH [--original-arguments BASE64]");
            return 2;
        }
    }
}
