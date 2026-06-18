// Lightweight pub/sub bridging the single WebSocket to per-node xterm instances.
// Keyed by `${boardId}:${nodeId}`.

type OutputHandler = (data: string, replay: boolean) => void;
type ExitHandler = (code: number) => void;
type SizeHandler = (cols: number, rows: number) => void;
type ReadyHandler = () => void;

const outputSubs = new Map<string, Set<OutputHandler>>();
const exitSubs = new Map<string, Set<ExitHandler>>();
const sizeSubs = new Map<string, Set<SizeHandler>>();
const readySubs = new Map<string, Set<ReadyHandler>>();

export function onPtyOutput(key: string, handler: OutputHandler): () => void {
  let set = outputSubs.get(key);
  if (!set) {
    set = new Set();
    outputSubs.set(key, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

export function onPtyExit(key: string, handler: ExitHandler): () => void {
  let set = exitSubs.get(key);
  if (!set) {
    set = new Set();
    exitSubs.set(key, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

export function onPtySize(key: string, handler: SizeHandler): () => void {
  let set = sizeSubs.get(key);
  if (!set) {
    set = new Set();
    sizeSubs.set(key, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

export function emitPtyOutput(key: string, data: string, replay: boolean): void {
  outputSubs.get(key)?.forEach((h) => h(data, replay));
}

export function emitPtyExit(key: string, code: number): void {
  exitSubs.get(key)?.forEach((h) => h(code));
}

export function emitPtySize(key: string, cols: number, rows: number): void {
  sizeSubs.get(key)?.forEach((h) => h(cols, rows));
}

export function onNodeReady(key: string, handler: ReadyHandler): () => void {
  let set = readySubs.get(key);
  if (!set) {
    set = new Set();
    readySubs.set(key, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

export function emitNodeReady(key: string): void {
  readySubs.get(key)?.forEach((h) => h());
}
