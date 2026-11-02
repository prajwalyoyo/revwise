# Revwise

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/prajwalyoyo/revwise/actions/workflows/ci.yml/badge.svg)](https://github.com/prajwalyoyo/revwise/actions)
[![Zero Telemetry](https://img.shields.io/badge/telemetry-zero-brightgreen.svg)](#privacy--performance-guarantees)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

**Revwise** is a fast, private, and powerful Git toolkit for Visual Studio Code. It brings inline blame, an interactive commit graph, safe history rewriting with one-click undo, changelists, and visual file history directly into your editor—with **no accounts, no cloud dependencies, and zero telemetry**.

---

## Highlights

- **⚡ Blame While You Code**: Instant, move-aware inline blame, hover cards with commit details, gutter heatmaps, and CodeLens change summaries.
- **🌳 Interactive Commit Graph**: Smooth, virtualized commit graph with curved branch and merge lanes, fast filtering, search, and full keyboard navigation.
- **↺ History Rewriting with 1-Click Undo**: Reword older commits, squash non-adjacent changes, fixup, drop, or run interactive rebases. Every operation is journaled and reversible with one click.
- **📋 Changelists**: Group uncommitted modifications into independent, named changelists. Commit, stash, or create patches from specific groups without touching the rest of your working tree.
- **📊 Visual File History**: Interactive timeline mapping file evolution across authors, showing addition/deletion volume and direct diff navigation.
- **📦 Local Patches & Branch Cleanup**: Create and apply standard `.patch` files locally, and safely prune stale or merged branches.
- **🔒 Privacy by Default**: Plain JavaScript running local `git` commands directly. No network calls, no analytics, no external servers.

---

## Key Features

### 1. Inline Blame & File Annotations
- **Current-Line Blame**: Shows author, relative timestamp, and commit summary unobtrusively at the cursor.
- **Rich Hover**: Displays author details, date, full commit message, and one-click actions (*Show Commit*, *Diff with Previous*, *Copy SHA*).
- **Move-Aware Blame (`-M`)**: Automatically tracks code moved within a file or across files so original authorship is preserved.
- **`.git-blame-ignore-revs` Support**: Skips mass-formatting or lint commits automatically.
- **File Annotations**:
  - **File Blame (`Ctrl+Alt+B`)**: Gutter annotations showing commit hash, author, and age.
  - **Heatmap**: Color-coded margin reflecting line age (hot for recent edits, cold for older code).
  - **Changes**: Visual indicators for additions, modifications, and deletions.

### 2. Commit Graph (`Ctrl+Alt+G`)
- Available in the Revwise sidebar and as a full editor panel.
- Virtualized rendering capable of handling repositories with hundreds of thousands of commits smoothly.
- Real-time search by commit message, author name/email, hash, or Git ref.
- Context menu actions on any commit: checkout, create branch/tag, cherry-pick, revert, compare with HEAD or working tree, and open in remote forge (GitHub, GitLab, Bitbucket, Azure DevOps).

### 3. Safe History Rewriting & Undo Journal
Modify your local commit history cleanly before pushing:
- **Reword**: Change the subject line of any commit on the branch while preserving the message body.
- **Squash & Fixup**: Combine multiple commits (adjacent or non-adjacent) in a single action.
- **Drop**: Delete unnecessary commits and automatically replay subsequent history.
- **Interactive Rebase**: Launch a clear rebase plan editor to reorder, squash, edit, or drop commits visually.
- **The Undo Journal (`Ctrl+Alt+Z`)**: Every rewrite, checkout, cherry-pick, branch deletion, or patch application is recorded in the **Revwise Operations** journal. Undo any step with a single click using safe `git reset --keep` mechanics.

### 4. Changelists
Organize work-in-progress without relying solely on the Git staging index:
- Group files into logical work buckets (e.g., *Refactoring*, *Bugfix*, *Docs*).
- Move files between changelists via drag-and-drop or context menu.
- Commit or stash an entire changelist independently without including other unstaged files.

### 5. Visual File History
- Interactive multi-lane timeline showing all commits that touched the active file over time.
- Bubble size represents change volume (additions and deletions).
- Filter by timeframe (1 Month, 3 Months, 1 Year, All) or click authors in the legend to toggle their contributions.
- Click any commit node to inspect changes side-by-side.

---

## Keyboard Shortcuts

| Shortcut (Windows / Linux) | Shortcut (macOS) | Action |
| :--- | :--- | :--- |
| `Ctrl+Alt+G` | `Cmd+Alt+G` | Open Commit Graph |
| `Ctrl+Alt+B` | `Cmd+Alt+B` | Toggle File Blame Annotations |
| `Ctrl+Alt+Z` | `Cmd+Alt+Z` | Undo Last Revwise Git Action |
| `Alt+,` | `Option+,` | Step to Previous File Revision Diff |
| `Alt+.` | `Option+.` | Step to Next File Revision Diff |

---

## Privacy & Performance Guarantees

Revwise is built under strict architectural commitments verified by automated tests in `test/promise.test.js`:

1. **No Account Required**: Full functionality is available immediately upon installation.
2. **Zero Telemetry**: No tracking, usage analytics, or remote logging.
3. **Zero Network Calls**: All Git operations run locally using your machine's `git` binary. The only outbound trigger is opening a remote URL in your browser upon explicit user request.
4. **Sandboxed Webviews**: Webviews enforce a strict Content Security Policy (`default-src 'none'`) and cannot load external scripts or resources.
5. **Zero Runtime Dependencies**: Authored in pure modern JavaScript with zero third-party `npm` runtime packages.
6. **Non-Blocking Git Execution**: Invokes Git with `GIT_OPTIONAL_LOCKS=0` to prevent `index.lock` contention with your terminal commands.

---

## Configuration

Customise Revwise via VS Code Settings (`Ctrl+,` or `Cmd+,` searching for `revwise`):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `revwise.currentLine.enabled` | `true` | Show inline blame at cursor line |
| `revwise.currentLine.format` | `${author}, ${ago} • ${summary}` | Custom token format for inline blame |
| `revwise.statusBar.enabled` | `true` | Show current-line blame in status bar |
| `revwise.codeLens.enabled` | `true` | Show author and recent commit CodeLens headers |
| `revwise.blame.detectMoves` | `"file"` | Detect code movement (`off`, `file` for `-M`, `files` for `-C`) |
| `revwise.blame.ignoreWhitespace` | `false` | Ignore whitespace changes when running blame |
| `revwise.blame.ignoreRevsFile` | `".git-blame-ignore-revs"` | Path to commit ignore list for blame |
| `revwise.heatmap.ageThreshold` | `90` | Days until a change reaches the "cold" heatmap color |
| `revwise.branchCleanup.staleDays` | `90` | Threshold in days to consider inactive branches stale |
| `revwise.branchCleanup.protected` | `["main","master","develop",...]` | Branches protected from bulk cleanup |

---

## Development & Testing

```bash
# Run unit tests across all parsers, Git workflows, and security invariants
npm test

# Run tests in an isolated VS Code extension host
node test-int/run.js

# Build local .vsix package
npm run package
```

**Requirements:** [Node.js](https://nodejs.org/) v18+ and [Git](https://git-scm.com/) v2.31+ on your `PATH`.

---

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request. To report security vulnerabilities, see [SECURITY.md](SECURITY.md).

---

## License & Trademarks

- **License**: Released under the [MIT License](LICENSE).
- **Trademarks**: Git and the Git logo are trademarks of the Software Freedom Conservancy. Revwise is an independent open-source project and is not affiliated with or endorsed by the Git Project.
