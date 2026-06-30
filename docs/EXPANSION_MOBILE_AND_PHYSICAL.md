# Espansione PiNodes Orchestra — Mobile Companion & Physical Runtime

> **Data:** 2026-07-01  
> **Stato:** Visione / piano — nessuna implementazione obbligatoria ancora  
> **Autore:** brainstorming Emanuele + OpenClaw, da consolidare in ADR quando si inizia M1 o P1  
> **Lingua commit:** italiano (allineato al resto del progetto)

---

## Sommario

1. [Contesto](#contesto)
2. [Invarianti di prodotto](#invarianti-di-prodotto)
3. [Espansione A — Mobile Companion](#espansione-a--mobile-companion)
4. [Espansione B — Physical Runtime & orchestrazione di rete](#espansione-b--physical-runtime--orchestrazione-di-rete)
5. [Canale voce (input/output, non prodotto)](#canale-voce-inputoutput-non-prodotto)
6. [Architettura target unificata](#architettura-target-unificata)
7. [Sequenza di implementazione](#sequenza-di-implementazione)
8. [Rischi, decisioni aperte, metriche di successo](#rischi-decisioni-aperte-metriche-di-successo)
9. [Documenti correlati](#documenti-correlati)

---

## Contesto

**PiNodes Orchestra** oggi è una web app / PWA (+ estensione VS Code/Cursor) che visualizza un **canvas di nodi agente**. Ogni nodo è un processo AI reale in un PTY (`pi` o `hermes`), collegato ad altri nodi da **archi** che definiscono permessi di handoff. L’umano può intervenire in qualsiasi momento nel terminale di un nodo.

Stack attuale (vedi [ARCHITECTURE.md](../ARCHITECTURE.md)):

```
Frontend (React Flow + xterm + Kanban)
    ↔ WebSocket + REST
Backend (Fastify + PtyHub + SQLite)
    → INodeRuntime (PiRuntime | HermesRuntime)
    → handoff via /internal/call-agent (contratto unico)
```

**Cosa manca oggi per “andare oltre il desk”:**

| Lacuna | Impatto |
|--------|---------|
| UI pensata per desktop (canvas + xterm full) | Difficile supervisione da telefono |
| Runtime solo software (PTY locali) | Nodi = macchine fisiche non modellati |
| Nessun gate di approvazione esplicito per azioni irreversibili | Critico se si aggiunge hardware |
| Voce non integrata | Opportunity per inject/approve hands-free |

Questo documento descrive **due espansioni complementari** che rispettano gli invarianti del prodotto e riusano API/protocolli esistenti.

---

## Invarianti di prodotto

Da [EXTENSIONS_ROADMAP.md](./EXTENSIONS_ROADMAP.md) — **non negoziabili** in nessuna espansione:

| Invariante | Significato per mobile/fisico |
|------------|-------------------------------|
| Grafo / topologia | Resta il modello mentale; mobile può essere read-only sul grafo |
| Handoff visibili | Timeline + eventi WS `handoff` anche su companion |
| Intervento umano | Core del valore; mobile = telecomando + approve |
| Edge-gated delegation | Archi = permessi; estendere con `requiresApproval` per L2/L3 |
| Multi-board per cwd | Invariato; mobile seleziona board remota |

**Anti-pattern espliciti:**

- ❌ Sostituire Orchestra con una chat mobile
- ❌ Eseguire PTY/agenti pesanti *dentro* l’app mobile (battery, sandbox, API keys)
- ❌ Fork UI completa per ogni host — un client sottile + stesso backend

---

## Espansione A — Mobile Companion

### Perché

1. **Supervisione asincrona** — pipeline multi-agente gira ore; l’utente non resta davanti al canvas.
2. **Human-in-the-loop portatile** — approvare handoff, inject correttivi, stop nodi da Telegram-style UX.
3. **Kanban già adatto al mobile** — vista colonne esiste nel frontend; è il punto di ingresso naturale su schermo piccolo.
4. **API già pronte** — [PROGRAMMATIC_API.md](./PROGRAMMATIC_API.md): status, inject, run, stop, WS events.
5. **Allineamento stack utente** — Expo/React Native già usato in altri progetti (es. SwappIt); riuso competenze.

### Cosa (scope prodotto)

**Orchestra Mobile Companion** — app (nativa o PWA mobile-first) che **non sostituisce** il canvas desktop ma lo **completa**:

| Schermata | Funzione | Priorità MVP |
|-----------|----------|--------------|
| **Pulse** | Stato board: nodi running/idle/error, ultimo handoff, watchdog failures | P0 |
| **Intervene** | Tap nodo → inject, stop, restart; approva handoff in sospeso | P0 |
| **Kanban** | Colonne + card; tap card → messaggio al nodo entry | P1 |
| **Graph (read-only)** | Topologia zoomabile, no editing | P2 |
| **Settings** | URL backend, token, Tailscale hint, notifiche | P0 |

**Fuori scope MVP mobile:**

- Editing grafo (drag nodi, nuovi archi)
- xterm interattivo full (troppo piccolo; opzionale scrollback summary)
- Backend embedded nel telefono
- Spawn locale di pi/hermes

### Come (architettura tecnica)

#### Topologia

```
┌─────────────────────┐         HTTPS/WSS (+ token)        ┌──────────────────────────┐
│  Mobile Companion   │ ◄──────────────────────────────────► │  Orchestra Backend       │
│  (Expo RN o PWA)    │                                      │  (Fastify :3847)         │
│  - Pulse UI         │                                      │  PtyHub + SQLite         │
│  - Push (FCM/APNs)  │                                      │  PTY agents (pi/hermes)  │
└─────────────────────┘                                      └──────────────────────────┘
         ▲                                                              ▲
         │ opzionale: Tailscale / WireGuard / reverse tunnel           │
         └──────────────────────── homelab / laptop dev ────────────────┘
```

Il backend resta **always-on** sulla macchina di lavoro (o VPS). Il mobile è **client sottile**.

#### Riuso protocollo esistente

| Esigenza mobile | Endpoint / evento già esistente |
|-----------------|----------------------------------|
| Health check | `GET /api/health` |
| Lista board | `GET /api/v1/orchestra/boards` |
| Stato nodi | `GET .../boards/:id/status` + WS `node_status` |
| Inject messaggio | `POST .../nodes/:nodeId/inject` |
| Stop nodo | `POST .../nodes/:nodeId/stop` |
| Avvia flow | `POST /api/v1/orchestra/flows` |
| Handoff timeline | WS event `handoff` (già consumato da frontend) |
| Auth | `PINODES_ORCHESTRA_TOKEN` header o query |

**Estensioni API minime (proposte, da implementare in M1):**

```http
GET /api/v1/orchestra/boards/:boardId/pulse
→ {
    nodes: [{ id, label, status, runtime, lastHandoffAt, needsAttention }],
    pendingApprovals: [{ id, fromNode, toNode, message, createdAt }],
    kanbanSummary: { todo, doing, done, blocked }
  }

POST /api/v1/orchestra/boards/:boardId/approvals/:approvalId/respond
  { action: "approve" | "reject", comment?: string }
```

`pendingApprovals` diventa rilevante anche per Physical Runtime (sezione B).

#### Client mobile — stack consigliato

| Opzione | Pro | Contro |
|---------|-----|--------|
| **Expo (React Native)** | Push native, background, STT plugin, stesso ecosistema RN | Repo separato o `packages/mobile` |
| **PWA mobile-first** | Zero store, riusa Vite | Push iOS limitato, xterm assente anyway |

**Raccomandazione:** Expo app in `packages/mobile/` (monorepo) con SDK `@tanstack/react-query` + WS client estratto da `frontend/src/hooks/useOrchestraWs.ts`.

#### Notifiche push

Trigger (server-side, nuovo modulo `ApprovalNotifier` o hook in PtyHub):

| Evento | Push |
|--------|------|
| Handoff verso nodo `requiresApproval` | "Approva handoff: Dev → Deploy" |
| Watchdog `handoff-failed` | "Nodo X bloccato — serve intervento" |
| Flow completato | "Pipeline auth terminata" |
| Nodo crash (exit ≠ 0) | "Backend-Dev terminato con errore" |

Device token registrato via:

```http
POST /api/v1/orchestra/devices/register
  { platform: "ios"|"android", token: string, label?: string }
```

#### UX principi

1. **Glanceable first** — Pulse deve essere leggibile in 3 secondi.
2. **Un tap per intervenire** — inject con template ("Stop", "Riprova", "Usa PostgreSQL").
3. **Grafo read-only** — pan/zoom, tap nodo → Intervene.
4. **Offline graceful** — cache ultimo Pulse; reconnect WS con backoff.

#### Fasi Mobile

| Fase | Deliverable | Durata stimata |
|------|-------------|----------------|
| **M0** | Spike: Expo + WS + inject su board remota via Tailscale | 3–5 gg |
| **M1** | Pulse + Intervene + token auth + README deploy | 2 sett |
| **M2** | Kanban mobile + push (FCM) | 1–2 sett |
| **M3** | Graph read-only + polish | 1 sett |
| **M4** | Voice inject (STT → inject API) | 1–2 sett |

#### Verifica M1

- [ ] Connettersi a backend remoto con token
- [ ] Vedere stato nodi in <2s dopo open app
- [ ] Inject messaggio su nodo running da telefono
- [ ] Ricevere WS update senza refresh
- [ ] Stop nodo da mobile riflesso su desktop canvas

---

## Espansione B — Physical Runtime & orchestrazione di rete

### Perché

1. **INodeRuntime è già un'astrazione** — oggi `PiRuntime` / `HermesRuntime`; aggiungere `PhysicalRuntime` è coerente con `feat/multi-runtime`.
2. **Handoff contract è runtime-agnostic** — `/internal/call-agent` → `PtyHub.deliverCall` → inject/broadcast (vedi ARCHITECTURE.md).
3. **Grafo = topology reale** — fabbrica software, homelab, robotica domestica, edge IoT: stesso modello mentale del canvas.
4. **Safety** — azioni fisiche richiedono human-in-the-loop **strutturale**, non opzionale.
5. **Rete agentica** — hub centrale + worker su Raspberry Pi / gateway OpenClaw / dispositivi MQTT.

### Cosa (scope prodotto)

Un nodo con `runtime: "physical"` (o `"edge"`) rappresenta una **macchina o servizio di rete**, non un PTY:

| Tipo nodo | Esempio | Output verso Orchestra |
|-----------|---------|------------------------|
| **observe** | Sensore, camera, log tail | Telemetria, snapshot |
| **actuate** | Relay, deploy script, stampante | Job queue + ack |
| **critical** | Robot arm, CNC, lock door | Richiede approvazione umana |

Il canvas mostra **stesso nodo** (label, status, mini-log); il pannello laterale mostra **telemetry + azioni pending** invece di xterm (o xterm opzionale se edge emula PTY).

### Modello di sicurezza — physicalClass

Estensione a `WorkflowNode`:

```typescript
interface WorkflowNode {
  runtime?: "pi" | "hermes" | "physical" | "edge" | "openclaw";
  runtimeConfig?: {
    /** Endpoint del device agent, es. http://192.168.1.50:9090 */
    endpoint?: string;
    protocol?: "http" | "mqtt" | "ros2" | "openclaw-gateway";
    topic?: string;
    /** Classe di rischio — default "observe" */
    physicalClass?: "observe" | "actuate" | "critical";
    /** Blocca handoff in uscita finché non approvato (mobile/desktop) */
    requiresApproval?: boolean;
    /** Timeout approvazione (ms), poi fail o retry */
    approvalTimeoutMs?: number;
  };
}
```

| Classe | Esempi | Gate umano |
|--------|--------|------------|
| **L0 observe** | Temperature, presenza, log | Nessuno |
| **L1 actuate soft** | LED, notifica, file write reversibile | Opzionale |
| **L2 actuate** | Deploy, ordine marketplace, job batch | Tap approve (mobile/desktop) |
| **L3 critical** | Motore, robot, heat | Double confirm + timeout + kill switch hardware |

**Timeline UI:**  
*"Robot-Arm-1 propone: prendi oggetto A → passa a QA-Camera"* — pulsanti Approva / Rifiuta / Modifica messaggio.

### Come (architettura tecnica)

#### PhysicalRuntime — interfaccia target

Implementa `INodeRuntime` dove possibile; dove il PTY non esiste, adattare PtyHub con **runtime capabilities**:

```typescript
/** backend/src/pty/runtime/PhysicalRuntime.ts (bozza) */

export interface PhysicalCapabilities {
  hasPty: false;
  supportsInject: true;      // messaggio → device agent
  supportsStream: true;      // telemetry → onOutput (testo/JSON lines)
  supportsKill: true;        // abort job / estop
  requiresApproval: boolean;
}

export class PhysicalRuntime implements INodeRuntime {
  spawn(config: RuntimeSpawnConfig): void {
    // 1. POST config.endpoint + /orchestra/spawn
    //    body: { boardId, nodeId, systemPrompt, appendix, physicalClass }
    // 2. Subscribe telemetry (SSE / WS / MQTT)
    // 3. on first telemetry → markReady()
    // 4. stream lines → config.onOutput(JSON.stringify(evt) + "\n")
  }

  inject(message: string): void {
    // POST .../inject — device agent esegue o accoda
  }

  kill(): void {
    // POST .../kill — include estop se critical
  }

  // write/resize: no-op o forward se device espone shell
}
```

**Nota:** PtyHub oggi assume output ANSI per xterm. Per physical:

- Opzione A: `onOutput` resta stringa (log line JSON) — frontend rileva `runtime === "physical"` e renderizza **TelemetryPanel** invece di xterm.
- Opzione B: nuovo WS message type `telemetry` (breaking minore, più pulito).

**Raccomandazione:** B in P2, A per spike P0.

#### Device Agent (edge)

Ogni macchina fisica esegue un **agent leggero** (non tutto Orchestra):

```
pinodes-orchestra-edge   (Python/Node, ~500 righe)
  - Registra capacità (observe/actuate/critical)
  - Espone HTTP locale:
      POST /orchestra/spawn
      POST /orchestra/inject
      POST /orchestra/kill
      GET  /orchestra/health
  - Callback verso hub:
      POST {ORCHESTRA_URL}/internal/ready
      POST {ORCHESTRA_URL}/internal/call-agent   (handoff)
      POST {ORCHESTRA_URL}/internal/turn-ended   (watchdog)
  - Esegue comandi reali (GPIO, ROS, script, OpenClaw RPC)
```

Il hub **non** raggiunge direttamente GPIO — solo l'edge agent sulla LAN del device.

#### Topologie di rete

**1. Hub centrale + edge agents (consigliata)**

```
                    ┌─────────────────┐
                    │ Orchestra Hub   │
                    │ (laptop/VPS)    │
                    └────────┬────────┘
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
    ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
    │ Edge@raspi  │   │ Edge@pi5    │   │ pi/hermes   │
    │ (camera)    │   │ (deploy)    │   │ (software)  │
    └─────────────┘   └─────────────┘   └─────────────┘
```

**2. Mini Orchestra per site**

Sito industriale con Orchestra locale + sync graph verso hub cloud (futuro, non MVP).

**3. OpenClaw Gateway come transport**

`runtime: "openclaw"` + `protocol: "openclaw-gateway"` — riusa piano O1 in EXTENSIONS_ROADMAP.

#### Esempio grafo misto software + fisico

```
[PM pi] → [Architect hermes] → [Deploy-Edge@raspi] → [QA-Camera@pi5] → [Human Review]
                                      │                      │
                                      └──── handoff ──────────┘
[OpenClaw@server] → [Telegram notify mobile]
```

Handoff e watchdog **identici** al software; cambia solo come il runtime esprime completamento (tool HTTP vs @@HANDOFF).

#### Approval flow (backend)

Nuovo stato in PtyHub:

```
handoff proposed → (requiresApproval?) → pending_approval
  → approve (mobile/desktop/API) → deliverCall
  → reject → nudge source node or mark failed
  → timeout → handoff-failed event + push
```

Persistenza SQLite: tabella `approvals` (boardId, fromNode, toNode, message, status, expiresAt).

Mobile Companion (sezione A) consuma `GET .../pulse` → `pendingApprovals`.

#### Fasi Physical

| Fase | Deliverable | Durata stimata |
|------|-------------|----------------|
| **P0** | Spec OpenAPI device agent + spike HTTP mock | 1 sett |
| **P1** | `PhysicalRuntime` + `telemetry` WS + TelemetryPanel web | 2–3 sett |
| **P2** | `physicalClass` + `requiresApproval` + API approve | 2 sett |
| **P3** | `pinodes-orchestra-edge` reference (Raspberry Pi + camera) | 2–3 sett |
| **P4** | MQTT adapter + OpenClaw gateway adapter | 2 sett each |

#### Verifica P1

- [ ] Nodo `runtime: "physical"` appare su canvas con status
- [ ] Telemetry stream visibile (web + mobile Pulse)
- [ ] Handoff da pi → physical → pi completa end-to-end
- [ ] Kill/estop ferma job entro N secondi
- [ ] Nessuna regressione su nodi pi/hermes

---

## Canale voce (input/output, non prodotto)

La voce **non** sostituisce il canvas. È un **canale di I/O** per Mobile Companion e desktop.

| Azione voce | Mapping API |
|-------------|-------------|
| "Ferma il nodo DevOps" | `POST .../nodes/:id/stop` |
| "Approva handoff" | `POST .../approvals/:id/respond { approve }` |
| "Inject: usa PostgreSQL" | `POST .../inject` |
| "Confermo movimento braccio" | approve L3 con challenge phrase |

**Implementazione:** M4 mobile (Expo Speech / whisper API) → stessi endpoint REST.  
**Output vocale (TTS):** opzionale read-aloud su push ("Handoff in attesa da Backend a Deploy").

---

## Architettura target unificata

Estende il diagramma in EXTENSIONS_ROADMAP:

```
┌─────────────────────────────────────────────────────────────────┐
│  packages/ui           Flow + Kanban + TelemetryPanel (shared)   │
│  packages/mobile       Pulse + Intervene + Push (new)           │
├─────────────────────────────────────────────────────────────────┤
│  packages/core         Graph, handoff, approvals, protocol      │
├─────────────────────────────────────────────────────────────────┤
│  packages/runtime-*    Pi | Hermes | Physical | OpenClaw | …    │
├─────────────────────────────────────────────────────────────────┤
│  packages/host-*       standalone | vscode | mobile | edge-agent│
└─────────────────────────────────────────────────────────────────┘
```

**Hub backend** resta unico per board; edge agents sono **runtimes remoti**, non secondi hub (salvo multi-site futuro).

---

## Sequenza di implementazione

Integrazione con [EXTENSIONS_ROADMAP.md](./EXTENSIONS_ROADMAP.md):

```
Phase 0–2  ✅ Standalone, API, VS Code extension
Phase 3    🔜 Cursor native nodes
Phase 4–6  🔜 Hermes embed, OpenClaw plugin, multi-runtime

── Nuove fasi (questo documento) ──

Phase M1   🔜 Mobile Companion MVP (Pulse + Intervene)
Phase M2   🔜 Mobile Kanban + push notifications
Phase P1   🔜 PhysicalRuntime + device agent spec
Phase P2   🔜 Approval gates (physicalClass + mobile approve)
Phase M4   🔜 Voice inject (dipende da M1)
Phase P3   🔜 Reference edge (Raspberry Pi)
```

**Parallelismo consigliato:**

- **M1 ∥ P0** — mobile client e spec edge non si bloccano a vicenda
- **P2 dopo M1** — approve UI su mobile richiede companion base
- **P3 dopo P1** — hardware reference dopo runtime funzionante

---

## Rischi, decisioni aperte, metriche di successo

### Rischi

| Rischio | Mitigazione |
|---------|-------------|
| Esporre backend su Internet | Tailscale default; token obbligatorio; mai `0.0.0.0` senza auth |
| Azione fisica non reversibile | physicalClass L3 + double confirm + hardware estop |
| Latency WS su mobile | Pulse cached; reconnect; non streammare PTY intero |
| Scope creep (voice-first, chat-first) | Invarianti + questo doc come gate review |
| PhysicalRuntime forza refactor PtyHub | Capabilities flag; fase A string output compat |

### Decisioni aperte

1. **Repo mobile:** cartella `packages/mobile` nel monorepo vs repo separato?
2. **WS `telemetry` vs string hack** — quando introdurre breaking protocol?
3. **Device agent language:** Node (allineato backend) vs Python (GPIO/ROS)?
4. **Approval solo su mobile o anche desktop modal?** — entrambi, stessa API
5. **Store distribution:** TestFlight/APK sideload vs PWA per M1?

### Metriche di successo

| Espansione | Metrica |
|------------|---------|
| Mobile M1 | Intervento su nodo remoto in <30s dall'notifica push |
| Mobile M2 | ≥80% handoff L2 approvati da mobile senza aprire desktop |
| Physical P1 | 1 nodo edge completa handoff con hub in lab setup |
| Physical P2 | Zero actuation L3 senza doppia approvazione in test suite |
| Voce M4 | 5 comandi vocali standard con ≥90% intent corretto |

---

## Documenti correlati

| Documento | Relazione |
|-----------|-----------|
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Design attuale PtyHub, handoff, runtime |
| [EXTENSIONS_ROADMAP.md](./EXTENSIONS_ROADMAP.md) | Host IDE/Hermes/OpenClaw — sequenza Phase 0–6 |
| [PROGRAMMATIC_API.md](./PROGRAMMATIC_API.md) | REST/WS riusati da mobile |
| [SECURITY.md](./SECURITY.md) | Token, bind localhost, threat model |
| [MULTI_INSTANCE.md](./MULTI_INSTANCE.md) | Isolamento board per cwd |
| [HERMES_TUI_IMPLEMENTATION_PLAN.md](./HERMES_TUI_IMPLEMENTATION_PLAN.md) | Pattern multi-runtime (Pi/Hermes) da replicare per Physical |

---

## Storico revisioni

| Data | Autore | Modifica |
|------|--------|----------|
| 2026-07-01 | Emanuele + OpenClaw | Prima stesura — mobile companion + physical runtime + voce + sequenza |
