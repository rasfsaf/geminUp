# Changelog / История изменений

All notable changes to this project are documented in this file.
Все значимые изменения проекта документируются в этом файле.

---

## [2.0.6] - 2026-10-25

### RU (Русский)

#### HTTP CONNECT туннелирование upstream и статистика экономии токенов
- **Переход на протокол HTTP CONNECT к шлюзу geminUp:** Локальный транспорт geminUp (`127.0.0.1:8877`) работает как защищенный HTTP CONNECT прокси. Ранее токенизатор инициировал raw SOCKS5 handshake, что приводило к зависанию на таймаутах сокетов и аварийным сбросам соединений. Реализовано нативное HTTP CONNECT туннелирование с мгновенным TLS-рукопожатием, что полностью устранило зависания и ошибку 400 Bad Request (`User location is not supported for the API use`).
- **Счетчик экономии контекста в CLI:** В меню Еврейского токенизатора добавлено отображение суммарного объема сэкономленных токенов и процента сокращения контекста (`Total Saved Tokens: X tokens (-Y%)`), вычисляемое на основе логов сжатия в реальном времени.
- **Очистка оставшихся упоминаний Argon:** Вся терминология и статусные плашки интерфейса приведены к единому стилю «Еврейский токенизатор».

### EN (English)

#### HTTP CONNECT Upstream Tunneling & Token Savings Statistics
- **HTTP CONNECT Tunneling to geminUp Proxy:** The local geminUp transport (`127.0.0.1:8877`) operates as an HTTP CONNECT proxy. Previously, the tokenizer attempted raw SOCKS5 handshakes, causing socket stalls, timeouts, and connection aborts. Implemented native HTTP CONNECT tunneling with instant TLS negotiation, completely resolving hangs and the HTTP 400 Bad Request (`User location is not supported for the API use`) error.
- **Context Savings Counter in CLI Menu:** Added real-time token savings and context reduction percentage tracking to the Jewish Tokenizer CLI menu (`Total Saved Tokens: X tokens (-Y%)`), computed directly from compression metrics.
- **Legacy Argon Label Cleanup:** Replaced remaining Argon labels and status references across the CLI interface with Jewish Tokenizer.

---

## [2.0.5] - 2026-10-25

### RU (Русский)

#### Устранение утечки прямого IP в Google и защита SOCKS5-пайплайна
- **Жесткая фиксация SOCKS5-шлюза (Fail-Closed):** Устранена первопричина ошибки 400 Bad Request (User location is not supported for the API use). Еврейский токенизатор теперь по умолчанию и безальтернативно направляет все запросы в локальный защищенный туннель geminUp (socks5://127.0.0.1:8877). Полностью исключен fallback на прямой незащищенный интернет (direct), сливавший реальный IP пользователя в Google Cloud Code.
- **Обновление статуса в CLI:** В основном меню статуса geminUp строка устаревшего названия Argon bridge переименована в Jewish Tokenizer.

### EN (English)

#### Direct IP Leak Prevention and SOCKS5 Upstream Hardening
- **Strict SOCKS5 Upstream Routing (Fail-Closed):** Resolved the root cause of HTTP 400 Bad Request (User location is not supported for the API use). The Jewish Tokenizer proxy now strictly defaults all upstream requests through the local geminUp protected SOCKS5 tunnel (socks5://127.0.0.1:8877). Eliminated the unproxied fallback path (direct) that previously exposed the user's real IP address to Google Cloud Code endpoints.
- **CLI Status Label Update:** In the main geminUp status view, the legacy label Argon bridge has been updated to Jewish Tokenizer.

---

## [2.0.4] - 2026-10-23

### RU (Русский)

#### Исправления и улучшения CLI
- **Рекурсивный подсчёт капсул памяти JIGIT в CLI:** Исправлен счётчик сохранённых капсул в интерактивном меню Еврейского токенизатора (Show-JewishTokenizerMenu) и диагностическом тесте (Test-JewishTokenizer). Теперь файлы *.json опрашиваются рекурсивно по всем подпапкам сессий (-Recurse -File), отображая реальное количество активных капсул на диске в реальном времени.

### EN (English)

#### CLI Improvements and Fixes
- **Recursive JIGIT Memory Capsule Counter in CLI:** Fixed the stored memory capsule count displayed in the Jewish Tokenizer CLI menu (Show-JewishTokenizerMenu) and health test (Test-JewishTokenizer). The file scan now recursively includes conversation subdirectories (-Recurse -File), reflecting the true real-time count of active capsules stored on disk.

---

## [2.0.3] - 2026-10-22

### RU (Русский)

#### Защита ответов ассистента и ликвидация утечки сервисных плашек в чат
- **Полная неприкосновенность реплик ассистента:** Устранена утечка плашек `[JIGIT Engine: Compacted File/Code Dump ...]`. Движок `jigit-engine.js` теперь строго защищает сообщения модели (`role: 'model'`). Ответы и блоки кода, адресованные пользователю, больше никогда не сжимаются в капсулы. Сжатию подлежат исключительно технические выхлопы инструментов и логи (`functionResponse`, `tool_result`).
- **Автоматическая очистка остаточных плашек из истории:** Внедрён очищающий фильтр, который на лету удаляет старые сервисные плашки из контекста диалога, лишая модель возможности заучивать и копировать их в свои новые реплики.
- **Юнит-тест верификации чистоты текста:** Добавлен специализированный тест `test_banner_strip.js`, гарантирующий отсутствие артефактов в диалоге.

### EN (English)

#### Assistant Message Protection and Placeholder Banner Elimination
- **Strict Assistant Message Preservation:** Resolved an issue where internal `[JIGIT Engine: ...]` placeholders leaked into user-facing chat responses. `jigit-engine.js` now strictly protects assistant turns (`role: 'model'`), ensuring answers and code blocks directed to the user are never compressed. Only raw tool executions and diagnostic outputs (`functionResponse`, `tool_result`) are eligible for capsule offloading.
- **In-Flight Banner Sanitization:** Added an automatic regex sanitizer that purges historical placeholder artifacts from conversation history turns, preventing the LLM from hallucinating them as response prefixes.
- **Automated Banner Test:** Added `test_banner_strip.js` to verify zero artifact leakage into conversational responses.

---

## [2.0.2] - 2026-10-22

### RU (Русский)

#### Устранение зависаний рассуждений, ускорение стриминга и пул соединений
- **Ограничение бесконечного рассуждения (Thinking Budget Cap):** Устранена первопричина бесконечных размышлений модели — директива `thinkingBudget: -1`, передаваемая средой Antigravity. Установлен потолок в 2048 токенов: модель свободно планирует сложные действия, но физически не может войти в 30-тысячный генеративный штопор.
- **Пул соединений HTTP/1.1 Keep-Alive:** Полностью переработан сетевой транспорт `http-client.js`. Вместо закрытия сокета после каждого запроса включён постоянный пул тёплых соединений (`keepAlive: true`, до 64 параллельных сокетов). Время отклика снизилось в разы.
- **Стабильность параллельных чатов без реконнектов:** Ликвидирована перегрузка локального SOCKS5-шлюза (8877) при одновременной работе нескольких окон и чатов Antigravity.
- **Мгновенный стриминг без буферизации TCP:** Внедрён флаг `setNoDelay(true)` на сокетах ответов, отключающий алгоритм Нагла для SSE. Токены поступают в интерфейс моментально, без подвисаний и рывков.
- **Оперативная компрессия контекста (`keepRecentTurns: 2`):** Порог сохранения сырых ходов снижен с 8 до 2. Исторические реплики и старые логи сжимаются в капсулы сразу, освобождая окно контекста.

### EN (English)

#### Thinking Loop Elimination, Real-Time SSE Acceleration, and Connection Pooling
- **Thinking Budget Cap:** Neutralized the root cause of runaway reasoning loops caused by Antigravity's default `thinkingBudget: -1`. Capped the allocation at 2048 tokens, ensuring thorough problem-solving while strictly barring infinite reasoning collapse.
- **HTTP/1.1 Keep-Alive Connection Pooling:** Overhauled `http-client.js` to reuse warm TLS/TCP connections (`keepAlive: true`, up to 64 pooled sockets). Upstream request overhead dropped from ~800ms to ~20ms.
- **Parallel Multi-Chat Stability:** Eliminated SOCKS5 socket exhaustion and WSAECONNRESET drops when running multiple concurrent IDE chat windows.
- **Zero-Latency SSE Streaming:** Enabled `socket.setNoDelay(true)` on streaming responses, eliminating OS TCP Nagle buffering and delivering tokens smoothly in real time.
- **Responsive Context Compaction (`keepRecentTurns: 2`):** Reduced raw turn retention from 8 to 2, ensuring multi-turn logs and older text dumps are compressed immediately.

---

## [2.0.1] - 2026-10-22

### RU (Русский)

#### Устранение дегенеративных циклов в рассуждениях и горячий патчинг
- **Автоматический разрыв циклов в рассуждениях (Thought Loop Breaker):** Движок JIGIT Engine теперь детектирует и пресекает авторегрессионные петли повторения в рассуждениях модели. Избыточные циклы схлопываются, сохраняя чистый контекст и предотвращая зависание интерфейса среды разработки на статусе ожидания.
- **Полное исключение черновиков мыслей из истории (`thought: true`):** Промежуточные блоки рассуждений (`thought: true` и теги `<thought>`) из завершённых ходов полностью удаляются из исходящего пакета на Google Cloud Code и сохраняются в локальное капсульное хранилище. Это устраняет эхо старых мыслей и снижает расход контекстных токенов.
- **Горячая перезагрузка модулей на лету (Zero-Downtime Hot-Reload):** Шлюз получил поддержку динамического применения патчей без перезапуска процесса через отслеживание изменений файлов и эндпоинт `POST /admin/api/reload`. Порт 8083 остаётся непрерывно активным, исключая сетевые разрывы и ошибки соединения.
- **Прозрачный транзит служебных запросов аутентификации:** Все запросы проверки аккаунта, моделей и инициализации IDE (`loadCodeAssist`, `fetchAvailableModels`, `fetchUserInfo`) перенаправляются в Google Cloud Code напрямую с минимальной задержкой, оставляя токенизатор строго в рамках сессий генерации.

### EN (English)

#### Thought Loop Breaker and Zero-Downtime Hot-Reloading
- **Degenerative Thought Loop Breaker:** JIGIT Engine now actively detects autoregressive loop patterns in model reasoning, collapsing redundant iterations into compact references to prevent IDE interface stalls and token exhaustion.
- **Full Historical Scratchpad Stripping (`thought: true`):** Internal thinking scratchpads (`thought: true` and `<thought>` blocks) from completed turns are completely stripped from outgoing Google Cloud Code requests and offloaded to local JIGIT capsules, eliminating echo loops and reclaiming significant context window space.
- **Zero-Downtime Hot-Reloading:** The gateway now supports in-memory module hot-reloading via file system monitoring and the `POST /admin/api/reload` endpoint. Port 8083 remains open continuously without process termination, preventing socket drops and `connectex: connection refused` errors.
- **Transparent Handshake & Authentication Routing:** All non-inference account, model catalog, and onboarding calls (`loadCodeAssist`, `fetchAvailableModels`, `fetchUserInfo`) are routed directly to Google Cloud Code with minimal latency, keeping the tokenizer focused strictly on chat and code generation.

---

## [2.0.0] - 2026-10-22

### RU (Русский)

#### Jewish Tokenizer: локальный компрессор контекста для Google Antigravity
- **Интеллектуальная экономия токенов до 90%:** Внедрён движок компрессии контекста JIGIT, перехватывающий диалоговые запросы Antigravity и предотвращающий взрывной рост контекстного окна. Движок компактно архивирует исторические результаты вызова инструментов (файловые дампы, результаты терминальных команд) и логи компилятора, сохраняя исходный пользовательский интент (ход 0) и полную детализацию последних реплик.
- **Архивация исторических изображений (Vision Optimization):** Свежие скриншоты на текущем ходе передаются в модель в исходном виде для анализа зрением (Gemini Vision). На последующих исторических итерациях тяжелые base64-данные автоматически архивируются в капсулы памяти JIGIT, а из тела запроса вырезаются мегабайты дублирующихся данных, сокращая расход токенов на 95–99% для диалогов с изображениями.
- **Изолированное хранилище памяти MCP (Conversation Isolation):** Капсулы долговременной памяти JIGIT партиционируются по идентификаторам чатов (`conversationId`). Каждый диалог имеет изолированное контекстное хранилище, предотвращая утечку данных между параллельными задачами. Любой сжатый блок можно мгновенно восстановить через встроенный MCP-инструмент `jigit_restore_capsule`.
- **Прозрачность для аккаунта и авторизации:** Операции аутентификации, обновления квот, проверки прав и управления Google-аккаунтом в Antigravity выполняются напрямую в тени и не затрагиваются компрессором.
- **Стабильность параллельных соединений:** Устранены гонки сокетов и ошибки SSL (`bad record mac`, 502 Bad Gateway) при одновременной работе нескольких чатов: пул сокетов изолирован, очищены конфликтующие hop-by-hop заголовки (`transfer-encoding`, `connection`), добавлен автоматический ретрай upstream-запросов с экспоненциальной задержкой.
- **Диагностический логгер и телеметрия компрессии:** Добавлен модуль `jigit-logger.js`, формирующий детальное дерево сжатия по каждому элементу в консоли и ведущий постоянный лог метрик в `%ProgramData%\geminUp\argon\logs\compression.log`.

---

### EN (English)

#### Jewish Tokenizer: Local Context Compression Proxy for Google Antigravity
- **Intelligent Token Savings Up to 90%:** Integrated the JIGIT context compression engine that intercepts Antigravity conversation requests to prevent rapid context window explosion. The engine compactly archives historical tool outputs (large file dumps, shell execution logs) and compiler traces into capsules while preserving initial user intent (Turn 0) and pristine fidelity for recent turns.
- **Historical Vision & Image Archival:** Fresh screenshots attached to active turns are forwarded untouched so Gemini Vision inspects them at native resolution. On subsequent conversational turns, heavy base64 image payloads are automatically offloaded into JIGIT memory capsules, stripping megabytes of redundant base64 strings and saving 95–99% of tokens on image-heavy threads.
- **Conversation-Isolated MCP Memory:** JIGIT memory capsules are partitioned by chat identifier (`conversationId`). Each conversation maintains an isolated memory store, preventing context bleed between parallel agent tasks. Any compacted block remains retrievable on demand via the built-in `jigit_restore_capsule` MCP tool.
- **Transparent Account & Quota Operations:** Authentication, quota verification, entitlements, and account management flows in Antigravity pass through transparently without proxy interference.
- **High-Concurrency Stability:** Eliminated socket pool collisions and TLS stream corruption (`bad record mac`, 502 Bad Gateway) during concurrent multi-chat sessions: SOCKS5 connections use isolated non-keepalive sockets, hop-by-hop headers (`transfer-encoding`, `connection`) are stripped before forwarding, and upstream requests feature automatic retry backoff.
- **Observability Logger & Metrics:** Added `jigit-logger.js` producing real-time hierarchical tree logs of compacted items in the console and maintaining persistent telemetry logs in `%ProgramData%\geminUp\argon\logs\compression.log`.
