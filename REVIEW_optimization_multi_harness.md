# Review: Analisi tecnica v2 — ottimizzazione e integrazione multi-harness

**Reviewer:** Hermes Agent (GLM-5.2)
**Data:** 2026-07-01
**Repo state:** `main` @ `4e0a4fd` · `feat/hermes-tui-runtime` pushato su origin
**Documento reviewato:** Analisi tecnica v2 (ottimizzazione CPU/memoria, pattern multi-harness, valutazione T3 Code)

---

## Metodologia

Ogni claim tecnica è stata verificata contro il codice sorgente. Le claim della v1 erano già state tutte confermate. La v2 introduce una claim nuova non verificata nella prima review: il plugin Hermes registra tool nativi via `ctx.register_tool()` invece di parsare `@@HANDOFF` dal testo. Questa claim è stata verificata leggendo `backend/hermes-plugins/orchestra/__init__.py` sul branch `feat/hermes-tui-runtime`.

---

## 1. Verifica claim tecniche v2

| Claim v2 | Esito | Evidenza |
|---|---|---|
| PtyHub.ts = 760 righe | ✅ | `wc -l` confermato su main |
| Backend ~4.300 righe TS | ✅ | 4.324 totale |
| `MAX_BUFFER = 256_000` | ✅ | PtyHub.ts:11 |
| `session.buffer` letto in un solo punto (`ensure()`) | ✅ | PtyHub.ts:368 — unico read site nel codebase |
| Buffer non usato da watchdog/handoff | ✅ | Handoff parsing è in `call-agent.ts` evento `agent_end` su `messages`, non su `session.buffer` |
| `JSON.stringify` O(1) per messaggio, non O(M) | ✅ | handler.ts:9 — una chiamata prima del loop |
| Pattern multi-runtime già implementato su `feat/hermes-tui-runtime` | ✅ | 31 file, +2396/-860. `INodeRuntime.ts`, `PtyRuntime.ts`, `PiRuntime.ts`, `HermesRuntime.ts`, `findInPath.ts` |
| Plugin Hermes registra `orchestra_handoff` come tool nativo via `ctx.register_tool()` | ✅ | `__init__.py`: `ctx.register_tool("orchestra_handoff", "orchestra", {schema}, orchestra_handoff, ...)` — function-calling vero, nessun parsing `@@HANDOFF` |
| Plugin registra anche `orchestra_card` come tool nativo | ✅ | Stesso pattern: `ctx.register_tool("orchestra_card", ...)` |
| Hook lifecycle: `on_session_start` → `/internal/ready`, `pre_llm_call` → `/internal/orchestra-context`, `post_llm_call` → `/internal/turn-ended` | ✅ | Tutti e tre gli hook presenti e confermati |
| `post_llm_call` usa flag `_handoff_called_this_turn` per sapere se handoff avvenuto | ✅ | Set a `True` dentro `orchestra_handoff()`, letto in `post_llm_call` per `/internal/turn-ended` |
| T3 Code = app Electron sibling, non embeddabile | ✅ | Ragionamento architetturale corretto |

---

## 2. Correzioni v1 → v2: tutte integrate correttamente

### 2.1 §2.2 — serializzazione

**v1 (errato):** "il costo di serializzazione+invio cresce con M"
**v2 (corretto):** `JSON.stringify` è O(1) per messaggio, solo `ws.send` scala con M. Beneficio reale è bandwidth, non CPU.

✅ Integrazione corretta. La precisazione che il ROI è basso per single developer locale è mantenuta e corretta.

### 2.2 §3 — pattern già implementato

**v1 (errato):** presentava HermesRuntime come pattern futuro da seguire
**v2 (corretto):** ~e codice esistente su `feat/hermes-tui-runtime`, 31 file. L'astrazione (`INodeRuntime`, `PtyRuntime`) esiste già. Generalizzare = aggiungere classi `extends PtyRuntime`.

✅ Integrazione corretta. Alberatura dei file e responsabilità delle classi verificata contro il branch.

### 2.3 §3 — handoff Hermes via tool nativo

**Claim nuova v2:** il plugin Hermes **non parsa** `@@HANDOFF`. Registra `orchestra_handoff(recipient, message)` come tool nativo via `ctx.register_tool()`. Il modello lo chiama con function-calling.

✅ **Verificato contro `__init__.py`:**

```python
ctx.register_tool(
    "orchestra_handoff",
    "orchestra",
    {
        "type": "object",
        "properties": {
            "recipient": {"type": "string", ...},
            "message": {"type": "string", ...},
        },
        "required": ["recipient", "message"],
    },
    orchestra_handoff,
    description="Hand off work to another agent in the pipeline",
    emoji="🤝",
)
```

Il tool `orchestra_handoff` chiama `POST /internal/call-agent` con `{boardId, fromNodeId, targetNodeId: recipient, message}`. Stesso endpoint usato da pi via `call-agent.ts`, ma senza parsing regex — il modello chiama direttamente la funzione.

`orchestra_card(column)` segue lo stesso pattern per il Kanban → `POST /internal/card-status`.

Il flag `_handoff_called_this_turn` è settato a `True` dentro `orchestra_handoff()` e letto in `post_llm_call` per segnalare `/internal/turn-ended` — il watchdog sa se l'handoff è avvenuto senza parsare testo.

**Questa è la distinzione architetturale più importante del documento:** pi usa parsing regex su output PTY (`@@HANDOFF:<handle> ... @@END`), Hermes usa tool nativo con function-calling. Per harness senza un sistema di plugin equivalente, resta necessario il parser ad-hoc.

### 2.4 §2.1 — superficie minima del refactor

**v2 aggiunge:** `session.buffer` è letto in un solo punto (`ensure()`), non è in alcun hot path.

✅ Confermato. L'unico read site è `PtyHub.ts:368` (`return existing.buffer`). Il refactor richiede di modificare solo scrittura (`onData`) e lettura (`ensure`).

---

## 3. Osservazioni aggiuntive

### 3.1 Implicazione per la generalizzazione multi-harness

La v2 identifica correttamente il vero bottleneck: non l'astrazione runtime (già esistente), ma l'handoff parser per-harness. La classe di soluzioni è:

| Harness | Sistema plugin/tool nativo? | Approccio handoff possibile |
|---|---|---|
| pi | Sì (extension API, `call-agent.ts`) | Parsing `@@HANDOFF` su `agent_end` (attuale) |
| Hermes | Sì (plugin Python, `ctx.register_tool`) | Tool nativo `orchestra_handoff` (attuale) |
| Claude Code | Sì (hooks + `--output-format json`) | Hook con parsing JSON strutturato |
| Codex CLI | Sì (`--json`) | Parsing JSON strutturato su output |
| OpenCode | Sì (endpoint `/zen/v1` JSON-RPC) | Adapter con JSON-RPC, niente PTY |

OpenCode è il caso più interessante: ha un endpoint JSON-RPC strutturato, quindi non serve nemmeno il PTY — potrebbe bypassare `PtyRuntime` entirely con un runtime ad-hoc che implementa `INodeRuntime` su JSON-RPC invece che su PTY.

### 3.2 Priorità §5 — confermata

La tabella priorità è corretta nell'ordinamento. §2.1 (buffer) prima di §3 (handoff parser) è giusto: il refactor del buffer è sicuro e localizzato, mentre il parser multi-harness è lavoro alto-effort che dipende dalla morphologia di ciascun CLI.

---

## 4. Verdetto finale

La v2 integra correttamente tutte e tre le correzioni richieste dalla review v1. La claim nuova (tool nativo Hermes via `ctx.register_tool`) è verificata e accurata. Il documento è pronto per essere trasformato in issue/PR.

**Zero correzioni richieste sulla v2.**