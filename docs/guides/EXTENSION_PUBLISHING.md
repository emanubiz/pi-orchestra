# Multi-Platform VSIX Publishing Guide

This document describes the build and publishing process for the PiNodes Orchestra VS Code extension, which bundles native Node.js modules (`node-pty`, `better-sqlite3`) and therefore requires **platform-specific VSIX packages**.

## Why Platform-Specific Builds?

The extension embeds a self-contained backend server under `server/` that includes:

| Native Module | Purpose | Constraint |
|---------------|---------|------------|
| `node-pty` | Pseudoterminal spawning for agent PTYs | Prebuilt binaries exist for all platforms, but `better-sqlite3` does not |
| `better-sqlite3` | Local SQLite persistence for board state | **Must be compiled natively on each target OS/arch + Node ABI** |

Because `better-sqlite3` has no prebuilt binaries on npm, the compiled `.node` artifact is bound to:
- Operating system (Linux / Windows / macOS)
- Architecture (x64 / arm64)
- Node.js ABI version (determined by Node major version)

A VSIX built on Linux **will not work** on Windows or macOS. The VS Code Marketplace requires separate `.vsix` files per platform.

## Supported Targets

| Platform | Target String | Node Version | Notes |
|----------|---------------|--------------|-------|
| Linux x64 | `linux-x64` | 24.x (ABI 137) | Primary CI target |
| Windows x64 | `win32-x64` | 24.x (ABI 137) | Requires Visual Studio Build Tools |
| macOS arm64 | `darwin-arm64` | 24.x (ABI 137) | Apple Silicon (M-series) |
| ~~macOS x64~~ | `darwin-x64` | — | **Not built in CI**: GitHub no longer offers a free Intel macOS runner. Build locally on an Intel Mac if needed. |

## Build Prerequisites (per machine)

### Linux (x64)
```bash
# Already satisfied on standard Ubuntu/Debian
sudo apt-get install -y build-essential python3
```

### Windows (x64)
- **Visual Studio Build Tools 2022** with "Desktop development with C++" workload
- **Python 3.x** in PATH
- Node.js 24.x installed

### macOS (x64 & arm64)
- **Xcode Command Line Tools**: `xcode-select --install`
- Node.js 24.x (via `nvm`, `fnm`, or official installer)
- For arm64 builds: run on Apple Silicon hardware (or use GitHub Actions `macos-14`/`macos-15` runners)

## Build Procedure (per machine)

Clone the repo, then:

```bash
# From the repo root: installs workspaces and COMPILES the native modules
# (node-pty, better-sqlite3) for this machine's OS/arch + Node ABI.
npm ci

cd vscode-extension
npm install               # extension toolchain (vsce) — not pinned in its lockfile
# `vsce package` runs vscode:prepublish (tsc + scripts/bundle.mjs → assembles server/)
npx @vscode/vsce package --target <TARGET>
```

This produces:
```
pinodes-orchestra-vscode-<TARGET>-<VERSION>.vsix
```

### Example Outputs
```
pinodes-orchestra-vscode-linux-x64-0.2.1.vsix
pinodes-orchestra-vscode-win32-x64-0.2.1.vsix
pinodes-orchestra-vscode-darwin-x64-0.2.1.vsix
pinodes-orchestra-vscode-darwin-arm64-0.2.1.vsix
```

## Verification (per machine)

Before publishing, smoke-test the generated VSIX locally:

```bash
code --install-extension pinodes-orchestra-vscode-<TARGET>-<VERSION>.vsix
# Open VS Code → PiNodes Orchestra panel → Start Backend
# Verify: health endpoint returns 200, frontend loads, no native module errors
```

## Publishing

From **any one machine** (after collecting all four `.vsix` files):

```bash
# Login once (requires PAT with Marketplace:Manage scope)
npx @vscode/vsce login <PUBLISHER_ID>

# Publish each platform
npx @vscode/vsce publish -p <PAT> -i pinodes-orchestra-vscode-linux-x64-<VERSION>.vsix
npx @vscode/vsce publish -p <PAT> -i pinodes-orchestra-vscode-win32-x64-<VERSION>.vsix
npx @vscode/vsce publish -p <PAT> -i pinodes-orchestra-vscode-darwin-x64-<VERSION>.vsix
npx @vscode/vsce publish -p <PAT> -i pinodes-orchestra-vscode-darwin-arm64-<VERSION>.vsix
```

The Marketplace automatically serves the correct VSIX to users based on their platform.

## Open VSX (Cursor, Windsurf, …)

Cursor, Windsurf, and other VS Code forks pull extensions from
[Open VSX](https://open-vsx.org/) instead of (or in addition to) the VS Code
Marketplace. Publish the **same platform-specific VSIX files** there:

```bash
# Login once (requires Open VSX access token)
npx ovsx login

# Publish each platform (same artifacts as Marketplace)
npx ovsx publish pinodes-orchestra-vscode-linux-x64-<VERSION>.vsix
npx ovsx publish pinodes-orchestra-vscode-win32-x64-<VERSION>.vsix
npx ovsx publish pinodes-orchestra-vscode-darwin-x64-<VERSION>.vsix
npx ovsx publish pinodes-orchestra-vscode-darwin-arm64-<VERSION>.vsix
```

Live listing: <https://open-vsx.org/extension/emanubiz/pinodes-orchestra-vscode>

Users install via the Extensions panel — no manual `.vsix` sideload needed unless
they prefer it. VS Code users can install from either registry.

## Automation

A GitHub Actions workflow (`.github/workflows/publish-extension.yml`) automates
the matrix build and publish to **both** the VS Code Marketplace and Open VSX:

- **Push a `v*` tag** (e.g. `v0.2.1`) → builds all four platform VSIX files and
  publishes each to every registry whose token is configured.
- **Manual run** (workflow_dispatch) → builds the VSIX artifacts only (no publish).

Each registry is independent: if only one token is set, the other registry is
skipped with a notice (the job still succeeds).

| Secret | Registry | Scope |
|--------|----------|-------|
| `VSCE_PAT` | VS Code Marketplace | Azure DevOps PAT, `Marketplace: Manage` |
| `OVSX_TOKEN` | Open VSX (Cursor, Windsurf, …) | Open VSX access token for the `emanubiz` namespace |

### Token security (public repo)

The repo is public, so the workflow file is visible and forkable. The tokens are
**not** exposed, because:

1. **Fork PRs never receive secrets.** GitHub withholds repository/environment
   secrets from any workflow triggered by a `pull_request` from a fork. Someone
   who forks the repo and edits the workflow to `echo` the token gets an empty
   value — they cannot exfiltrate it.
2. **Publish only runs on `v*` tags.** Tags can only be pushed by accounts with
   write access (i.e. you). A malicious PR cannot reach the publish job.
3. **Log masking.** GitHub auto-redacts secret values in logs, so an accidental
   `echo $OVSX_TOKEN` prints `***`. (Masking is a safety net, not a boundary —
   it can be defeated by re-encoding; points 1–2 are the real protection.)
4. **`release` environment.** The publish job runs in the `release` environment.
   Store `VSCE_PAT`/`OVSX_TOKEN` as **environment** secrets there (not plain repo
   secrets) and add yourself as a **required reviewer** (repo Settings →
   Environments → `release`) so every publish waits for a manual approval click —
   even a malicious tag push then can't publish without your confirmation.

> **Bottom line:** with the publish gated to tags + the `release` environment,
> nobody editing the pipeline via a PR can read or use your tokens. The only
> account that can publish is one that already has write access to the repo.

To rotate a token, regenerate it at the provider and update the environment
secret — no code change needed.

## Versioning

Update `vscode-extension/package.json` `version` field before each release. The version must match across all four VSIX files.

## Checklist for Release

- [ ] Version bumped in `package.json`
- [ ] Linux x64 VSIX built + verified
- [ ] Windows x64 VSIX built + verified
- [ ] macOS x64 VSIX built + verified
- [ ] macOS arm64 VSIX built + verified
- [ ] All four VSIX files published to VS Code Marketplace
- [ ] All four VSIX files published to Open VSX
- [ ] GitHub Release created with changelog