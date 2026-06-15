import pty from "node-pty";
import path from "node:path";

const cli = path.resolve("backend/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const cols = Number(process.argv[2] || 80);
const rows = Number(process.argv[3] || 24);

const term = pty.spawn(process.execPath, [cli, "--tools", "read,bash", "--name", "repro", "--system-prompt", "test"], {
  name: "xterm-256color",
  cols, rows,
  cwd: process.cwd(),
  env: { ...process.env },
});

let out = "";
term.onData((d) => { out += d; process.stdout.write(d); });

// Wait for boot, then type "te come stai" one char at a time.
const text = "te come stai";
setTimeout(async () => {
  console.error(`\n\n===== TYPING at cols=${cols} rows=${rows} =====\n`);
  for (const ch of text) {
    term.write(ch);
    await new Promise(r => setTimeout(r, 120));
  }
  setTimeout(() => {
    console.error("\n\n===== RAW OUTPUT (escaped) tail =====");
    console.error(JSON.stringify(out.slice(-600)));
    term.kill();
    process.exit(0);
  }, 600);
}, 4000);
