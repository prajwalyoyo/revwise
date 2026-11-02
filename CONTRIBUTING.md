# Contributing to Revwise

Thank you for your interest in contributing to Revwise! We welcome bug reports, documentation improvements, feature ideas, and code contributions.

Revwise is built on a simple foundation: **fast, private, zero-account, zero-telemetry Git tooling directly inside VS Code**. Every contribution must respect these architectural invariants.

---

## The Revwise Promise

Before submitting code, please note that Revwise has strict commitments enforced by automated unit tests in `test/promise.test.js`:

1. **Zero Runtime Dependencies**: No runtime `npm` dependencies. Revwise uses plain modern JavaScript and Node.js built-ins.
2. **Zero Telemetry & Tracking**: No analytics, tracking pixels, or "phone-home" pings.
3. **No External Network Calls**: Shipped code does not invoke `fetch`, `http`, `net`, `WebSocket`, or browser network APIs. The only network action permitted is the explicit `Open on Remote` command which invokes VS Code's `vscode.env.openExternal` in response to direct user action.
4. **Sandboxed Webviews**: Webviews must maintain strict Content Security Policy (`default-src 'none'`) with zero remote resources.
5. **Safe Rewriting**: History manipulation (reword, squash, drop) must always be journaled so users can undo via the Undo Journal.

---

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18.0.0 or later
- [Git](https://git-scm.com/) v2.31.0 or later on your `PATH`
- [VS Code](https://code.visualstudio.com/) v1.85.0 or later

### Getting Started

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/prajwalyoyo/revwise.git
   cd revwise
   ```

2. Run the unit test suite:
   ```bash
   npm test
   ```

3. Launch in VS Code for development:
   - Open the cloned folder in VS Code (`code .`).
   - Press `F5` to open an Extension Development Host window.
   - Test your changes against any local Git repository in the development window.

4. Package the extension locally (`.vsix`):
   ```bash
   npm run package
   ```

---

## Testing

Revwise uses Node.js's built-in test runner (`node --test`) to run high-speed tests against real temporary Git repositories:

```bash
# Run all unit and invariant tests
npm test

# Run a specific test suite
node --test test/promise.test.js
node --test test/git.test.js
node --test test/features.test.js
node --test test/rewrite.test.js
node --test test/differentiators.test.js

# Run integration tests in VS Code host
node test-int/run.js
```

---

## Pull Request Guidelines

1. **Branch naming**: Use descriptive branch names like `fix/blame-whitespace` or `feat/graph-filter`.
2. **Commit messages**: Use clear, concise commit messages.
3. **Tests**: Add unit tests in `test/` for any new parser, Git operation, or feature.
4. **No Dependencies**: Do not add runtime packages to `dependencies` in `package.json`.
5. **CI Verification**: Ensure all tests pass across Ubuntu, Windows, and macOS.
