# Changelog / История изменений

All notable changes to this project are documented in this file.
Все значимые изменения проекта документируются в этом файле.

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
