# geminUp

`geminUp` — открытый проект для доступа к Google Gemini через пользовательский SOCKS5-прокси.

В проект входят два разных компонента:

- Windows 10/11: машинный транспорт для Gemini и Antigravity, работающий с обычными браузерами и приложениями;
- Android 7+: отдельный WebView-клиент Gemini с собственным локальным HTTP→SOCKS5-мостом.

Android-приложение не является VPN и не перехватывает трафик других приложений. Пользователь может одновременно сохранить системный VPN и отдельно направить встроенный Gemini через SOCKS5.

## Возможности

- один BAT с меню включения, замены SOCKS5, применения обновления и полного отключения;
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

### Android

1. Скачай единственный `geminUp.apk` со страницы [Releases](https://github.com/rasfsaf/geminUp/releases).
2. При желании сверь `geminUp.apk.sha256` и [сертификат подписи](android/signing-certificate.pem).
3. Разреши установку APK из выбранного браузера или файлового менеджера.
4. Открой geminUp, нажми `+`, введи SOCKS5 и включи его.

Публичный package ID: `io.github.rasfsaf.geminup`. APK подписан постоянным release-ключом проекта. Ранняя debug-сборка `com.gemini.fulldostup` не обновляется поверх release-версии: её нужно один раз удалить.

Приложение запрашивает только `INTERNET` и `ACCESS_NETWORK_STATE`. Доступ к реальной геолокации не запрашивается.

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
4. Apply downloaded update and restart
```

Поддерживаются форматы:

```text
host:port:username:password
socks5://username:password@host:port
```

Если логин или пароль содержит двоеточие либо специальные символы, используй URL-форму с percent-encoding.

После зелёного `SUCCESSFUL` полностью перезапусти открытые браузеры и Antigravity, чтобы оборвать старые прямые соединения.

## Как применить обновление Windows-версии

Просто скачать и заменить файлы недостаточно. Работающий transport запускается из уже скомпилированного `%ProgramData%\geminUp\geminUp.exe` и сам от замены исходников не обновится.

После каждого скачивания новой версии:

1. распакуй новый архив поверх старых исходников;
2. запусти `geminUp.bat` и подтверди UAC;
3. выбери пункт `4. Apply downloaded update and restart`;
4. полностью закрой и заново открой Antigravity и браузеры.

Пункт 4 не просит повторно вводить SOCKS5: он пересобирает EXE, перечитывает `transport/domains.txt`, переустанавливает задачу автозапуска, обновляет ярлыки Antigravity и перезапускает transport с уже сохранённой DPAPI-конфигурацией.

## Как устроена маршрутизация Windows

Windows направляет proxy-aware приложения на локальный HTTP/CONNECT transport `127.0.0.1:8877`.

```mermaid
flowchart LR
    A["Браузер через Windows proxy"] --> B["geminUp 127.0.0.1:8877"]
    AG["Antigravity launcher"] --> B
    B -->|"Gemini / Antigravity hostname"| C["SOCKS5 + удалённый DNS"]
    B -->|"Остальной hostname"| D["Текущий Windows route / VPN"]
    C --> E["Google Gemini"]
```

Маршруты задаются в [`transport/domains.txt`](transport/domains.txt). Широких масок `*.google.com`, YouTube, `googlevideo.com` и `ytimg.com` там нет. Общие зависимости вроде `accounts.google.*`, `gstatic` и `googleusercontent` могут использоваться другими продуктами Google: различить продукты внутри одного hostname невозможно.

При недоступности SOCKS5 только защищённый маршрут блокируется без прямого соединения. Если завершится сам локальный процесс, приложения с системным proxy могут временно потерять весь доступ до автоматического перезапуска задачи.

## Браузеры и приложения

- Chrome, Edge и Brave используют машинный Windows proxy; политики отключают QUIC и непроксированный WebRTC UDP.
- Firefox получает машинные enterprise policies: системный proxy и отключённый WebRTC.
- Antigravity запускается через изменённые ярлыки. Только его процесс и дочерние `language_server.exe`, `node.exe` и sidecar получают локальные proxy-переменные; глобальные environment variables не создаются.
- Прямой запуск оригинального `Antigravity.exe` в обход управляемого ярлыка не поддерживается и обходит process-scoped настройку.
- Приложения с собственным proxy, `--no-proxy-server`, встроенным VPN или игнорированием WinINET не поддерживаются.

## Как устроен Android-клиент

Android-приложение открывает `gemini.google.com` только во встроенном WebView. Внутри процесса поднимается loopback HTTP proxy на случайном порту `127.0.0.1`, который преобразует запросы WebView в SOCKS5 с удалённым разрешением DNS.

Системный VPN Android при этом не выключается и не заменяется. Другие приложения, браузеры и системный трафик через geminUp не проходят.

Приложение подменяет доступную странице геолокацию, locale и timezone на значения Великобритании, но не получает реальную геолокацию устройства. Настройки SOCKS5 и их история шифруются ключом из Android Keystore и остаются на устройстве.

Подробнее: [политика конфиденциальности](PRIVACY.md).

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

Android-клиент поддерживает Android 7.0 (API 24) и новее при наличии системного WebView с поддержкой `PROXY_OVERRIDE`. Он работает только со встроенным Gemini и не обещает маршрутизацию других Android-приложений.

## Разработка и тесты

Runtime-файлы:

```text
geminUp.bat
geminUp.ps1
transport/GeminUp.cs
transport/domains.txt
geminUp.apk
android/
```

Python нужен только интеграционному тесту и не нужен пользователям:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\Test-GeminUp.ps1
```

Тест компилирует ядро, поднимает loopback SOCKS5, проверяет direct-route, Gemini-route, endpoint языка Antigravity, наследование proxy только дочерним процессом launcher и fail-closed. Он не меняет реальные ярлыки, системный proxy, registry или Scheduled Tasks.

Android собирается фиксированным Gradle Wrapper без системного Gradle:

```powershell
cd android
.\gradlew.bat :app:assembleRelease
```

Без release-keystore получится неподписанный результат для проверки компиляции. Подписанный `geminUp.apk` создаёт release workflow из зашифрованных GitHub Actions Secrets. Приватный ключ и пароли никогда не хранятся в репозитории.

## Лицензия

[MIT](LICENSE)
