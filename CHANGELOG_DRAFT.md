# Changelog - v0.2.21 (Draft)

## [0.2.21] - 2026-07-02

### Added
- **Claude Code Runtime Integration**: Support for Claude Code as a first-class node runtime.
  - New `ClaudeRuntime` implementing the interactive PTY bridge.
  - Lifecycle hook bridge via `backend/claude-hooks/orchestra-hook.mjs` for orchestration.
  - Support for `@@HANDOFF` text sentinel protocol in Claude sessions.
  - Explicit toolset control via `runtimeConfig.toolset` (Claude vocabulary).
  - Server-side watchdog (nudge) for non-final Claude nodes.
- **Zero Runtime Analysis**: Added documentation plan for a lightweight "zero-runtime" node.
- **Documentation**: New [Claude Code Runtime Guide](docs/guides/CLAUDE_RUNTIME.md).

### Changed
- **Multi-runtime UI**: Updated `RuntimeSelector` and `AddAgentModal` to support the new Claude runtime.
- **Architecture**: Updated diagrams and protocol tables to include Claude Code.
- **CI/CD**: Improved VSIX publishing workflow to be idempotent and resilient across platforms.
- **Testing**: Comprehensive test suite for `ClaudeRuntime` and its availability detection.

### Fixed
- Improved PTY cleanup and state management in `PtyHub`.
- Fixed potential stall in submit-watch for slow TUI runtimes.
- Refined programmatic API documentation.
