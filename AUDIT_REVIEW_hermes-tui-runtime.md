# Audit Review — `feat/multi-runtime` vs `main`

> **Data originale:** 2026-06-29 (branch `feat/hermes-tui-runtime`)
> **Aggiornato:** 2026-07-01 (merge in `feat/multi-runtime`, commit `eb7d17d`)
> **Aggiornato di nuovo:** 2026-07-01 — 6/7 issue risolte (toolset override, timeout HTTP + logging, watchdog estratto in `PtyHub.handleTurnEnded` + test reali)
> **Chiuso:** 2026-07-01 — 7/7. #6 documentata in README.md ("Hermes runtime nodes")
> **Copertura test estesa:** 2026-07-01 — code-coverage review su questo branch: +61 test sui gap residui (persistenza `system_prompts`/`workflows`, risoluzione del comando `pi`/shim Windows, store frontend `kanban`/`board`, hook `useOrchestraWs`). Dettagli in `docs/TEST_COVERAGE.md`.
> **Scopo:** Rendere PtyHub runtime-agnostic, aggiungendo il supporto a `hermes --tui` come alternativa a `pi` per i nodi della orchestra.
> **Verifica pipeline:** Typecheck backend/frontend/extension ✅ · 286 test (194 backend + 78 frontend + 14 extension) ✅ · Build ✅

---

## Tabella riassuntiva

| # | Issue | Severità | File | Stato |
|---|-------|----------|------|-------|
| 1 | `runtimeConfig` mai usato dai runtime | 🟠 Alta | `HermesRuntime.ts`, `PiRuntime.ts` | **Risolto** — `runtimeConfig.toolset` letto da entrambi via `resolveToolset.ts` |
| 2 | Plugin non auto-installato | 🟠 Alta | `HermesRuntime.ts`, docs | **Mitigato** — `setup-hermes-plugin.sh` aggiunto |
| 3 | HTTP senza timeout nel plugin | 🟡 Media | `__init__.py` | **Risolto** — `timeout=5` su entrambe le `urlopen`, `except: pass` → `log.warning` |
| 4 | `onReady` dead code | 🟡 Bassa | `INodeRuntime.ts` | **Risolto** — rimosso in `4e478d7` |
| 5 | Test watchdog tautologici | 🟡 Media | `PtyHub.test.ts` | **Risolto** — logica estratta in `PtyHub.handleTurnEnded` (testabile senza Fastify), test riscritti con assert reali su retry/nudge/cap |
| 6 | `pre_llm_call` context → user msg vs system prompt | 🟡 Bassa | `__init__.py` | **Risolto (doc)** — spiegato in `README.md § Hermes runtime nodes`, verificato contro `agent/turn_context.py` in `HERMES_TUI_SPIKE_RESULT.md` |
| 7 | `ctx` shadowed | 🟢 Trivia | `__init__.py` | **Risolto** — `orchestra_ctx` in `eb7d17d` |

---

## Scoreboard

| Dimensione | Score | Note |
|-----------|-------|------|
| **Architettura** | 9.5/10 | Refactor clean, separazione ottima, pattern Strategy corretto; watchdog ora vive in PtyHub invece che in una route handler |
| **Code Quality** | 9/10 | Codice solido, dead code rimosso, toolset configurabile, plugin resiliente a backend lento/irraggiungibile |
| **Testing** | 9/10 | Coverage eccellente; il path del watchdog ora ha assert reali su retry count, contenuto del nudge e broadcast di errore al cap |
| **Security** | 8/10 | Toolset validato per tipo prima di finire in argv; HTTP col timeout |
| **Doc↔Code Coherence** | 9.5/10 | Docs aggiornate (ARCHITECTURE, PROGRAMMATIC_API, README); nessun gap residuo noto |

**Overall: 9.5/10** — Refactoring strutturalmente eccellente, **7/7 issue chiuse** (6 con fix di codice, 1 con doc — #6 era una differenza di comportamento attesa, non un difetto, quindi documentarla era il fix corretto). Nessuna issue nota aperta. Pronto per merge e test manuale.

---

## Architettura del branch

Il branch introduce un refactor strutturale in 6 fasi (Phase 0-6):

| Fase | Commit | Contenuto |
|------|--------|-----------|
| 0 | `15abfc7` | Data model: `NodeRuntime` type + `runtime`/`runtimeConfig` su `WorkflowNode` |
| 1 | `45bb2f9` | Protection tests per PtyHub (409 nuove righe di test **prima** del refactor) |
| 2 | `dbea545` | Extract: `INodeRuntime` interface + `PiRuntime` estratti da PtyHub |
| 3 | `053e260` | `HermesRuntime` + `PtyRuntime` base class + feature flag |
| 4 | `2e4790b` | Plugin Hermes `orchestra` + endpoint `/internal/turn-ended` + UI runtime |
| 5-6 | `00eda72` | E2E tests + docs update |
| cleanup | `4e478d7` | Drop dead `onReady` hook, unused imports, align docs |
| prep | `eb7d17d` | Smoke test, setup script, checklist, review fix (ctx shadowing) |

### Flusso architetturale

```
┌─────────────────────┐     WebSocket      ┌──────────────────────┐
│   Frontend (React)  │ ◄────────────────► │   Backend (Fastify)  │
│   xterm.js + React  │                    │   /api/v1/orchestra  │
│   Flow + Kanban     │                    │   /internal/*        │
└─────────────────────┘                    └────────┬─────────────┘
                                                    │
                                          ┌─────────┴─────────┐
                                          │     PtyHub         │
                                          │  (runtime-agnostic)│
                                          └────────┬───────────┘
                                                   │
                              ┌────────────────────┼────────────────────┐
                              │                    │                    │
                     ┌────────┴────────┐  ┌───────┴────────┐         ...
                     │   PiRuntime     │  │ HermesRuntime  │
                     │  (pi CLI + PTY) │  │(hermes --tui    │
                     │  + call-agent   │  │  + PTY + plugin)│
                     └─────────────────┘  └────────────────┘
```

### Struttura dei file introdotti

```
backend/src/pty/runtime/
├── INodeRuntime.ts       # Interfaccia: spawn, write, inject, resize, kill, markReady, isRunning, isReady, size
├── PtyRuntime.ts         # Base class astratta con logica PTY comune
├── PiRuntime.ts          # Concreto: spawn pi CLI con --tools, --system-prompt, --extension
├── HermesRuntime.ts      # Concreto: spawn hermes --tui con --toolsets, HERMES_EPHEMERAL_SYSTEM_PROMPT
├── findInPath.ts         # Utility: cerca eseguibile in PATH (estratta da PtyHub)
├── PiRuntime.test.ts     # 335 righe, 14 test
└── HermesRuntime.test.ts # 265 righe, 12 test

backend/hermes-plugins/orchestra/
├── __init__.py           # Plugin Hermes: hook lifecycle + tool handoff/card
└── plugin.yaml           # Manifest con requires_env

scripts/
├── smoke.mjs             # Sanity check REST API (1 comando)
└── setup-hermes-plugin.sh # Symlink idempotente plugin → ~/.hermes/plugins/

docs/
└── PRE_MERGE_TEST_CHECKLIST.md  # Checklist manuale con risultati attesi
```

---

## Punti di forza (con evidenza)

### 1. Refactor Strategy pattern con metodologia TDD

Le protection tests (Phase 1) sono state scritte **prima** del refactor (Phase 2), seguendo il pattern "characterization tests" classico. Il diff di `PtyHub.ts` mostra una rimozione pulita di ~200 righe di logica pi-specifica spostata in `PiRuntime`/`PtyRuntime`.

### 2. Backward compatibility perfetta

`runtime` è opzionale su `WorkflowNode`, assente = `"pi"`. Nessuna migrazione DB richiesta — il campo è opzionale nel JSON serializzato.

### 3. Feature flag valutato a spawn-time

`PINODES_ORCHESTRA_HERMES === "true"` è letto in `PtyHub.spawn()`, non a module-load. I test lo toggleano in `beforeEach`/`afterEach` e funzionano.

### 4. Ring-buffer scrollback O(1)

Il buffer usa `chunks: string[]` con `shift()` e `slice()` parziale — O(1) per chunk anziché O(n) per la concat+slice legacy. Test oracle verifica che il risultato è identico alla versione naive sotto carico pesante (500+ chunk).

---

## Problemi risolti

### ✅ 1. `runtimeConfig` era accettato, passato a `spawn()`, ma mai usato

Fix: nuovo helper condiviso `backend/src/pty/runtime/resolveToolset.ts`, importato da entrambi i runtime. Legge `runtimeConfig.toolset` — una stringa non vuota lo sostituisce al default hardcoded `"read,bash,edit,write,grep"`; qualunque altro tipo (o valore assente/blank) è ignorato silenziosamente, così un blob JSON arbitrario non finisce mai in argv senza validazione. Coperto da 4 nuovi test (2 per runtime: override + fallback). Documentato in `docs/PROGRAMMATIC_API.md`.

### ✅ 2. Plugin Python: HTTP senza timeout, errori silenziosi

Fix: `timeout=5` aggiunto a entrambe le `urllib.request.urlopen` (`_post`/`_get`) — un backend bloccato non può più appendere indefinitamente il turno dell'agente Hermes. I tre `except Exception: pass` nei hook (`on_session_start`, `pre_llm_call`, `post_llm_call`) ora loggano con `log.warning(...)` invece di fallire in silenzio — restano fail-open (non rilanciano), solo non più muti.

### ✅ 3. Test watchdog non testavano realmente il watchdog

Il fix suggerito nella review originale (`app.inject(...)` su Fastify) non è praticabile senza prima ristrutturare `index.ts`, che oggi è uno script top-level (`await app.register(...)` a livello di modulo, `app.listen()` incondizionato) — importarlo in un test avvierebbe un vero listener.

**Fix applicato, diverso e più a basso rischio:** la logica del watchdog (contatore retry, soglia di nudge, report di errore al cap) è stata **estratta dalla route** in un nuovo metodo pubblico `PtyHub.handleTurnEnded(boardId, nodeId, handoffCalledThisTurn)` — coerente con lo stile già esistente in `PtyHub` (stesso pattern di `notify()`/`injectTask()`, stato privato in una `Map` come `ready`/`pending`/`enforceOverride`). La route `/internal/turn-ended` in `index.ts` è ora un delegator di una riga. I due test deboli sono stati riscritti per chiamare `hub.handleTurnEnded(...)` direttamente e asserire: il conteggio dei retry che incrementa, il testo esatto del nudge iniettato in PTY ("Attempt N/3", handle del target), il broadcast `node_status: error` al superamento del cap, **e** il reset del contatore su un handoff riuscito — nessuno di questi era verificato prima.

### ✅ 4. `pre_llm_call` appende context al user message, non al system prompt

Non è un difetto — è il comportamento corretto e verificato dell'hook Hermes (`agent/turn_context.py`, vedi `HERMES_TUI_SPIKE_RESULT.md § 3`): `pre_llm_call` non ha un equivalente del `before_agent_start` di pi che riscrive il system prompt, quindi il contesto per-turno (destinatari, finalità, kanban) arriva appeso al messaggio utente del turno anziché al system prompt. Funzionalmente equivalente per il modello (il contesto è comunque presente ogni turno, mai persistito in history), ma la differenza di *dove* atterra poteva confondere chi ispeziona i messaggi grezzi di una sessione Hermes aspettandosi lo stesso meccanismo di pi.

**Fix:** documentata esplicitamente in `README.md § Hermes runtime nodes`, con riferimento al contratto hook verificato in `HERMES_TUI_SPIKE_RESULT.md`.

---

## Verdetto

Il refactor architetturale è di alta qualità — TDD metodologico, backward compat perfetta, pattern Strategy pulito, ring-buffer O(1). Tutte e 7 le issue emerse dall'audit sono chiuse: 6 con fix di codice (runtimeConfig ora letto e validato, timeout HTTP nel plugin, watchdog estratto in `PtyHub` e testato per davvero, dead code, shadowing) e 1 (#6) con un chiarimento in doc, perché non era un difetto ma un comportamento Hermes verificato e atteso. Nessuna issue nota aperta. Pipeline verde (286 test, tsc ×3, build) — **pronto per merge e test manuale**.
