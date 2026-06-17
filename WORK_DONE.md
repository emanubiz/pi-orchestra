# Work Done — Pinodes Orchestra P2

> Branch: `feat/p2-cli-and-crud` · Stato: working directory (non committato), in attesa di review finale

---

## 1. Problema di partenza

Pinodes Orchestra è un visual canvas per agent pipeline basato su pi CLI. Prima del mio intervento:

### Lacune della P1

- **Niente CRUD granulare** — per aggiungere, modificare o rimuovere un singolo nodo o edge dovevi riscrivere tutto il grafo via `PUT /boards/:id/graph` con l'intero JSON. Zero atomicità.
- **Niente CLI** — l'unica interfaccia era REST (curl, fetch). Zero comandi da terminale per scripting e automazione.
- **Zero validazione granulare** — `setGraph` bulk accettava qualunque grafo senza controlli su self-loop, edge verso nodi inesistenti, ecc.

### Codebase pre-esistente

- `BoardManager.ts` — 160 righe, board + graph + PTY lifecycle
- `PtyHub.ts` — 500 righe, PTY spawn, handoff, inject, resize, kill, waitForExit
- `routes/orchestra.ts` — route P0/P1 complete
- Nessun CLI nel progetto

---

## 2. Cosa è stato implementato

### Blocco A — CRUD granulare (nodi e edge)

Nuove operazioni atomiche su nodi e edge senza dover riscrivere l'intero grafo.

**BoardManager.ts** — 5 nuovi metodi:
- `addNode(boardId, node)` — crea nodo, persiste via setGraph
- `updateNode(boardId, nodeId, patch)` — muta campi selettivi, persiste con live sync di connessioni e finalità
- `deleteNode(boardId, nodeId)` — rimuove nodo + edge orfani + kill PTY se in esecuzione
- `addEdge(boardId, edge)` — crea edge, persiste
- `deleteEdge(boardId, edgeId)` — rimuove edge, persiste

**Routes** — 5 nuovi endpoint REST:

| Metodo | Endpoint |
|--------|----------|
| `POST` | `/boards/:id/nodes` |
| `PATCH` | `/boards/:id/nodes/:nodeId` |
| `DELETE` | `/boards/:id/nodes/:nodeId` |
| `POST` | `/boards/:id/edges` |
| `DELETE` | `/boards/:id/edges/:edgeId` |

### Blocco B — CLI Wrapper

`backend/src/cli.ts`: wrapper a riga di comando che chiama la REST API via `fetch` nativo Node, zero dipendenze extra.

```bash
# Boards
pinodes-orchestra board create <cwd> [label]
pinodes-orchestra board list|delete|status|graph

# Nodes
pinodes-orchestra node add <boardId> <label> <promptId> [--x X] [--y Y] ...
pinodes-orchestra node update <boardId> <nodeId> [--label L] ...
pinodes-orchestra node delete <boardId> <nodeId>

# Edges
pinodes-orchestra edge add <boardId> <src> <tgt>
pinodes-orchestra edge delete <boardId> <edgeId>

# Execution
pinodes-orchestra run <boardId> <message> [--nodeId NID]
pinodes-orchestra inject <boardId> <nodeId> <message>
pinodes-orchestra stop <boardId>
pinodes-orchestra flow <name> <cwd> <graph.json> <message> [--wait] [--timeout MS]

# General
pinodes-orchestra health|info|help
```

Environment: `PINODES_ORCHESTRA_URL` (default `http://localhost:3847`) e `PINODES_ORCHESTRA_TOKEN`.

### Blocco C — Fix post-review

Dopo l'analisi di un agente contrarian, sono stati fixati **3 problemi reali**:

| Problema | Fix |
|----------|-----|
| `/flows` memory/db leak | Board automaticamente cancellata dopo `wait: true` completato (es. → non più leak) |
| Self-loop non bloccato | `addEdge` rifiuta sourceNodeId === targetNodeId con errore esplicito |
| Edge verso nodi inesistenti | `addEdge` valida che source e target nodi esistano nel grafo |

Più 4 fix da autovalutazione:
- `deleteNode` ora distingue "Board not found" vs "Node not found"
- Rimosso codice morto (`named.pos` fallback) da `cli.ts`
- Aggiunto comando `inject` separato da `run` per targeting diretto
- Aggiunto `.vsix` a `.gitignore`

### Blocco D — Allineamento documentazione

`docs/PROGRAMMATIC_API.md` aggiornata:
- Status bar aggiornato (P0 + P2 implementati)
- Sezione "CLI Wrapper (Implemented)" completa
- 5 endpoint mancanti aggiunti alla overview REST
- Tabella implementation priority corretta (pipe rotto fixato)
- Nota su `/flows` auto-cleanup aggiunta

`WORK_DONE.md` (questo file) creato come report finale.

---

## 3. Architettura

Scelta chiave: **riusare `setGraph` come unico punto di persistenza**. Tutti i metodi CRUD:

1. Mutano la reference in-memory del grafo
2. Chiamano `this.setGraph(boardId, board.graph)` già esistente

Che garantisce automaticamente:
- Scrittura su SQLite
- Re-sync nel PtyHub
- Live sync (`notifyConnectionsChange`, `notifyFinalityChange`) per nodi in esecuzione
- PTY kill per nodi cancellati

> **Superato dal lavoro "Deterministic Orchestration"** (branch
> `feat/deterministic-orchestration`). Il live sync via `notifyConnectionsChange` /
> `notifyFinalityChange` (che digitava nel PTY) è stato **rimosso**: il contesto
> di orchestrazione è ora ripreso **per-turno** dall'estensione via
> `GET /internal/orchestra-context`. Inoltre i metodi CRUD non mutano più la
> reference in-memory in place ma costruiscono un grafo nuovo (immutabile), così
> un fallimento della nuova `validateGraph` non lascia stato sporco. Vedi
> `ARCHITECTURE.md → Handoff protocol` e `DETERMINISTIC_ORCHESTRATION_DESIGN.md`.

---

## 4. Stato attuale

| Elemento | Stato |
|----------|-------|
| Branch | `feat/p2-cli-and-crud` |
| Commit | Nessuno — working directory, non staged, non committato |
| Compilazione | ✅ `tsc --noEmit` zero errori |
| Backend test live | ✅ Board, graph, node add/update/delete, edge add/delete, validazioni, CLI |
| Documentazione allineata | ✅ `PROGRAMMATIC_API.md` |
| In attesa di | Review finale prima del commit |
