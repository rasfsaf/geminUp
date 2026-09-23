[**English**](README.md) | [Русский](README.ru.md)

# geminUp

`geminUp` is an open-source project for accessing Google Gemini through a user-provided SOCKS5 proxy.

The project includes two independent components:

- Windows 10/11: a system-level transport for Gemini and Antigravity that works with standard browsers and applications;
- Android 7+: a standalone Gemini WebView client with its own local HTTP-to-SOCKS5 bridge.

The Android app is not a VPN and does not intercept traffic from other applications. Users can keep their system VPN enabled while routing only the built-in Gemini client through SOCKS5.

## Features

- a single BAT launcher for enabling the transport, replacing the SOCKS5 proxy, optionally routing YouTube, applying updates, and fully disabling the installation;
- one machine-wide installation for all users;
- automatic startup of the background transport as `SYSTEM` when Windows boots;
- remote DNS resolution through SOCKS5 for protected destinations;
- fail-closed behavior: when SOCKS5 is unavailable, protected connections receive HTTP 502 with no direct fallback;
- SOCKS5 authentication;
- configuration encryption with Windows DPAPI `LocalMachine`;
- data-directory ACLs restricted to `SYSTEM` and local administrators;
- preservation and restoration of previous system proxy and browser policies;
- disabling of unproxied WebRTC and QUIC in supported browsers;
- a separate bootstrap script for downloading a verified release ZIP;
- fallback installation of the official .NET Framework 4.8 package when no compiler is available.

## Quick start

### Android

1. Download the single `geminUp.apk` file from [Releases](https://github.com/rasfsaf/geminUp/releases).
2. Optionally verify it against `geminUp.apk.sha256` and the [signing certificate](android/signing-certificate.pem).
3. Allow APK installation from the selected browser or file manager.
4. Open geminUp, tap `+`, enter a SOCKS5 proxy, and enable it.

The public package ID is `io.github.rasfsaf.geminup`. The APK is signed with the project's permanent release key. The early debug build, `com.gemini.fulldostup`, cannot be upgraded in place to the release version and must be uninstalled once.

The app requests only `INTERNET` and `ACCESS_NETWORK_STATE`. It does not request access to the device's real location.

### Full archive — recommended

1. Download `geminUp.zip` from [Releases](https://github.com/rasfsaf/geminUp/releases).
2. Verify its SHA-256 against `geminUp.zip.sha256`, or use the bootstrap script.
3. Extract the complete archive.
4. Run `geminUp.bat` and approve the UAC prompt.
5. Select option `1` and enter a SOCKS5 proxy.

Do not download only `geminUp.bat` from the source tree: it requires the adjacent PowerShell controller, C# core, and domain lists.

### Single-file bootstrap

Download and run `geminUp-bootstrap.bat`. It will:

1. download the latest `geminUp.zip` from GitHub Releases;
2. download the published SHA-256 checksum;
3. verify the archive;
4. extract the version into `%LOCALAPPDATA%\geminUp\releases`;
5. launch the verified `geminUp.bat`.

## Menu

```text
1. Enter SOCKS5 and enable
2. Change SOCKS5
3. Disable and remove from autostart
4. Download/apply latest update and restart
5. Enable YouTube routing
6. Patch Antigravity binaries
7. Roll back Antigravity binary patch
```

Option 5 toggles between `Enable YouTube routing` and `Disable YouTube routing`. It is disabled by default, persists across updates, and can be changed without entering the SOCKS5 proxy again. After changing it, fully restart all open browsers so they close existing connections.

Items 6 and 7 patch `language_server*.exe` and `agy.exe`: the protobuf field `ineligible` is rewritten as `inexigible`. The strings are the same length, so the file size and layout do not change. Enable and Refresh apply the patch automatically; item 6 runs it on its own, and item 7 restores `ineligible`. The same rewrite clears other Antigravity client errors tied to that field, including the ineligible-account state (`SET_INELIGIBLE` / `ineligibleTiers`). If the install is not found, the menu asks for the binary or its folder. Prefix a folder with `scan ` only when the usual locations are not enough.

Supported formats:

```text
host:port:username:password
socks5://username:password@host:port
```

If the username or password contains a colon or special characters, use the URL form with percent-encoding.

After the green `SUCCESSFUL` message appears, fully restart all open browsers and Antigravity to terminate existing direct connections.

## Updating the Windows version

Downloading and replacing the files is not sufficient. The active transport runs from the already compiled `%ProgramData%\geminUp\geminUp.exe`; replacing the source files does not update that executable.

To update:

1. run `geminUp.bat` and approve the UAC prompt;
2. select `4. Download/apply latest update and restart`;
3. completely close and reopen Antigravity and all browsers.

Option 4 downloads the latest release ZIP and its published SHA-256, verifies the archive, and prevents downgrades. Verified releases are stored in `%LOCALAPPDATA%\geminUp\releases`. The source directory from which `geminUp.bat` was launched is never overwritten.

After verification, the controller rebuilds the executable, reloads `transport/domains.txt` and, if YouTube routing is enabled, `transport/youtube-domains.txt`, reinstalls the startup task, updates the Antigravity shortcuts, and restarts the transport with the saved DPAPI-protected configuration. The SOCKS5 proxy does not need to be entered again. If GitHub is unavailable, the checksum does not match, or the archive is corrupt, the controller shows a warning and rebuilds from the current local files.

## Windows routing architecture

Windows directs proxy-aware applications to the local HTTP/CONNECT transport at `127.0.0.1:8877`.

```mermaid
flowchart LR
    A["Browser using Windows proxy"] --> B["geminUp 127.0.0.1:8877"]
    AG["Antigravity launcher"] --> B
    B -->|"Gemini / Antigravity hostname"| C["SOCKS5 + remote DNS"]
    B -->|"YouTube hostname, when enabled"| C
    B -->|"Other hostname"| D["Current Windows route / VPN"]
    C --> E["Google Gemini / YouTube"]
```

Required routes are defined in [`transport/domains.txt`](transport/domains.txt), while optional YouTube routes are defined in [`transport/youtube-domains.txt`](transport/youtube-domains.txt). The YouTube option covers the main site, Music, Shorts, embedded players, APIs, `googlevideo.com`, and `ytimg.com`. There is no broad `*.google.com` wildcard. Shared dependencies such as `accounts.google.*`, `gstatic`, and `googleusercontent` may be used by other Google products; products cannot be distinguished within a single hostname.

When SOCKS5 is unavailable, only protected routes are blocked and no direct connection is attempted. The local transport starts at Windows boot and user sign-in, while Task Scheduler catches missed launches. A watchdog checks `127.0.0.1:8877` once per minute and attempts to recover the transport. After three consecutive failures, geminUp enters fail-open mode: it restores the previous Windows proxy/browser settings and Antigravity shortcuts, writes an error to `transport.log`, and displays a system notification. Normal internet access continues, but protected Gemini and YouTube routing remains disabled until geminUp is enabled again.

## Browsers and applications

- Chrome, Edge, and Brave use the machine-wide Windows proxy; policies disable QUIC and unproxied WebRTC UDP.
- Firefox receives machine-wide enterprise policies that enable the system proxy and disable WebRTC.
- Antigravity runs through modified shortcuts. Only its process and the child `language_server.exe`, `node.exe`, and sidecar processes receive local proxy environment variables; no global environment variables are created.
- Launching the original `Antigravity.exe` directly instead of using the managed shortcut is unsupported and bypasses the process-scoped configuration.
- Applications that use their own proxy, pass `--no-proxy-server`, include a built-in VPN, or ignore WinINET are unsupported.
- `Fail-safe: OPEN` means automatic transport recovery failed and Windows was restored to its previous network configuration. Run geminUp again to restore protected routing.

## Android client architecture

The Android app opens `gemini.google.com` only inside its built-in WebView. A loopback HTTP proxy on a random `127.0.0.1` port runs inside the app process and converts WebView requests to SOCKS5 connections with remote DNS resolution.

The Android system VPN is neither disabled nor replaced. Other apps, browsers, and system traffic do not pass through geminUp.

The app determines the exit IP's country, time zone, and approximate coordinates through `ipwho.is`; if that service is unavailable, it obtains at least the country through Cloudflare Trace. Both requests are sent only through the selected SOCKS5 proxy. If both GeoIP services fail, SOCKS5 remains active: the WebView continues through the proxy using a cached profile or the default GB profile. If the SOCKS5 bridge cannot start or the system WebView does not support `PROXY_OVERRIDE`, the app displays a local `FAIL-CLOSED` page and does not open Gemini directly. The resulting profile is locally applied to the WebView's geolocation, locale, and time zone. The app never requests the device's real location. SOCKS5 settings, their history, and the cached profile are encrypted with a key from Android Keystore and remain on the device.

See the [privacy policy](PRIVACY.md) for details.

## Startup and storage

After the transport is enabled, a `geminUp` scheduled task is created with a boot trigger and the `SYSTEM` account. The repository is no longer needed for background operation.

Runtime files are stored in:

```text
%ProgramData%\geminUp
```

This directory contains the compiled `geminUp.exe`, DPAPI-protected configuration, installation state, PID, and log. The password is never passed through process arguments or written to the log.

## Dependencies and fallback

The runtime does not require Visual Studio, the .NET SDK, NuGet, Node.js, or Python. It uses standard Windows 10/11 components:

- Windows PowerShell 5.1;
- .NET Framework 4.8+ and `csc.exe`;
- built-in Scheduled Tasks, Registry, and TCP/IP modules.

The controller searches for `csc.exe` in both the 64-bit and 32-bit .NET Framework directories. If the compiler is missing, geminUp asks for permission, downloads the official .NET Framework 4.8 installer from a Microsoft domain, verifies its Microsoft digital signature, and starts the installation. A reboot may be required.

Windows PowerShell is not restored automatically: its absence indicates a damaged or heavily stripped-down Windows installation, which is unsupported.

## Disabling

Run `geminUp.bat` and select option `3`. The controller will:

1. stop only the verified geminUp process;
2. remove the startup task;
3. restore the previous machine-wide proxy;
4. restore the original Chrome, Edge, Brave, and Firefox policies;
5. remove the DPAPI-protected configuration and installation state.

The compiled executable and log may remain in `%ProgramData%\geminUp`, but without the task and configuration they are inactive.

## Compatibility and limitations

Standard desktop editions of Windows 10 and Windows 11 with local administrator privileges are supported. Windows 7, Windows Server, ARM systems, modified builds without PowerShell/.NET, and UDP-only applications are not supported.

`geminUp` protects the network route. It does not spoof browser geolocation, time zone, SIM data, account history, cookies, or browser fingerprint. SOCKS5 quality and location remain the user's responsibility.

The Android client supports Android 7.0 (API 24) and later when the system WebView supports `PROXY_OVERRIDE`. It works only with its built-in Gemini client and does not promise routing for other Android applications.

## Development and tests

Runtime files:

```text
geminUp.bat
geminUp.ps1
transport/GeminUp.cs
transport/domains.txt
transport/youtube-domains.txt
geminUp.apk
android/
```

Python is required only by the integration test and is not required by end users:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\Test-GeminUp.ps1
```

The test compiles the core, starts a loopback SOCKS5 server, and verifies direct routing, Gemini and YouTube routes, the Antigravity language endpoint, launcher-only proxy inheritance by child processes, and fail-closed behavior. It does not modify real shortcuts, the system proxy, the registry, or Scheduled Tasks.

Android is built with the pinned Gradle Wrapper and does not require a system Gradle installation:

```powershell
cd android
.\gradlew.bat :app:assembleRelease
```

Without the release keystore, the result is unsigned and suitable only for compilation checks. The signed `geminUp.apk` is produced by the release workflow using encrypted GitHub Actions Secrets. The private key and passwords are never stored in the repository.

## License

[MIT](LICENSE)
