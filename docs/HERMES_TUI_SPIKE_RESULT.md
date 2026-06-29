# Hermes TUI Runtime — Spike Result (Fase -1)

> **Data:** 2026-06-29
> **Hermes:** v0.17.0 (2026.6.19), Python 3.11.15, project `~/.hermes/hermes-agent`
> **Esito:** ✅ **GATE SUPERATO** — entrambe le verifiche reggono. Le Fasi 3+ procedono come scritte nel piano. Nessun ripiego necessario.

Lo spike doveva confermare 2 punti dal vivo (l'architettura era già decisa).
Risultato: **entrambi confermati**, e in più l'intero sistema plugin/hook è stato
validato sia dalla sorgente Hermes sia da un plugin di produzione esistente
(`orca-status`), che è di fatto l'analogo già funzionante del plugin `orchestra`.

---

## 1. `HERMES_EPHEMERAL_SYSTEM_PROMPT` persiste su tutti i turni? → ✅ SÌ

**Verificato dalla sorgente (più forte di un test black-box):**

- L'env var esiste ed è di prima classe: `hermes_cli/config.py:4072` la descrive come
  *"Ephemeral system prompt injected at **API-call time** (never persisted to sessions)"*.
- Letta **per-processo** all'avvio (`cli.py:3659`, `gateway/run.py:4303` →
  `self._ephemeral_system_prompt`), poi **iniettata in ogni chiamata LLM**
  (`gateway/run.py:16143-16403`, percorso per-turno → `ephemeral_system_prompt=combined_ephemeral`).

**Conseguenza per Orchestra:**
- È **isolata per-nodo** (env del processo `hermes --tui`, come `--system-prompt` di pi). ✅
- **Regge su tutti i turni** (iniettata a ogni API call, mai persistita nella history). ✅
- ⇒ **Il rischio #1 del piano è eliminato.** Il ripiego "ruolo via `pre_llm_call` ogni
  turno" **non serve** per il system prompt. (`pre_llm_call` resta per l'appendix di contesto.)

---

## 2. Bracketed-paste nel `hermes --tui` è affidabile? → ✅ SÌ

**Verificato dal vivo** con un harness `node-pty` (lo stesso meccanismo di PtyHub):
spawn `hermes --tui`, settle ~1.5s per il mount della TUI Ink, poi
`\x1b[200~<msg>\x1b[201~` seguito (dopo 250ms) da `\r`.

- Modello: `deepseek-v4-flash-free` (gratuito — nessuna quota a pagamento consumata).
- Esito: l'agente ha **ricevuto il messaggio incollato e ha risposto** (`PONG`),
  processo uscito con codice 0. `pasted=true sawPong=true`.
- ⇒ L'iniezione task/nudge via PTY funziona come con pi. Stesso pattern
  (paste + settle + submit `\r`) → riusabile in `HermesRuntime.inject`.

---

## 3. Sistema plugin/hook — validato (sorgente + plugin di produzione)

**Struttura plugin** (`hermes_cli/plugins.py` docstring):
- Directory in `~/.hermes/plugins/<name>/` con `plugin.yaml` + `__init__.py` che espone `register(ctx)`.
- Hook: `ctx.register_hook(hook_name, callback)`.
- Tool custom: `ctx.register_tool(name, toolset, schema, handler, check_fn=, requires_env=, is_async=, description=, emoji=, override=)`
  → finiscono nel registry globale accanto ai tool built-in.

**`VALID_HOOKS`** (`hermes_cli/plugins.py:128`) include tutti quelli che servono:
`on_session_start`, `pre_llm_call`, `post_llm_call` (oltre a `pre/post_tool_call`,
`on_session_end`, `subagent_start/stop`, ecc.).

**Contratti hook (firme esatte, dalla sorgente):**

| Hook | Invocato in | kwargs ricevuti | Return |
|---|---|---|---|
| `on_session_start` | `run_agent.py` | `session_id`, `model`, `platform`, … | — (side-effect: POST `/internal/ready`) |
| `pre_llm_call` | `agent/turn_context.py:415` | `session_id`, `task_id`, `turn_id`, `user_message`, `conversation_history`, `is_first_turn`, `model`, `platform`, `sender_id` | **`{"context": "<testo>"}` o `str`** → **appeso al messaggio utente del turno** (non al system prompt) |
| `post_llm_call` | `agent/turn_finalizer.py:350` | `session_id`, `task_id`, `turn_id`, `user_message`, `assistant_response`, `conversation_history`, `model`, `platform` | — (side-effect: POST `/internal/turn-ended`) |

⇒ La mappatura pi→Hermes del piano è **corretta alla lettera**, incluso il ritorno
`{"context": ...}` di `pre_llm_call`.

**Isolamento/gating — provato da `orca-status`** (plugin utente già installato in
`~/.hermes/plugins/orca-status/`): è l'analogo già funzionante del plugin `orchestra`.
Registra `on_session_start`/`pre_llm_call`/`post_llm_call` e **fa POST a un server HTTP
locale** (`http://127.0.0.1:{port}/hook/hermes`) leggendo env var. Il gating è fatto con
**early-return no-op quando le env var richieste mancano** (`port`/`token`/`paneKey`).
⇒ Il plugin `orchestra` farà lo stesso: **no-op quando `PINODES_ORCHESTRA_NODE` è assente**,
senza disturbare l'uso normale di Hermes (`requires_env` nel manifest è un gate aggiuntivo disponibile).

---

## 4. Scoperte bonus (utili per Fase 3)

- **`ctx.inject_message(content, role)`** esiste (`plugins.py:411`): potrebbe spingere il
  nudge del watchdog **direttamente dal plugin**, senza PTY. **MA** caveat esplicito:
  *"no CLI reference (not available in gateway mode)"*. Poiché `hermes --tui` avvia un
  gateway in-process, va verificato se `_cli_ref` è valorizzato in TUI. → **Il nudge via
  PTY (piano) resta il percorso robusto**; valutare `inject_message` come ottimizzazione in Fase 3.
- **`handoffCalledThisTurn`** è calcolabile lato plugin: tracciare con un flag a livello
  di modulo (chiavato per `task_id`/`session_id`, come fa `disk-cleanup` con i suoi set)
  se l'handler del tool `orchestra_handoff` è scattato nel turno corrente; `post_llm_call`
  riceve `conversation_history` + `assistant_response` per il fallback.
- **Modello configurato:** `deepseek-v4-flash-free` (gratuito) + Nous Portal loggato →
  utilizzabile per i test E2E di Fase 5 senza costi.

---

## Gate

✅ **Entrambi i punti reggono.** Nessun ripiego attivato. Le Fasi 0-1-2 (refactor
runtime-agnostic) e la Fase 3 (HermesRuntime + plugin `orchestra`) procedono come da piano.
Unico aggiornamento al piano: il fallback "system prompt via `pre_llm_call`" è **superfluo**
(l'env var regge su tutti i turni) — `pre_llm_call` serve solo per l'appendix di contesto.

### Riferimenti sorgente (Hermes v0.17.0)
- `hermes_cli/config.py:4072` · `cli.py:3659` · `gateway/run.py:4303,16143,16403` — ephemeral system prompt
- `hermes_cli/plugins.py:128` (`VALID_HOOKS`), `:315` (`PluginContext`), `:367` (`register_tool`), `:411` (`inject_message`), `:1044` (`register_hook`)
- `agent/turn_context.py:415` (`pre_llm_call`) · `agent/turn_finalizer.py:350` (`post_llm_call`) · `run_agent.py:591` (`on_session_start`)
- `~/.hermes/plugins/orca-status/` — plugin di produzione di riferimento (lifecycle → HTTP POST, gating env)
