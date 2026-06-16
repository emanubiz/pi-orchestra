import { createRoot } from "react-dom/client";
import { App } from "./App";
import { IS_EMBEDDED } from "./lib/embed";
import "./index.css";

if (IS_EMBEDDED) {
  // In a host webview (VS Code) the PWA service worker only gets in the way:
  // it caches a stale app shell and fights live updates. Tear down any SW that
  // a previous standalone visit registered on this origin, and never register
  // a new one.
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch((err) => {
        console.error("pinodes-orchestra: service worker teardown failed", err);
      });
  }
  if (typeof caches !== "undefined") {
    void caches.keys().then((keys) => keys.forEach((k) => void caches.delete(k)));
  }
} else {
  // Standalone / PWA: register the auto-updating service worker.
  void import("virtual:pwa-register").then(({ registerSW }) =>
    registerSW({ immediate: true }),
  );
}

createRoot(document.getElementById("root")!).render(<App />);
