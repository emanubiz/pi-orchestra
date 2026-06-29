# Hermes TUI Runtime — Piano Implementativo (Test-First, Cauto e Prudente)

> **Data:** 2026-06-28
> **Revisione:** 2026-06-29 (v3) — **architettura decisa dopo indagine sul web**: path A (`hermes --tui` in PTY + plugin Hermes). Il path "gateway/JSON-RPC" è scartato. Mappatura pi→Hermes completa. Vedi *Changelog revisione* in fondo.
> **Stato:** Solo piano — nessuna modifica al codice
> **Principio guida:** Ogni fase inizia con i test. Mai modificare il comportamento esistente senza prima avere test che lo catturano. Backward compatibility sempre garantita.

---

## Decisione architetturale — PATH A (`hermes --tui` in un PTY)

Un nodo Hermes = **un processo `hermes --tui` lanciato in un PTY**, esattamente come un nodo pi lancia un processo `pi`. Niente servizio esterno, niente gateway JSON-RPC.

**Perché path A (e non il gateway):**

- `hermes --tui` è **autosufficiente**: *"By default the TUI spawns its own in-process gateway, so each TUI instance is self-contained — there's nothing to configure"* (doc ufficiale). Nessun `hermes dashboard` da tenere acceso.
- L'output è la **Ink TUI renderizzata come ANSI** in un terminale → **xterm la disegna gratis**, zero lavoro di rendering frontend. (È esattamente ciò che già facciamo per pi.)
- È la modalità che l'utente vuole (UI più bella) ed è quella **raccomandata** da Nous per l'uso interattivo.
- Combacia con la filosofia di Orchestra (*terminali vivi dentro ogni nodo, intervento umano digitando nel terminale*).

**Perché NON il gateway (path B, scartato):** richiederebbe `hermes dashboard --tui` sempre attivo (parte mobile esterna + token che si rigenera), gli eventi sarebbero JSON strutturati **non** ANSI (→ lavoro di rendering frontend sostanziale), e non porta alcun vantaggio per il nostro caso d'uso. Restava un'opzione solo perché i doc precedenti l'avevano assunta senza verificarla.

---

## Mappatura pi → Hermes (parità piena di feature)

Hermes ha un **sistema di plugin/hook completo** (`~/.hermes/plugins/`): un plugin Python registra **tool custom** (che possono fare HTTP) **e** **hook di ciclo di vita** via `ctx.register_hook()`, e legge le **env var** impostate allo spawn. È l'equivalente — più ricco — dell'`--extension call-agent.ts` di pi.

| Cosa fa pi | Equivalente Hermes | Stato |
|---|---|---|
| `--system-prompt <ruolo>` | env **`HERMES_EPHEMERAL_SYSTEM_PROMPT=<ruolo>`** allo spawn (per-processo → isolato per nodo, come pi) | ✅ |
| `--tools read,bash,edit,write,grep` | `--toolsets "..."` | ✅ |
| `--extension call-agent.ts` | un **plugin** `~/.hermes/plugins/orchestra/` (tool + hook) | ✅ |
| cwd (da node-pty) | cwd (da node-pty) — identico | ✅ |
| env `PINODES_ORCHESTRA_URL/_BOARD/_NODE/_TOKEN` | stesse env, lette dal plugin (`os.environ`) | ✅ |
| hook `session_start` → `POST /internal/ready` | hook **`on_session_start`** → `POST /internal/ready` | ✅ |
| hook `before_agent_start` → `GET /internal/orchestra-context`, refresh appendix ogni turno | hook **`pre_llm_call`** → ritorna `{"context": "<appendix>"}` (iniettato nel messaggio del turno, ogni turno) | ✅ |
| `@@HANDOFF` testuale parsato su `agent_end` | **tool custom `orchestra_handoff`** che l'agente chiama → handler fa `POST /internal/call-agent` | ✅ (più pulito) |
| `@@CARD:<col>` kanban | tool `orchestra_card` (o stesso tool) → `POST /internal/card-status` | ✅ |
| watchdog determinismo (`pi.sendUserMessage` follow-up) | hook **`post_llm_call`** → `POST /internal/turn-ended`; il backend inietta il nudge **via PTY** (vedi nota sotto) | ⚠️ cablato diverso |

### Nota sul watchdog (l'unico vero "gotcha")

La doc Hermes è esplicita: gli hook **non possono** iniettare follow-up message né mandare nuovi messaggi all'agente (solo bloccare tool, iniettare contesto, riscrivere output). Quindi il "ri-chiedi: handoff o done?" **non** si fa da un hook Hermes. **Ma non serve**, perché possediamo già il PTV:

1. l'hook `post_llm_call` (fine turno) fa `POST /internal/turn-ended { session, response, handoffCalledThisTurn }`
2. il backend vede "nodo non-final che ha finito senza chiamare `orchestra_handoff`" → **incolla il nudge nel PTY** (lo stesso meccanismo con cui già iniettiamo i task), fino a `MAX_STEER_RETRIES`

Lo "steer" lo fa l'orchestratore via PTY, non un'API interna di Hermes. Parità mantenuta.

### Isolamento del plugin

I plugin/hook Hermes sono **globali** (`~/.hermes/plugins/`), non per-sessione. Il plugin `orchestra` deve quindi **auto-disattivarsi quando `PINODES_ORCHESTRA_NODE` non è nell'env**: si carica per tutte le sessioni Hermes della macchina ma agisce **solo** sui processi lanciati da Orchestra, senza disturbare l'uso normale di Hermes dell'utente. Gate anche dichiarabile in `plugin.yaml` (`requires_env`).

---

## Da confermare nello spike (Fase -1, mezza giornata con Hermes installato)

Due sole verifiche dal vivo prima di codificare Hermes (l'architettura è già decisa):

1. **`HERMES_EPHEMERAL_SYSTEM_PROMPT` persiste su tutti i turni** della sessione, o solo sul primo? Se solo-primo, il ruolo si inietta a ogni turno via `pre_llm_call` (il plugin lo fa comunque). L'isolamento per-nodo è garantito in entrambi i casi (è l'env del processo).
2. **Bracketed-paste nel `hermes --tui`**: iniettare task/nudge via PTY è affidabile come con pi? (La doc dice che la TUI accetta input in coda anche prima del ready → promettente, ma va visto.)

> Le Fasi 0-1-2 **non dipendono da queste risposte**: sono un refactoring sano a prescindere da Hermes (abilitano anche Cursor/OpenClaw). Possono iniziare in parallelo allo spike.

---

## Separazione delle responsabilità (target del refactor)

| Responsabilità | Proprietario | Note |
|----------------|--------------|------|
| Scrollback `buffer` + broadcast `pty_output` | **PtyHub** | Generico: ogni runtime emette `onOutput(data)`, PtyHub accumula (`MAX_BUFFER`) e broadcasta |
| Decidere *quando* iniettare (ready-gate, coda, fallback) | **PtyHub** | `scheduleInject` + `markReady` + guard `READY_FALLBACK_MS` restano qui |
| Decidere *come* iniettare (paste, submit, settle) | **Runtime** | `PiRuntime`/`HermesRuntime`: entrambi bracketed paste + settle + `\r` (sono PTY) |
| Dimensioni `cols/rows` correnti | **Runtime** (fonte di verità) | PtyHub mirror dell'ultimo valore noto per `pty_size` |
| Lifecycle (`spawn`/`kill`/`restart`) | **Runtime** (meccanismo) + **PtyHub** (orchestrazione) | PtyHub mappa `boardId:nodeId → INodeRuntime` |
| Segnale di exit per `waitForExit` | **PtyHub** | `onExit` del runtime emette `exit:${boardId}:${nodeId}` sull'`EventEmitter` |
| Risoluzione handoff, handles, appendix, grafo | **PtyHub** | Completamente runtime-agnostic |

Poiché *entrambi* i runtime sono PTY-based, la differenza tra `PiRuntime` e `HermesRuntime` è minima: **comando + argomenti + env + (per Hermes) garantire che il plugin `orchestra` sia installato**. Valutare un `PtyRuntime` base parametrico da cui derivano entrambi.

---

## Fase -1 — Spike di Validazione (mezza giornata) 🔬

**Obiettivo:** confermare i 2 punti sopra con Hermes installato. **Nessun codice di produzione.**
**Rischio:** 🟢 Nullo · **Tempo:** 0.5 gg · **Dipendenze:** Nessuna

- Lanciare `hermes --tui` in un terminale con `HERMES_EPHEMERAL_SYSTEM_PROMPT="Sei un test"` e verificare che il ruolo regga su più turni.
- Scrivere un plugin `orchestra` minimale in `~/.hermes/plugins/` che: su `on_session_start` logga, su `pre_llm_call` inietta un context fisso, espone un tool `orchestra_handoff` che fa una POST a un server locale fittizio. Verificare che l'agente lo chiami e che la POST parta.
- Provare il bracketed-paste programmatico nel PTY della TUI.
- **Output:** breve nota di esito in `docs/HERMES_TUI_SPIKE_RESULT.md`. **Gate:** se i 2 punti reggono, le Fasi 3+ procedono come scritte; altrimenti si applica il ripiego (ruolo via `pre_llm_call`).

---

## Fase 0 — Estendere il Data Model (zero behavior change)

**Obiettivo:** Aggiungere il campo `runtime` ai tipi e al grafo senza cambiare comportamento.
**Rischio:** 🟢 Basso · **Tempo:** 2-3 gg · **Dipendenze:** Nessuna (utile a prescindere)

### 0.1 — Test: serializzazione grafi con runtime field
**File:** `backend/src/db/index.test.ts` — grafo con `runtime: "pi"`, con `runtime: "hermes"`, senza runtime (backward compat), misto: tutti si salvano/leggono correttamente.

### 0.2 — Test: validation con runtime field
**File:** `backend/src/orchestra/BoardManager.test.ts` — `addNode`/`updateNode` con `runtime: "hermes"` persistono il campo; senza runtime funziona come oggi; `validateGraph` invariato.

### 0.3 — Test: API REST con runtime field
**File:** test per `routes/orchestra.ts` — POST/PATCH nodes accettano `runtime`/`runtimeConfig`; GET/PUT graph li preservano.

### 0.4 — Implementazione: types.ts (backend + frontend)
```typescript
// AGGIUNGERE (non modificare nulla di esistente):
export type NodeRuntime = "pi" | "hermes";
// ESTENDERE WorkflowNode — campi opzionali:
// runtime?: NodeRuntime;                    // default "pi" se assente
// runtimeConfig?: Record<string, unknown>;  // SOLO dati non segreti (vedi 0.7)
```
Stesse modifiche speculari in `frontend/src/types.ts`.

### 0.5 — Implementazione: propagazione nei CRUD
`BoardManager.addNode()/updateNode()` propagano `runtime`/`runtimeConfig`. Body schemas di `routes/orchestra.ts` accettano i campi opzionali. Nessun altro cambio.

### 0.6 — Validazione
```bash
npm test --workspaces --if-present
npx tsc --noEmit -p backend
npx tsc --noEmit -p frontend
```
**Gate:** Tutti i test passano. Il campo `runtime` è serializzato ma ignorato dalla logica.

### 0.7 — ⚠️ Vincolo di sicurezza su `runtimeConfig`
`runtimeConfig` è persistito in `boards.graph_data` (SQLite) **e spedito al browser via WS**. Quindi:
- ✅ Ammesso: nome modello, toolset, flag non sensibili.
- ❌ Vietato: qualsiasi segreto/token. Le credenziali Hermes vivono in `~/.hermes/` o in env del processo, **mai nel grafo**.
Documentare il vincolo in `docs/SECURITY.md`.

---

## Fase 1 — Test di Protezione per PtyHub (nessun cambio a PtyHub)

**Obiettivo:** rete di sicurezza granulare prima del refactor di Fase 2.
**Rischio:** 🟢 Basso · **Tempo:** 2-3 gg · **Dipendenze:** Fase 0 (consigliata)

### 1.1 — Test aggiuntivi per PtyHub (`backend/src/pty/PtyHub.test.ts`)

**Spawn:** `pty.spawn` con args corretti (`--tools`, `--session-id`, `--name`, `--system-prompt`, `--extension`); env corrette (`PINODES_ORCHESTRA_URL/_BOARD/_NODE/_FALLBACK_APPENDIX`); con/senza token; broadcast `node_status: running` + `pty_size`.
**Lifecycle:** `kill` rimuove sessione + broadcast `pty_exit`/`node_status: idle`; `restart` = PTV fresco; dopo `kill` → `isNodeRunning`/`isReady` false; `onExit` emette `exit:${boardId}:${nodeId}` (lo usa `waitForExit`).
**I/O:** `input` scrive nel PTY; su nodo non running è no-op; `resize` aggiorna dim + broadcast; resize su non running no-op.
**Ready + Inject:** inject prima di `markReady` → coda; `markReady` flush dopo `READY_SETTLE_MS`; inject dopo ready → immediato; `restart` azzera ready → prossimo inject in coda; fallback dopo `READY_FALLBACK_MS`; `scheduleInject` con sessione deferita salva nel `pending` e inietta a `setGraph`.
**Buffer:** accumula fino a `MAX_BUFFER`, tronca i più vecchi; attach replay = buffer corrente.
**Handoff:** `deliverCall` risolve per handle / UUID / label univoca; target non risolvibile → errore + nudge sender; target valido → `scheduleInject` + broadcast `handoff`.

### 1.2 — PTY output lifecycle
`term.onData` accumula+broadcasta; `term.onExit` fa cleanup completo; guard "solo se è ancora la sessione attiva" protegge il restart.

### 1.3 — Validazione
```bash
cd backend && npx vitest run src/pty/PtyHub.test.ts
```
**Gate:** Nuovi test passano. PtyHub non toccato.

---

## Fase 2 — Estrarre INodeRuntime + PiRuntime (refactoring interno)

**Obiettivo:** estrarre le operazioni runtime-specifiche da PtyHub in `INodeRuntime`/`PiRuntime`, zero behavior change. Vale a prescindere da Hermes.
**Rischio:** 🟡 Medio (passo più delicato) · **Tempo:** 1 sett · **Dipendenze:** Fase 1

### 2.1 — `backend/src/pty/runtime/INodeRuntime.ts`
```typescript
export interface INodeRuntime {
  spawn(config: RuntimeSpawnConfig): void; // chiama onOutput/onExit/onReady/onError
  write(data: string): void;
  inject(message: string): void;           // il "come": paste + settle + \r
  resize(cols: number, rows: number): void;
  kill(): void;
  isRunning(): boolean;
  isReady(): boolean;
  size(): { cols: number; rows: number } | undefined; // runtime = fonte di verità
}

export interface RuntimeSpawnConfig {
  boardId: string; nodeId: string; label: string;
  cwd: string; cols: number; rows: number;
  systemPrompt: string; appendix: string;
  runtimeConfig?: Record<string, unknown>; // non segreti
  onOutput: (data: string) => void;
  onExit: (code: number | null) => void;
  onReady: () => void;
  onError: (message: string) => void;
}
```

### 2.2 — `backend/src/pty/runtime/PiRuntime.ts`
Spostare la logica pi-specifica da PtyHub: `resolvePiCommand()`/`PI_BIN_NAMES`/`findInPath()`, `EXTENSION_PATH`/`hasExtension`, il blocco `pty.spawn(...)` con args+env, il bracketed paste + `\r` di submit, il settle `READY_SETTLE_MS` prima del primo paste. **Spostare codice, non riscriverlo.**

> Suggerimento: estrarre un `PtyRuntime` base (spawn di un comando in PTY, buffer-less, callback) e far derivare `PiRuntime` (comando pi + args) — così `HermesRuntime` (Fase 3) è un'altra sottoclasse minima.

### 2.2bis — Risoluzione incoerenza READY_*
- `READY_SETTLE_MS` (TUI mount prima del paste) → **runtime** (`PiRuntime.inject`). Per Hermes verrà tarato uguale (è anch'essa una TUI).
- `READY_FALLBACK_MS` (guard "non perdere mai il task") → **PtyHub.scheduleInject** (generico).
- `markReady` non applica più il settle in proprio: chiama `runtime.inject(msg)`, il runtime applica il suo settle.

### 2.3 — Refactoring di PtyHub
- PtyHub crea `PiRuntime` per ogni sessione (default).
- **Delegano** al runtime: `spawn`, `input`, `inject`, `resize`, `kill`, `restart`, `size`, parte di `isReady`.
- **Restano in PtyHub** (runtime-agnostic): `setGraph`, `orchestraContext`, `outgoingTargets`, `hasEdge`, `handles`, `canBeFinal`, `connectionsAppendix`, `kanbanAppendix`, `resolveOutgoingTarget`, `deliverCall`, `injectTask`, `scheduleInject`, `markReady`, `setBroadcast`, `notify`, `setKanbanTracked`, `isEnforced`, `setEnforcement`, `enforcementOverrides`, `killBoard`, `isNodeRunning`, `getNodeStatuses`, `getEdges`, `waitForExit`, `ensure`.
- `Session` → `{ runtime: INodeRuntime; buffer: string; cols: number; rows: number; startedAt: number }`.
- Buffer/broadcast restano in PtyHub (`onOutput` → accumula + `pty_output`). Size: runtime fonte di verità, PtyHub mirror per `pty_size`. Exit: `onExit` → `events.emit("exit:"+...)` così `waitForExit` continua a funzionare.

### 2.4 — Test: comportamento identico
Tutti i test esistenti + quelli di Fase 1 passano **senza modifica**. Il mock di `node-pty` resta al confine `node-pty`.

### 2.5 — `backend/src/pty/runtime/PiRuntime.test.ts`
`spawn` invoca `pty.spawn` con args corretti; `write` scrive; `inject` = paste+settle+`\r`; `kill` termina; `resize` ridimensiona ed è la fonte di `size()`; `onReady` NON automatico (arriva da `markReady`); `onExit` invocato all'uscita.

### 2.6 — Validazione
```bash
npm test --workspaces --if-present && npx tsc --noEmit -p backend && npx tsc --noEmit -p frontend
```
**Gate:** Tutti i test passano. Nessun cambio osservabile. PtyHub più piccolo, identico nel comportamento.

---

## Fase 3 — HermesRuntime + plugin `orchestra` (dietro feature flag)

**Obiettivo:** un nodo `runtime: "hermes"` lancia `hermes --tui` in PTY, con parità di feature via env + plugin.
**Rischio:** 🟡 Medio · **Tempo:** ~1 settimana · **Dipendenze:** Fase -1 (spike OK) + Fase 2

### 3.1 — `backend/src/pty/runtime/HermesRuntime.ts`
Sottoclasse di `PtyRuntime` (o `INodeRuntime` diretto). Differenze rispetto a `PiRuntime`:
- **Comando:** risolve `hermes` su PATH (con i fallback per-OS, come `resolvePiCommand`).
- **Args:** `--tui`, `--toolsets "<lista>"`. (Niente `--system-prompt`/`--extension`: usano env + plugin.)
- **Env aggiuntive:** `HERMES_EPHEMERAL_SYSTEM_PROMPT=<systemPrompt>` (il ruolo, per-processo → isolato per nodo, **come `--system-prompt` di pi**); più le `PINODES_ORCHESTRA_*` già presenti.
- **inject/resize/kill/write:** identici a PiRuntime (è un PTY). Bracketed paste + settle + `\r`.
- **Ready:** vedi 3.4 (arriva dal plugin via `/internal/ready`).

### 3.2 — Plugin Hermes `~/.hermes/plugins/orchestra/`
Equivalente di `call-agent.ts`. File: `plugin.yaml`, `__init__.py`, `schemas.py`, `tools.py`. **Auto-disabilitato se `PINODES_ORCHESTRA_NODE` assente nell'env.** Legge `PINODES_ORCHESTRA_URL/_BOARD/_NODE/_TOKEN`.

| Componente | Hook/Tool | Azione |
|---|---|---|
| Ready | `on_session_start` | `POST /internal/ready` |
| Context per-turno | `pre_llm_call` | `GET /internal/orchestra-context` → ritorna `{"context": "<appendix>"}` |
| Handoff | tool **`orchestra_handoff`** (args: `recipient`, `message`) | `POST /internal/call-agent` |
| Kanban | tool **`orchestra_card`** (args: `column`) | `POST /internal/card-status` |
| Watchdog (segnale) | `post_llm_call` | `POST /internal/turn-ended { handoffCalledThisTurn }` |

**Dove vive il plugin:** bundle dentro `backend/hermes-plugins/orchestra/`, installato/symlinkato in `~/.hermes/plugins/` da `HermesRuntime.spawn` (o da uno step di setup) la prima volta. Documentare il side-effect (scrittura in `~/.hermes/`), a differenza di pi che passa `--extension <path>` per-spawn.

### 3.3 — Endpoint backend `POST /internal/turn-ended`
Nuovo endpoint runtime-agnostic. Per un nodo non-final che ha finito il turno senza `orchestra_handoff`: il backend **inietta un nudge via PTY** (riusa `scheduleInject`/`inject`), fino a `MAX_STEER_RETRIES`; superato il cap → `node_status: error` (come oggi via `/internal/handoff-failed`). Per pi questo endpoint non è usato (pi ha il watchdog in-process); è additivo, non cambia il flusso pi.

### 3.4 — Integrazione con PtyHub (dietro flag)
```typescript
// In spawn():
const runtime =
  node?.runtime === "hermes" && process.env.PINODES_ORCHESTRA_HERMES === "true"
    ? new HermesRuntime()
    : new PiRuntime(); // default
```
Flag `PINODES_ORCHESTRA_HERMES` spento di default → produzione invariata anche se `runtime: "hermes"` è nel grafo (degrada o segnala chiaramente).

### 3.5 — Ready protocol
`on_session_start` del plugin → `POST /internal/ready` → `PtyHub.markReady()`. Il guard `READY_FALLBACK_MS` copre il caso in cui il plugin non sia installato/non risponda.

### 3.6 — Test
- **`HermesRuntime.test.ts`:** `spawn` invoca `pty.spawn` con `hermes --tui` + `HERMES_EPHEMERAL_SYSTEM_PROMPT` nell'env; inject/kill/resize come PiRuntime; output→`onOutput`; exit→`onExit`.
- **Plugin (test Python isolato, opzionale):** `orchestra_handoff` fa la POST attesa; `pre_llm_call` ritorna il context; tutto no-op senza `PINODES_ORCHESTRA_NODE`.
- **`PtyHub.test.ts`:** nodo `runtime: "hermes"` (flag on) usa HermesRuntime; `pi`/assente usa PiRuntime; grafi misti pi↔hermes (delivery via `/internal/call-agent` invariato); `POST /internal/turn-ended` inietta nudge e dopo il cap segna error.

### 3.7 — Validazione
```bash
npm test --workspaces --if-present && npx tsc --noEmit -p backend && npx tsc --noEmit -p frontend
```
**Gate:** Tutti i test passano. Hermes dietro flag. Produzione invariata.

---

## Fase 4 — Frontend: Runtime Selector e Badge (basso, xterm invariato)

**Obiettivo:** UI per selezionare/visualizzare il runtime. **xterm renderizza Hermes come pi → nessun lavoro di rendering.**
**Rischio:** 🟢 Basso · **Tempo:** 3-5 gg · **Dipendenze:** Fase 0

- **4.1** `runtimeStore.test.ts`: runtime tracciato nel node status e negli snapshot.
- **4.2** `NodeInspector.tsx`: dropdown `runtime` ("pi"/"hermes", default "pi"); campi `runtimeConfig` **non segreti** (es. modello/toolset).
- **4.3** `AgentNode.tsx`: badge/icona runtime; "Restart pi…" → "Restart {runtime}…".
- **4.4** `TerminalPanel.tsx`: header "pi" → "{runtime}"; "pi session ended" → "{runtime} session ended".
- **4.5** `NodeTerminal.tsx`: "starting pi…" → "starting {runtime}…" da `data.runtime`.
- **4.6** Validazione: `npm test --workspaces --if-present && npx tsc --noEmit -p frontend`.

---

## Fase 5 — Test End-to-End e Integrazione

**Obiettivo:** sistema funzionante con grafi misti. **Rischio:** 🟡 Medio · **Tempo:** 3-5 gg · **Dipendenze:** Fasi 2,3,4

- **5.1 Grafo misto pi+hermes:** Architect (pi) → Developer (hermes). Avvio task sull'Architect; handoff a Developer; il Developer (hermes) riceve e lavora; chiude con `orchestra_handoff`/done.
- **5.2 Watchdog Hermes:** nodo Hermes non-final che finisce senza handoff → nudge via PTY → dopo il cap → `error`.
- **5.3 Fallback graceful:** `hermes` non installato / plugin assente → nodo in `error` con messaggio chiaro; gli altri nodi continuano.
- **5.4 Restart/kill:** Hermes running → restart → nuova sessione; → stop → cleanup; board stop → tutti fermati.
- **5.5 Regression pi-only:** board di soli nodi pi, flow completo con handoff → tutto come prima.
- **5.6 Validazione finale:** `npm test --workspaces --if-present && npx tsc --noEmit -p backend && npx tsc --noEmit -p frontend && npm run build`.

---

## Fase 6 — Abilitazione e Documentazione

**Rischio:** 🟢 Basso · **Tempo:** 2-3 gg · **Dipendenze:** Fase 5

- **6.1** Feature flag: `PINODES_ORCHESTRA_HERMES` documentato nel README (poi eventuale toggle UI).
- **6.2** Docs: README (sezione "Hermes runtime nodes" + requisito `hermes` installato + setup plugin); ARCHITECTURE.md (Runtime types: Hermes 🔜→✅, tabella metodi); correggere la contraddizione xterm/ANSI in `HERMES_DESKTOP.md` e `HERMES_TUI_IMPACT_ANALYSIS.md`; PROGRAMMATIC_API.md (`runtime`/`runtimeConfig`); SECURITY.md (§0.7); EXTENSIONS_ROADMAP.md.
- **6.3** Validazione: `npm test --workspaces --if-present && npm run build`.

---

## Riepilogo Temporale

| Fase | Descrizione | Tempo | Rischio |
|------|------------|-------|---------|
| **-1** | Spike di validazione (2 verifiche dal vivo) | 0.5 gg | 🟢 Nullo |
| **0** | Data model (types, DB, API, vincolo token) | 2-3 gg | 🟢 Basso |
| **1** | Test di protezione per PtyHub | 2-3 gg | 🟢 Basso |
| **2** | Estrazione INodeRuntime + PiRuntime | 1 sett | 🟡 Medio |
| **3** | HermesRuntime + plugin orchestra + watchdog | 1 sett | 🟡 Medio |
| **4** | Frontend: selector, badge, label | 3-5 gg | 🟢 Basso |
| **5** | Test E2E e regression | 3-5 gg | 🟡 Medio |
| **6** | Abilitazione e docs | 2-3 gg | 🟢 Basso |
| **Totale** | | **~3-4 settimane** | **🟡 Medio** |

> Le Fasi 0-1-2 (~2 settimane) valgono **a prescindere** da Hermes: estrarre `PiRuntime` è un refactoring sano che abilita anche Cursor/OpenClaw.

---

## Checklist di Sicurezza (per ogni fase)

- [ ] Tutti i test esistenti passano (`npm test --workspaces --if-present`)
- [ ] Typecheck backend e frontend passano
- [ ] Build produce artefatto (`npm run build`)
- [ ] Nessun cambio osservabile (fasi 0-2)
- [ ] Feature flag spento = comportamento identico a oggi (fasi 3-5)
- [ ] Nessun segreto in `runtimeConfig`/grafo (§0.7)
- [ ] Commit piccolo e revertibile
- [ ] Ogni sotto-fase ha i propri test PRIMA dell'implementazione

---

## Rischi e Mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|-------------|---------|-------------|
| `HERMES_EPHEMERAL_SYSTEM_PROMPT` solo primo turno | Media | Basso | Ripiego: ruolo via `pre_llm_call` (gira ogni turno). Verificato nello spike |
| Bracketed-paste nella TUI inaffidabile | Bassa | Medio | Verificato nello spike; fallback: API di input alternativa della TUI |
| Refactoring PtyHub rompe pi | Media | Alto | Fase 1 (test di protezione) prima del refactor; Fase 2 sposta codice, non riscrive |
| Plugin globale disturba l'Hermes dell'utente | Media | Medio | Auto-disabilita senza `PINODES_ORCHESTRA_NODE`; gate `requires_env` |
| Watchdog non implementabile via hook | Certa | Basso | Già risolto: nudge via PTY su segnale `post_llm_call` |
| `hermes` non installato → nodi bloccati | Media | Basso | Fallback graceful con messaggio chiaro; flag spento di default |
| Segreto (token) persistito nel grafo | Media | Alto | §0.7: credenziali in `~/.hermes/`/env, mai in `runtimeConfig` |

---

## Cosa NON Fare

1. **Non reintrodurre il path gateway/JSON-RPC** — scartato; Hermes gira in PTY come pi
2. **Non riscrivere PtyHub da zero** — spostare codice, non riscriverlo
3. **Non rimuovere call-agent.ts** — resta per i nodi pi; Hermes usa il plugin
4. **Non cambiare il protocollo @@HANDOFF / gli endpoint `/internal/*`** — sono universali; `/internal/turn-ended` è additivo
5. **Non cambiare la WebSocket protocol** esistente — i messaggi attuali sono invariati
6. **Non mettere segreti nel grafo** — credenziali in `~/.hermes/`/env (§0.7)
7. **Non far agire il plugin su sessioni Hermes non-Orchestra** — gate su `PINODES_ORCHESTRA_NODE`
8. **Non abilitare Hermes per default** — feature flag spento fino a maturità
9. **Non implementare tutto in un colpo solo** — fasi incrementali, ognuna revertibile

---

## Changelog revisione

**v3 (2026-06-29) — dopo indagine sul web:**
1. **Architettura decisa: PATH A** (`hermes --tui` in PTY). Path gateway/JSON-RPC **scartato** (confermato che la TUI è self-contained e renderizza ANSI → xterm gratis).
2. **Mappatura pi→Hermes completa** via plugin Hermes: `HERMES_EPHEMERAL_SYSTEM_PROMPT` (system prompt per-nodo, come `--system-prompt`), `on_session_start` (ready), `pre_llm_call` (context per-turno), tool `orchestra_handoff`/`orchestra_card`, `post_llm_call` (watchdog).
3. **System prompt per-nodo isolato confermato:** env var per-processo, come pi. Ogni istanza `hermes --tui` ha il suo prompt per tutta la vita, senza toccare `~/.hermes/SOUL.md` globale.
4. **Watchdog risolto:** gli hook Hermes non possono iniettare follow-up → si usa il PTY (nudge via `scheduleInject` su segnale `post_llm_call` → `/internal/turn-ended`).
5. **Isolamento plugin:** globale in `~/.hermes/plugins/` ma auto-disabilitato senza `PINODES_ORCHESTRA_NODE`.
6. **Spike ridotto a 0.5 gg** (2 verifiche dal vivo), non più decisione d'architettura.
7. **Stima rivista a ~3-4 settimane** (path A), Frontend tornato 🟢 basso (xterm invariato).

**v2 (2026-06-29):** prima revisione contro il codice — aggiunto spike, corretta contraddizione xterm/ANSI, risolta incoerenza READY_*, esplicitate lacune feature-parity, vincolo sicurezza, lista metodi runtime-agnostic, ri-stime.

**v1 (2026-06-28):** piano iniziale (6 fasi, assunzione gateway implicita).
