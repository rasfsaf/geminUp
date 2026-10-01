# geminUp Agent Guidelines

## 1. Modularity & Single Responsibility
- Maintain strict boundary between:
  - Windows Core (`transport/GeminUp.cs`)
  - PowerShell Orchestration (`geminUp.ps1`)
  - Android Client (`android/`)
  - Domain rules & Routing (`transport/domains.txt`)
- Avoid creating oversized monolithic scripts or classes (target < 300–500 lines).

## 2. Security & Zero-Leakage Policy
- Windows DPAPI `LocalMachine` for secret encryption.
- Fail-closed routing: never fall back to plaintext unproxied connections for protected Gemini domains.
- No plaintext credentials in logs, CLI arguments, or repository.
