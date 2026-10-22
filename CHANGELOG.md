# Changelog / История изменений

All notable changes to this project are documented in this file.
Все значимые изменения проекта документируются в этом файле.

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
