import type { Terminal } from "@xterm/xterm";

/**
 * Wire copy/paste onto an interactive xterm terminal. By default xterm forwards
 * every keystroke to the PTY, so neither Ctrl+Shift+C nor a right-click "Copy"
 * do anything. This adds:
 *   - Ctrl+Shift+C → copy the current selection
 *   - Ctrl+Shift+V → paste from the clipboard into the PTY
 *   - right-click  → a small Copy/Paste context menu
 *
 * Pure DOM (no React) so it can be dropped into any terminal component with a
 * single call; returns a cleanup function to detach everything.
 */
export function attachClipboard(term: Terminal, host: HTMLElement): () => void {
  let menu: HTMLElement | null = null;

  const copySelection = () => {
    const sel = term.getSelection();
    if (sel) void navigator.clipboard.writeText(sel);
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch {
      // clipboard read denied — nothing we can do
    }
  };

  // Keyboard: swallow the shortcuts so they don't reach the PTY (returning
  // false tells xterm not to process the event).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
    const k = e.key.toLowerCase();
    if (k === "c") {
      copySelection();
      return false;
    }
    if (k === "v") {
      void paste();
      return false;
    }
    return true;
  });

  const closeMenu = () => {
    menu?.remove();
    menu = null;
    document.removeEventListener("mousedown", onAway, true);
    document.removeEventListener("keydown", onEsc, true);
  };
  const onAway = (e: MouseEvent) => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMenu();
  };

  const mkItem = (label: string, enabled: boolean, run: () => void) => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.disabled = !enabled;
    item.style.cssText =
      "display:block;width:100%;text-align:left;padding:4px 14px;font-size:12px;" +
      "font-family:ui-sans-serif,system-ui,sans-serif;background:transparent;border:0;" +
      `color:${enabled ? "#e4e4e7" : "#52525b"};cursor:${enabled ? "pointer" : "default"};`;
    if (enabled) {
      item.addEventListener("mouseenter", () => (item.style.background = "rgba(255,255,255,0.06)"));
      item.addEventListener("mouseleave", () => (item.style.background = "transparent"));
      item.addEventListener("click", () => {
        run();
        closeMenu();
      });
    }
    return item;
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    closeMenu();
    const hasSel = term.hasSelection();
    menu = document.createElement("div");
    menu.style.cssText =
      "position:fixed;z-index:9999;min-width:120px;padding:4px 0;border-radius:8px;" +
      "background:#18181b;border:1px solid rgba(255,255,255,0.1);" +
      "box-shadow:0 8px 24px rgba(0,0,0,0.5);";
    menu.append(
      mkItem("Copy", hasSel, copySelection),
      mkItem("Paste", true, () => void paste()),
    );
    // Keep the menu inside the viewport.
    const x = Math.min(e.clientX, window.innerWidth - 140);
    const y = Math.min(e.clientY, window.innerHeight - 80);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
    document.body.appendChild(menu);
    document.addEventListener("mousedown", onAway, true);
    document.addEventListener("keydown", onEsc, true);
  };

  host.addEventListener("contextmenu", onContextMenu);

  return () => {
    host.removeEventListener("contextmenu", onContextMenu);
    closeMenu();
  };
}
