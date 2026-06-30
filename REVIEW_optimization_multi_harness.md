# Review: Analisi tecnica — ottimizzazione e integrazione multi-harness

**Reviewer:** Hermes Agent (GLM-5.2)
**Data:** 2026-07-01
**Repo state:** `main` @ `4e0a4fd`
**Documento reviewato:** Analisi tecnica non-committata (ottimizzazione CPU/memoria, pattern multi-harness, valutazione T3 Code)

---

## Metodologia

Ogni claim tecnica è stata verificata contro il codice sorgente a `main` (HEAD `4e0a4fd`). Le dimensioni dei file, le righe citate, le strutture dati e i pattern architetturali sono stati confrontati direttamente. Le osservazioni che followsi basano su codice reale, non sul documento in se stesso.

---

## 1. Verifica delle claim tecniche

| Claim del documento | Esito | Note |
|---|---|---|
| `PtyHub.ts` = 760 righe | ✅ | Confermato |
| Backend ~4.300 righe TS | ✅ | 4.324 totale (find + wc -l) |
| HEAD = `4e0a4fd` | ✅ | `main` è a questo commit |
| `MAX_BUFFER = 256_000` a riga 11 | ✅ | Letterale verificato |
| `session.buffer + data).slice(-MAX_BUFFER` a riga 448 | ✅ | Esatto: `term.onData` → concat + slice per ogni chunk |
| `clients = new Set<WebSocket>()` globale, non partizionato per board | ✅ | `ws/handler.ts:6`, nessun filtro per board nel loop di broadcast |
| `docs/HERMES_DESKTOP.md` Option C — HermesRuntime | ✅ | Riga 90-99, descrive sostituzione di pi spawn con Hermes TUI gateway |
| T3 Code = app Electron, non libreria embeddabile | ✅ | Ragionamento architetturale corretto |

---

## 2. §2.1 — Buffer a chunk: problema reale, surface più piccola del previsto

Il documento propone di sostituire `session.buffer` stringa singola con una struttura a chunk, Ricostruzione della stringa completa solo on-demand (replay scrollback in `attach_node`).

**Verifica:** `session.buffer` è letto in **un solo punto** dell'intero codebase — `PtyHub.ts:368`:

```ts
return existing.buffer;  // dentro ensure(), per il replay al client che si connette
```

Il buffer **non** è usato da:
- Watchdog deterministico (gira nell'estensione `call-agent.ts`, evento `agent_end`)
- Rilevamento `@@HANDOFF` (parsing regex su `messages` dell'agent, non sul PTY output)
- alcun hot path di bootstrap, iniezione, o handoff

**Implicazione:** il refactor ha una superficie minima. Cambiare la struttura dati interna (`string` → `string[]` ring buffer o `Buffer` circolare) richiede di modificare solo:
1. La scrittura in `onData` (riga 448)
2. La lettura in `ensure()` (riga 368) — ricostruire la stringa con `.join("")` solo qui

Tutto il resto del codebase è agnostico alla struttura interna del buffer. Il riesgo di regressione è basso e localizzato.

**Concordo con la priorità indicata (Alta).** Il profiling reale suggerito in §6 rimane necessario per quantificare, ma il refactor è sicuro indipendentemente dallentità del beneficio — la struttura attuale è oggettivamente O(n) per chunk con n fino a 256.000 char.

---

## 3. §2.2 — Broadcast non filtrato: problema reale, premessa sbagliata

Il documento afferma: "il costo di serializzazione+invio cresce con M anche per dati irrilevanti a M-1 client."

**Verifica del codice (`ws/handler.ts:8-12`):**

```ts
function broadcast(msg: Record<string, unknown>): void {
  const payload = JSON.stringify(msg);   // ← UNA volta per messaggio
  for (const client of clients) {
    if (client.readyState === 1) client.send(payload);  // ← stesso string, O(M) send
  }
}
```

`JSON.stringify` è O(1) per messaggio, **non** O(M). Il costo che scala con M è solo `ws.send` — che su localhost è una memory copy nel frame buffer WebSocket. Il beneficio reale del filtering per board non è CPU, è **bandwidth**: evitare di inviare payload irrilevanti al frontend.

**Per il use case reale** (single developer locale, 1-2 client tipicamente), il ROI è basso. La domanda aperta in §6 ("vale la pena filtrare per board?") ha risposta: **non ora**, a meno che non emerga un scenario multi-client reale (es. dashboard condivisa, CI watcher).

### Dettaglio tecnico sulla proposta Map

Il documento propone `Map<boardId, Set<WebSocket>>`. Dettaglio non addressato: il frontend può avere **multiple board aperte nello stesso tab** (README: "tab multiple"). Un singolo `ws` può essere iscritto a più board. La struttura corretta richiede che:

- Uno stesso `ws` compaia in più `Set` (uno per board a cui è iscritto)
- Il cleanup su `ws.close` rimuova il ws da **tutti** i set, non solo uno
- L'iscrizione avvenga su `load_graph` (messaggio WS esistente in `handler.ts:45-56`)

Non è un blocker, ma va specificato nell'implementazione per evitare leak di ws zombie.

---

## 4. §3 — Pattern multi-harness: già implementato, non solo proposto

Il documento presenta il pattern HermesRuntime come "generalizzabile a qualunque harness CLI-based" e lo descrive come lavoro futuro da fare.

**Verifica:** il branch `feat/hermes-tui-runtime` (già pushato su `origin`) **lo implementa già concretamente**:

```
HermesRuntime.ts       → extends PtyRuntime, spawn `hermes --tui`
PtyRuntime.ts          → astrazione base per qualunque runtime PTY
INodeRuntime.ts        → interfaccia RuntimeSpawnConfig
findInPath.ts          → utility per risolvere binari su PATH
runtimeStore.ts (FE)   → supporto UI per tipi di nodo multipli
```

Diff: 31 file, 2.396 inserimenti, 860 cancellazioni. Non è un pattern ipotetico — è codice esistente che necessita di review/merge (o scarto).

**Correzione proposta per il documento:** §3 dovrebbe dire "il pattern è già implementato su `feat/hermes-tui-runtime` come HermesRuntime — la generalizzazione a claude-code/codex/opencode richiede di implementare runtime aggiuntivi che extends PtyRuntime con parse-specific handoff logic, non di creare l'astrazione da zero."

---

## 5. §4 — T3 Code: valutazione corretta

Nessuna critica. L'analisi è accurata:
- T3 Code è un'app Electron sibling, non embeddabile come nodo
- Le CLI supportate (claude, codex, opencode, cursor-agent) sono binari CLI come pi
- Il pattern branch-per-thread + PR è ortogonale e riuscabile come feature propria
- Il vero collo di bottiglia per multi-harness è l'handoff parser per-harness, non l'astrazione runtime

---

## 6. §6 — Risposte alle domande aperte

### Q1: "Qualcuno ha dati di carico reali?"

**Risposta parziale dal codice:** il buffer PTY **non** è nell'hot path del handoff. Il parsing `@@HANDOFF` avviene nell'estensione `call-agent.ts` evento `agent_end`, che opera su `messages` (l'array di messaggi dell'agent loop), non sul `session.buffer` PTY. Quindi anche se il buffer fosse un collo di bottiglia di allocazione, non impatta la latenza del handoff. Il profiling resta necessario per quantificare il beneficio GC, ma il refactor è sicuro indipendentemente.

### Q2: "Vale la pena filtrare per board?"

**No, per ora.** Il costo che scales con M è solo `ws.send` su localhost (memory copy marginale), non `JSON.stringify` (O(1) per messaggio). Per single developer locale con 1-2 client, il ROI è basso. Investire solo se emerge un scenario multi-client reale.

### Q3: "Esiste uno standard per structured output nei CLI esterni?"

**Parziale.** Claude Code supporta `--output-format json` (modalità non-interactive). Codex CLI ha `--json`. OpenCode ha endpoint `/zen/v1` con JSON-RPC strutturato. Tutti possono emettere structured output, ma nessuno emette `@@HANDOFF` nativamente — il parser ad-hoc resta necessario per ciascuno. L'alternativa è un protocollo custom via plugin (come fa pi con `call-agent.ts`): se l'harness supporta un hook `agent_end` equivalente, si può parsare lì il block handoff invece che fare screen-scraping del PTY.

---

## 7. Verdetto finale

Il documento è tecnicamente accurato nelle claim fattuali (tutte verificate) e ben argomentato nella sezione T3 Code. Tre correzioni necessarie prima di trasformarlo in issue/PR:

1. **§3:** aggiornare — il pattern non è "da seguire", è già implementato su `feat/hermes-tui-runtime`
2. **§2.2:** correggere "serializzazione cresce con M" → è solo `ws.send`, non `JSON.stringify`
3. **§2.1:** aggiungere che la safe-surface del refactor è minima (buffer letto solo in `ensure()`)

Le priorità della tabella §5 sono corrette nell'ordinamento. §2.1 prima di §2.2 è giusto anche con i caveat sopra.