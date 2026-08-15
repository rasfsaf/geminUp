# geminUp

`geminUp` — машинный транспорт для Windows 10/11, который направляет сетевые зависимости Google Gemini и Antigravity через пользовательский SOCKS5-прокси. Остальной трафик продолжает идти по обычной таблице маршрутизации Windows, включая уже подключённый VPN.

Это не VPN-клиент, не браузер, не Gemini-клиент и не API-обёртка.

## Возможности

- один BAT с меню включения, замены SOCKS5 и полного отключения;
- единая установка для всех пользователей компьютера;
- автозапуск фонового транспорта от `SYSTEM` при старте Windows;
- удалённое разрешение DNS для защищённых направлений через SOCKS5;
- fail-closed: при отказе SOCKS5 защищённое соединение получает HTTP 502 без прямого fallback;
- поддержка SOCKS5-аутентификации;
- шифрование конфигурации через Windows DPAPI `LocalMachine`;
- ACL каталога данных только для `SYSTEM` и локальных администраторов;
- сохранение и восстановление прежних системных proxy/browser policies;
- отключение непроксированного WebRTC и QUIC в поддерживаемых браузерах;
- отдельный bootstrap для загрузки проверенного release ZIP;
- fallback установки официального .NET Framework 4.8 при отсутствии компилятора.

## Быстрый запуск

### Полный архив — рекомендуемый способ

1. Скачай `geminUp.zip` со страницы [Releases](https://github.com/rasfsaf/geminUp/releases).
2. Сверь SHA-256 с файлом `geminUp.zip.sha256` либо используй bootstrap.
3. Распакуй архив полностью.
4. Запусти `geminUp.bat` и подтверди UAC.
5. Выбери пункт `1` и введи SOCKS5.

Не скачивай один `geminUp.bat` из исходников: рядом с ним нужны PowerShell-контроллер, C#-ядро и список доменов.

### Один bootstrap-файл

Скачай и запусти `geminUp-bootstrap.bat`. Он:

1. загрузит последний `geminUp.zip` из GitHub Releases;
2. загрузит опубликованный SHA-256;
3. проверит архив;
4. распакует версию в `%LOCALAPPDATA%\geminUp\releases`;
5. запустит проверенный `geminUp.bat`.

## Меню

```text
1. Enter SOCKS5 and enable
2. Change SOCKS5
3. Disable and remove from autostart
```

Поддерживаются форматы:

```text
host:port:username:password
socks5://username:password@host:port
```

Если логин или пароль содержит двоеточие либо специальные символы, используй URL-форму с percent-encoding.

После зелёного `SUCCESSFUL` полностью перезапусти открытые браузеры, чтобы оборвать старые Google-соединения.

## Как устроена маршрутизация

Windows направляет proxy-aware приложения на локальный HTTP/CONNECT transport `127.0.0.1:8877`.

```mermaid
flowchart LR
    A["Браузер или Antigravity"] --> B["geminUp 127.0.0.1:8877"]
    B -->|"Gemini / Antigravity hostname"| C["SOCKS5 + удалённый DNS"]
    B -->|"Остальной hostname"| D["Текущий Windows route / VPN"]
    C --> E["Google Gemini"]
```

Маршруты задаются в [`transport/domains.txt`](transport/domains.txt). Широких масок `*.google.com`, YouTube, `googlevideo.com` и `ytimg.com` там нет. Общие зависимости вроде `accounts.google.*`, `gstatic` и `googleusercontent` могут использоваться другими продуктами Google: различить продукты внутри одного hostname невозможно.

При недоступности SOCKS5 только защищённый маршрут блокируется без прямого соединения. Если завершится сам локальный процесс, приложения с системным proxy могут временно потерять весь доступ до автоматического перезапуска задачи.

## Браузеры и приложения

- Chrome, Edge и Brave используют машинный Windows proxy; политики отключают QUIC и непроксированный WebRTC UDP.
- Firefox получает машинные enterprise policies: системный proxy и отключённый WebRTC.
- Chromium/Electron-приложения, включая Antigravity, обычно наследуют системный proxy.
- Приложения с собственным proxy, `--no-proxy-server`, встроенным VPN или игнорированием WinINET не поддерживаются.

## Автозапуск и хранение

После включения создаётся задача `geminUp` с boot-trigger и учётной записью `SYSTEM`. Репозиторий после этого не нужен для фонового запуска.

Рабочие файлы находятся в:

```text
%ProgramData%\geminUp
```

Там хранятся скомпилированный `geminUp.exe`, DPAPI-конфигурация, install-state, PID и журнал. Пароль не передаётся через аргументы процесса и не пишется в журнал.

## Зависимости и fallback

Runtime не требует Visual Studio, .NET SDK, NuGet, Node.js или Python. Используются штатные компоненты Windows 10/11:

- Windows PowerShell 5.1;
- .NET Framework 4.8+ и `csc.exe`;
- системные модули Scheduled Tasks, Registry и TCP/IP.

Контроллер ищет `csc.exe` в 64- и 32-битных каталогах .NET Framework. Если компилятор отсутствует, geminUp запросит разрешение, скачает официальный установщик .NET Framework 4.8 с домена Microsoft, проверит цифровую подпись Microsoft и запустит установку. Возможна перезагрузка.

Windows PowerShell автоматически не восстанавливается: его отсутствие означает повреждённую или сильно урезанную Windows, которая не поддерживается.

## Отключение

Запусти `geminUp.bat` и выбери пункт `3`. Контроллер:

1. остановит только проверенный процесс geminUp;
2. удалит задачу автозапуска;
3. восстановит прежний машинный proxy;
4. восстановит исходные Chrome, Edge, Brave и Firefox policies;
5. удалит DPAPI-конфигурацию и install-state.

Скомпилированный EXE и журнал могут остаться в `%ProgramData%\geminUp`, но без задачи и конфигурации они неактивны.

## Совместимость и ограничения

Поддерживаются стандартные настольные редакции Windows 10 и Windows 11 с правами локального администратора. Windows 7, Windows Server, ARM-системы, модифицированные сборки без PowerShell/.NET и UDP-only приложения не обещаются.

`geminUp` защищает сетевой маршрут. Он не подменяет геолокацию браузера, часовой пояс, SIM, историю аккаунта, cookies или fingerprint. Качество и география SOCKS5 остаются ответственностью пользователя.

## Разработка и тесты

Runtime-файлы:

```text
geminUp.bat
geminUp.ps1
transport/GeminUp.cs
transport/domains.txt
```

Python нужен только интеграционному тесту и не нужен пользователям:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\Test-GeminUp.ps1
```

Тест компилирует ядро, поднимает loopback SOCKS5, проверяет direct-route, Gemini-route, Antigravity-route и fail-closed. Он не меняет системный proxy, registry или Scheduled Tasks.

## Лицензия

[MIT](LICENSE)
