import * as vscode from "vscode";
import { BackendManager } from "./backend";

/**
 * Full editor-area webview that embeds the standalone pinodes-orchestra UI in an
 * iframe pointing at the local backend. The backend already serves the built
 * frontend (React Flow + xterm) on `/`, so we just need to frame it; live PTY
 * WebSockets run inside the iframe against its own (backend) origin.
 */
export class OrchestraPanel {
  private static current: OrchestraPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static async show(context: vscode.ExtensionContext, backend: BackendManager): Promise<void> {
    if (OrchestraPanel.current) {
      OrchestraPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const autoStart = vscode.workspace
      .getConfiguration("pinodesOrchestra")
      .get<boolean>("autoStartBackend", true);
    if (autoStart) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Starting PiNodes Orchestra backend…" },
        () => backend.ensureStarted(),
      );
    }

    const panel = vscode.window.createWebviewPanel(
      "pinodesOrchestra.panel",
      "PiNodes Orchestra",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    OrchestraPanel.current = new OrchestraPanel(panel, backend);
  }

  private constructor(panel: vscode.WebviewPanel, private readonly backend: BackendManager) {
    this.panel = panel;
    void this.render();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; action?: string; id?: number; text?: string }) => {
        if (msg?.type === "reload") void this.render();
        if (msg?.type === "clipboard" && typeof msg.id === "number") {
          void this.handleClipboard(msg.action, msg.id, msg.text);
        }
      },
      null,
      this.disposables,
    );
  }

  private async handleClipboard(
    action: string | undefined,
    id: number,
    text: string | undefined,
  ): Promise<void> {
    try {
      if (action === "read") {
        const clip = await vscode.env.clipboard.readText();
        await this.panel.webview.postMessage({ type: "clipboard-result", id, text: clip });
      } else if (action === "write") {
        await vscode.env.clipboard.writeText(text ?? "");
        await this.panel.webview.postMessage({ type: "clipboard-result", id });
      } else {
        await this.panel.webview.postMessage({
          type: "clipboard-result",
          id,
          error: "unknown clipboard action",
        });
      }
    } catch (err) {
      await this.panel.webview.postMessage({
        type: "clipboard-result",
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async render(): Promise<void> {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(this.backend.baseUrl));
    // Embedded mode: bind the single board to the VS Code workspace folder and
    // hide the standalone repo-tab switcher (see frontend/src/lib/embed.ts).
    const url = new URL(external.toString());
    url.searchParams.set("embed", "vscode");
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) url.searchParams.set("cwd", folder);
    const token = vscode.workspace
      .getConfiguration("pinodesOrchestra")
      .get<string>("token", "")
      .trim();
    if (token) url.searchParams.set("token", token);
    this.panel.webview.html = renderHtml(this.panel.webview, url.toString());
  }

  dispose(): void {
    OrchestraPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function renderHtml(webview: vscode.Webview, src: string): string {
  // The iframe loads the backend origin; allow framing http/https + ws for it.
  const csp = [
    "default-src 'none'",
    "frame-src http: https:",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background, #09090b); }
    iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    #fallback {
      position: absolute; inset: 0; display: none; place-content: center;
      color: #a1a1aa; font-family: var(--vscode-font-family); text-align: center; padding: 2rem;
    }
    #fallback button {
      margin-top: 1rem; padding: 6px 14px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
    }
  </style>
</head>
<body>
  <iframe id="app" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
  <div id="fallback">
    <div>
      <p>PiNodes Orchestra backend is not reachable.</p>
      <button onclick="reload()">Retry</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('app');
    const fallback = document.getElementById('fallback');
    function reload() { vscode.postMessage({ type: 'reload' }); }
    frame.addEventListener('error', () => { fallback.style.display = 'grid'; });

    // The framed app is cross-origin and can't read our --vscode-* variables,
    // so forward the editor theme colors into it (and re-forward on theme switch).
    function readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const bg = cs.getPropertyValue('--vscode-editor-background').trim();
      const fg = (cs.getPropertyValue('--vscode-editor-foreground').trim()
        || cs.getPropertyValue('--vscode-foreground').trim());
      const cls = document.body.className;
      const kind = (cls.indexOf('vscode-light') !== -1
        || cls.indexOf('vscode-high-contrast-light') !== -1) ? 'light' : 'dark';
      return { type: 'host-theme', bg: bg, fg: fg, kind: kind };
    }
    function postTheme() {
      try { frame.contentWindow && frame.contentWindow.postMessage(readTheme(), '*'); } catch (e) {}
    }
    frame.addEventListener('load', postTheme);
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'orchestra-ready') postTheme();
      // Relay clipboard ops from the cross-origin iframe to the extension host,
      // where vscode.env.clipboard works reliably (iframe Clipboard API does not).
      if (e.source === frame.contentWindow && e.data && e.data.type === 'orchestra-clipboard') {
        vscode.postMessage({
          type: 'clipboard',
          action: e.data.action,
          id: e.data.id,
          text: e.data.text,
        });
      }
    });
    // Extension → iframe: forward clipboard results back into the app.
    window.addEventListener('message', function (e) {
      var msg = e.data;
      if (!msg || msg.type !== 'clipboard-result') return;
      try {
        frame.contentWindow && frame.contentWindow.postMessage({
          type: 'orchestra-clipboard-result',
          id: msg.id,
          text: msg.text,
          error: msg.error,
        }, '*');
      } catch (err) {}
    });
    // VS Code swaps the theme by mutating the body class + --vscode-* vars.
    new MutationObserver(postTheme).observe(document.body, {
      attributes: true, attributeFilter: ['class'],
    });
  </script>
</body>
</html>`;
}
