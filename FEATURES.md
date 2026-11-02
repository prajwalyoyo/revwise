# Revwise: complete feature guide

Revwise is a fast, private toolkit for Git™ in VS Code. This guide covers every feature: where to find it, how to use it, and what it's good for.

**Version:** 0.3.0 · **Requires:** VS Code 1.85+ and `git` 2.31+ on your PATH

---

## Contents

1. [Getting started](#1-getting-started)
2. [Where to find things](#2-where-to-find-things)
3. [Blame while you code](#3-blame-while-you-code)
4. [File annotations: blame, heatmap, changes](#4-file-annotations-blame-heatmap-changes)
5. [Commit Graph](#5-commit-graph)
6. [Sidebar views](#6-sidebar-views)
7. [File and line history](#7-file-and-line-history)
8. [Visual File History](#8-visual-file-history)
9. [Revision navigation](#9-revision-navigation)
10. [Search & Compare](#10-search--compare)
11. [Branches, tags, remotes and worktrees](#11-branches-tags-remotes-and-worktrees)
12. [Stashes](#12-stashes)
13. [Changelists](#13-changelists)
14. [Rewriting history](#14-rewriting-history)
15. [Working with several commits at once](#15-working-with-several-commits-at-once)
16. [Local patches](#16-local-patches)
17. [Undo & Reflog](#17-undo--reflog)
18. [Branch cleanup](#18-branch-cleanup)
19. [Open on remote](#19-open-on-remote)
20. [Multiple repositories](#20-multiple-repositories)
21. [Privacy and safety](#21-privacy-and-safety)
22. [Performance](#22-performance)
23. [Keyboard shortcuts](#23-keyboard-shortcuts)
24. [Settings](#24-settings)
25. [Theme colors](#25-theme-colors)
26. [Command reference](#26-command-reference)
27. [Common tasks: quick recipes](#27-common-tasks-quick-recipes)
28. [Troubleshooting](#28-troubleshooting)

---

## 1. Getting started

**Install** from a VSIX:

```powershell
code --install-extension revwise-0.3.0.vsix
```

Then reload the window. Revwise starts after VS Code finishes loading, so it never slows startup.

**First steps:**
1. Open a folder that's a git repository.
2. Click the **Revwise** icon in the Activity Bar (an **R** drawn as a branch graph).
3. Open any file in the repository and move the cursor: blame appears at the end of the line.
4. Press `Ctrl+Alt+G` (`Cmd+Alt+G` on macOS) to open the Commit Graph.

**Requirements and limits:**
- `git` 2.31 or later must be on your PATH.
- Revwise is disabled in [untrusted workspaces](https://code.visualstudio.com/docs/editor/workspace-trust) because it runs git in the workspace, and it doesn't support virtual workspaces.
- No account, sign-in or internet connection is needed for anything.

---

## 2. Where to find things

| Place | What's there |
|---|---|
| **Activity Bar → Revwise** | The Commit Graph and 13 other views (see [Sidebar views](#6-sidebar-views)) |
| **End of the current line** | Inline blame; hover it for details and actions |
| **Status bar** (right) | Blame for the current line; click to show the commit |
| **Status bar** (left, only when needed) | ⚠ *"Rebase in progress"* when a rebase, cherry-pick or patch is paused |
| **Top of each file** | CodeLens: the latest change and the number of authors |
| **Editor title bar** (top right of an editor) | ← → revision navigation · **Revwise Annotations** menu (or ✕ to clear) · ▶ Start Rebase · Apply Patch |
| **Editor right-click → Revwise** | Show commit, diff with previous, copy SHA, open on remote, file history, open revision, reword, visual history, move to changelist |
| **Explorer right-click** | Open File on Remote · Move to Changelist · Apply Patch (on `.patch`/`.diff` files) · Show Visual File History |
| **Command Palette** (`Ctrl+Shift+P`) | Type **Revwise** to see every command |

---

## 3. Blame while you code

### Current-line blame
As you move the cursor, Revwise shows who last changed the line, when, and why:

```
const base = Math.min(opts.baseMs, 250);      Priya Rao, 3 months ago • Cap backoff base
```

- The text is dimmed so it doesn't compete with your code.
- **Unsaved edits are handled correctly.** Revwise blames the editor's current contents, not the saved file, so blame stays aligned with what you see. Lines you've added or changed show **"You, Uncommitted changes"**.
- Turn it on or off with **Revwise: Toggle Current Line Blame**, or the `revwise.currentLine.enabled` setting.
- Customise the text with `revwise.currentLine.format` (see [format tokens](#format-tokens)).

### Blame hover
Hover the blame text at the end of the line to see:
- the author, email, relative and exact date
- the commit message
- the commit's **git notes**, if any
- action links: **Show Commit**, **Diff with Previous**, **Copy SHA** and **Reword**

For uncommitted lines the hover offers **Compare with HEAD** instead.

By default the hover only appears over the blame text, so it doesn't get in the way of other hovers in your code. Set `revwise.hovers.over` to `line` to show it anywhere on the line.

### Status bar
Shows `author, time ago` for the current line. Click it to open the commit. The tooltip has the same details as the hover.

### CodeLens
At the top of every tracked file:
- **🕑 Bob, 2 days ago**: the most recent commit that touched the file. Click to show it.
- **👤 3 authors (Alice and others)**: how many people wrote the current lines. Click to toggle file blame.

### Better blame accuracy
Plain `git blame` credits whoever last touched a line, which is often a refactor or reformat. Revwise fixes the common cases:

| Feature | What it does | Setting |
|---|---|---|
| **Move-aware blame** (on by default) | Code moved within a file stays credited to its original author (`git blame -M`) | `revwise.blame.detectMoves`: `off`, `file` (default) or `files` (also follows code copied from other files, `-C`; slower) |
| **Ignore formatting commits** | Commits listed in `.git-blame-ignore-revs` are skipped automatically when that file exists, so mass reformatting doesn't hide the real author | `revwise.blame.ignoreRevsFile` |
| **Ignore whitespace** | Whitespace-only changes don't count (`-w`) | `revwise.blame.ignoreWhitespace` |
| **Git notes** | Notes attached to a commit appear in its blame hover | — |

Show your own commits as **"You"** by setting `revwise.youEmail` to your git email.

---

## 4. File annotations: blame, heatmap, changes

Open a file, then click **Revwise Annotations** in the editor title bar (or use the Command Palette). One annotation mode is active per file at a time; choosing another replaces it. While one is on, the button becomes **✕ Clear File Annotations**.

| Mode | Command | Shortcut | What you see | Use it to |
|---|---|---|---|---|
| **File Blame** | Toggle File Blame | `Ctrl+Alt+B` | A gutter with aligned `age author summary` columns at the start of each block of lines from the same commit, an age-colored bar (warm = recent, cool = old), a faint line between blocks, and a commit hover. The end-of-line blame hides while it is on | See who wrote every part of the file |
| **Heatmap** | Toggle File Heatmap | — | A coloured bar on each line's left edge: **orange** = changed within the last 90 days (brighter = newer), **blue** = older (brighter = closer to the cutoff). Recent changes are also marked in the scrollbar | Spot active, recently churned code at a glance |
| **Changes** | Toggle File Changes | — | Green (added), blue (modified) and red (deleted) markers. Shows your **uncommitted** changes; if the file is clean, shows what its **last commit** changed | Review what you're about to commit, or what the last commit did |

Change the heatmap cutoff with `revwise.heatmap.ageThreshold` (days). File blame and the heatmap update as you edit.

---

## 5. Commit Graph

Open it with `Ctrl+Alt+G`, **Revwise: Show Commit Graph**, or the **Commit Graph** view at the top of the Revwise sidebar. It works in both places: a compact version in the sidebar, and a full editor tab.

**What it shows:**
- Every commit on all local branches, remote branches and tags (stashes are excluded), newest first.
- Coloured lanes with curved merge and branch lines.
- **Badges** for branches (✓ marks the checked-out branch), remote branches (☁) and tags (◆).
- HEAD drawn as a hollow ring, merge commits as small hollow circles.
- The message, author, relative date and short SHA of each commit. In narrow views some columns hide automatically.

**Toolbar:**
- **All branches / Current branch**: show everything, or only the history of HEAD.
- **Search box**: matches the message, author, email, SHA prefix or branch/tag names. Matches are highlighted and other rows dim. Use `Enter` / `Shift+Enter` or ↓ ↑ to jump between matches.
- **Commit counter** and **↻ Refresh**.

**Using it:**

| Action | How |
|---|---|
| Select a commit | Click, or use `↑` `↓` `PgUp` `PgDn` `Home` |
| Open a commit | Double-click or `Enter` |
| Select several commits | `Ctrl`/`Cmd`+click to add or remove one; `Shift`+click to select a range |
| Act on commits | Right-click (see below) |
| Close a menu | `Esc` |

**Right-click, one commit:**
- Show Commit · Compare with HEAD · Compare with Working Tree
- Copy SHA · Copy Message · Open Commit on Remote · Create Patch
- Checkout (the branch you right-clicked on, or the commit itself) · Create Branch Here · Create Tag Here · Cherry Pick · Revert
- Reword · Drop Commit · Interactive Rebase from Here

**Right-click, several commits:**
- Show Combined Changes · Create Patch from N Commits
- Cherry Pick N Commits · Squash N Commits · Fixup into Oldest · Drop N Commits
- Copy SHA

The graph loads 300 commits at a time as you scroll, and only draws the rows on screen, so it stays fast on very large repositories. It refreshes automatically after commits, checkouts, fetches and other repository changes.

---

## 6. Sidebar views

The Revwise sidebar contains these views. Collapse, expand, reorder or hide them like any VS Code view.

| View | Shows | Open by default |
|---|---|---|
| **Commit Graph** | The graph ([section 5](#5-commit-graph)) | ✓ |
| **Commits** | History of the current branch | ✓ |
| **Changelists** | Your uncommitted changes, grouped ([section 13](#13-changelists)) | ✓ |
| **File History** | History of the file in the active editor ([section 7](#7-file-and-line-history)) | ✓ |
| **Visual File History** | Timeline chart of the active file ([section 8](#8-visual-file-history)) | collapsed |
| **Line History** | History of the selected lines ([section 7](#7-file-and-line-history)) | collapsed |
| **Branches** | Local branches ([section 11](#11-branches-tags-remotes-and-worktrees)) | ✓ |
| **Remotes** | Remotes and their branches | collapsed |
| **Stashes** | Saved stashes ([section 12](#12-stashes)) | collapsed |
| **Tags** | Tags, newest first | collapsed |
| **Worktrees** | Linked working trees | collapsed |
| **Contributors** | Who committed how much | collapsed |
| **Search & Compare** | Saved searches and comparisons ([section 10](#10-search--compare)) | collapsed |
| **Undo & Reflog** | Undoable operations and the HEAD reflog ([section 17](#17-undo--reflog)) | collapsed |

**Common behaviour:**
- **Expand a commit** to see the files it changed (added, modified, deleted or renamed). **Click a file** to see its diff for that commit.
- Right-click a file for **Open Changes**, **Open File** or **Open File at Revision**.
- Long lists show **Load more…** at the bottom (50 commits at a time).
- Hover a commit for its full details.
- Most views support **multi-select** with `Ctrl`/`Cmd`+click and `Shift`+click.
- Views refresh automatically after repository changes. The tree views also have a ↻ Refresh button.

**Contributors** counts non-merge commits reachable from HEAD and shows each person's share. Expand a contributor to see their commits.

---

## 7. File and line history

| Tool | How to open | What it shows |
|---|---|---|
| **File History view** | Sidebar; follows the active editor | Every commit that touched the file, following renames. Click one to see the file's diff for that commit |
| **Quick File History** | Command Palette, or editor right-click → Revwise | The same list in a searchable quick pick; pick a commit to open its diff |
| **Line History view** | Sidebar; select lines in an editor | Every commit that changed the selected lines (`git log -L`), following them as surrounding code changes |

**Line History notes:**
- It updates as your selection changes. With nothing selected it follows the current line.
- Unsaved edits aren't included; the view warns you when the file has unsaved changes.

---

## 8. Visual File History

A timeline chart of the active file's history, following renames. Open the **Visual File History** sidebar view, or run **Revwise: Show Visual File History** (also in the editor and Explorer right-click menus) for a larger editor-tab version.

**How to read it:**
- **One lane per author.** Each **bubble** is a commit; bigger bubbles changed more lines.
- **Bars** underneath: green above the line for additions, red below for deletions.
- A summary line: number of commits and authors, total `+added −removed`, and the date range.
- A legend with each author's commits, share and lines changed.

**Interacting:**
- Hover a bubble for the commit message, author, date and line counts.
- **Click** a bubble to open that commit's diff for the file; **Alt+click** to open the whole commit.
- Filter by time: **1M**, **3M**, **1Y** or **All**.
- Click an author in the legend to hide or show their commits.

**Use it to** find who knows a file best, when it was most active, and which commits made the biggest changes.

---

## 9. Revision navigation

Step through a file's history as a series of diffs, each showing one commit's change to the file:

| Action | Shortcut | Button |
|---|---|---|
| **Open Changes with Previous Revision** | `Alt+,` | ← in the editor title |
| **Open Changes with Next Revision** | `Alt+.` | → in the editor title (in a revision view) |
| **Open Working File** | — | Go to File icon (in a revision view) |
| **Open File at Revision…** | — | Command Palette, or editor right-click → Revwise |

From the working file, the first `Alt+,` shows your uncommitted changes. If there are none, it starts at the file's last commit. Each further press steps one commit back; `Alt+.` steps forward. *Open File at Revision* lets you pick any past version and view it read-only.

---

## 10. Search & Compare

Results appear in the **Search & Compare** view and stay there until you dismiss them (✕) or **Clear Results**.

### Search commits
Run **Revwise: Search Commits…** (also the 🔍 button on the Commits and Search & Compare views), choose a mode, and type your search:

| Mode | Finds commits… |
|---|---|
| **Message** | whose message contains the text (case-insensitive) |
| **Author** | by an author whose name or email matches |
| **Commit SHA** | with that SHA or SHA prefix |
| **File name** | that touched a file whose path contains the text |
| **Changes** | whose diff adds or removes lines matching the text (a regular expression, `git log -G`) |

Searches cover all branches and tags, and are limited to `revwise.history.limit` results.

### Compare
| Command | Compares |
|---|---|
| **Compare with HEAD** | A commit, branch or tag with the checked-out commit |
| **Compare with Working Tree** | A commit, branch or tag with your current files |
| **Compare References…** | Any two refs you pick, or one ref with the working tree |

Each comparison shows:
- **Commits in B not in A** and **Commits in A not in B**, collapsed by default.
- **Files changed**: click any file to see its diff. Comparisons between two refs show what changed since they diverged (from their merge base).

**Use it to** review a branch before merging, check what a release contains, or see what's different from `main`.

---

## 11. Branches, tags, remotes and worktrees

### Branches view
Local branches, with the checked-out branch first. Each shows ahead/behind counts (`2↑ 1↓`), its upstream (or *(gone)* if the upstream was deleted), and when it last changed. Expand a branch to see its commits.

| Action | Where |
|---|---|
| **Checkout** | ✓ inline button, or right-click |
| **Create Branch…** | Toolbar or right-click; choose *Create and Switch* or *Create Only* |
| **Delete Branch…** | Right-click. Asks first; if the branch isn't fully merged, asks again before force-deleting. **Undoable.** |
| **Compare with HEAD / Working Tree** | Right-click |
| **Compare References…** | Toolbar |
| **Open Branch on Remote** | Right-click |
| **Fetch** | Toolbar (fetches all remotes and prunes deleted branches) |
| **Clean Up Branches…** | Toolbar ([section 18](#18-branch-cleanup)) |

**Checking out a remote branch** switches to its local branch if one exists, or creates a local branch that tracks it. **Checking out a commit** asks first, because it leaves you on a detached HEAD. Checkouts are **undoable** (switch back to where you were).

### Tags view
Tags, newest first, showing the commit and date. Expand a tag to see its history. Right-click to **Checkout**, **Compare**, **Create Branch**, **Copy SHA** or **Delete** (undoable). **Create Tag…** (from a commit) offers an annotated tag if you enter a message, or a lightweight tag if you leave it empty.

### Remotes view
Each remote with its URL. Expand one to see its branches.
- **Fetch** a remote (inline button).
- **Open Repository on Remote** in your browser.

### Worktrees view
Linked working trees with their branch and path; ✓ marks the one you're in.

| Action | Notes |
|---|---|
| **Open Worktree in New Window** | Inline button |
| **Reveal Worktree in File Explorer** | Right-click |
| **Create Worktree…** | Toolbar. Pick a ref, optionally a new branch name, and a parent folder; the worktree is created as `<repo>-<branch>` |
| **Remove Worktree…** | Right-click; asks first. You can't remove the one you're in |

---

## 12. Stashes

| Action | Where | Notes |
|---|---|---|
| **Stash All Changes…** | Stashes view toolbar | Includes untracked files; the message is optional |
| **Apply Stash** | Inline ✓ or right-click | Keeps the stash |
| **Pop Stash** | Right-click | Applies and removes it |
| **Drop Stash…** | Right-click | Asks first. **Undoable** from Undo & Reflog |
| View files | Expand a stash | Click a file to see its diff |

Each stash shows its message, which branch it was made on, and when. To stash just part of your work, use [Changelists](#13-changelists) → **Stash Changelist**.

---

## 13. Changelists

Changelists let you group uncommitted files by task, the way JetBrains IDEs do. They work independently of git's staging area. Use them when you're juggling several changes at once: a bug fix, a refactor and some debug logging you don't want to commit.

**How it works:**
- Every changed file belongs to one changelist. New changes go into the **active** changelist (marked ●). It starts as **Changes**.
- The view shows each list with its file count and a badge with the total number of changed files.
- Click a file to see its diff against HEAD. Untracked files simply open.

| Action | How |
|---|---|
| **Create a changelist** | ＋ on the view toolbar. You're asked whether to make it active |
| **Move files** | Drag and drop between lists (also from the Explorer), or right-click → **Move to Changelist…** (also in the editor and Explorer menus). Several files can be moved at once |
| **Set the active list** | Inline ● button, or right-click |
| **Commit a changelist** | ✓ inline button or right-click. Commits **only that list's files** (new, modified and deleted), leaving everything else, including anything you've staged, untouched. **Undoable**: undo keeps the changes in your working tree |
| **Stash a changelist** | Right-click; stashes only those files, including untracked ones |
| **Create a patch** | Right-click → **Create Patch from Changelist…** |
| **Rename / delete** | Right-click. Deleting moves its files to **Changes**; nothing is lost. The default list can't be deleted |

Changelists are saved per workspace and repository, and survive VS Code restarts. Files that are no longer changed drop out automatically.

---

## 14. Rewriting history

Fix commits after you've made them, without the terminal. Start from the Commit Graph, the Commits view, File History, or the blame hover's **Reword** link.

| Action | What it does |
|---|---|
| **Reword…** | Changes a commit's subject line and keeps the message body. Works on any commit on the current branch; for the latest commit it simply amends |
| **Squash N Commits…** | Combines the selected commits into the oldest one, with a message you enter. They don't need to be next to each other |
| **Fixup into Oldest…** | Like squash, but keeps the oldest commit's message |
| **Drop Commit(s)…** | Removes commits; later commits are replayed without them |
| **Interactive Rebase from Here…** | Opens an editable plan for that commit and everything after it ([below](#interactive-rebase-plan)) |
| **Revert Commit…** | Creates a new commit that undoes a commit's changes, without rewriting history |

**Safety:**
- Uncommitted work is stashed automatically and restored afterwards.
- Every rewrite is recorded in [Undo & Reflog](#17-undo--reflog), so you can undo it in one click.
- Revwise only rewrites **linear history on the current branch**. If the commits involved include merge commits, it refuses rather than flatten them. Commits that aren't on the current branch are also refused.
- Rewriting changes commit SHAs. Avoid rewriting commits you've already pushed and shared, unless your team expects a force-push.

### Interactive rebase plan
**Interactive Rebase from Here…** opens a plan listing the commits oldest first:

```
pick a1b2c3d Add parser
pick d4e5f6a Fix edge case
pick 0718293 WIP
```

Edit it, then click **▶ Start Rebase** in the editor title (or ✕ **Cancel Rebase Plan**):

| Line | Effect |
|---|---|
| `pick <sha>` | Keep the commit |
| `reword <sha> <new subject>` | Keep it and change its subject line (the body is kept) |
| `squash <sha>` | Fold into the commit above, combining messages |
| `fixup <sha>` | Fold into the commit above, keeping that commit's message |
| `drop <sha>` (or delete the line) | Remove the commit |
| `edit <sha>` | Stop at that commit so you can change it |
| *(reorder lines)* | Reorder the commits |

### When a rebase, cherry-pick or patch stops
If a step hits a conflict, or you used `edit`, the operation pauses:
- A ⚠ status bar item naming the paused operation appears (for example **"Rebase in progress"**), and **Continue** / **Abort** buttons appear on Revwise view toolbars.
- Click the status bar item to choose **Continue**, **Skip** or **Abort**.
- To continue: resolve the conflicts (they're listed in the Source Control view), stage the files, then **Continue**.
- **Abort** puts everything back exactly as it was before the operation started.

---

## 15. Working with several commits at once

Select commits with `Ctrl`/`Cmd`+click or `Shift`+click in the **Commit Graph** or the commit views, then right-click:

| Action | Result |
|---|---|
| **Show Combined Changes** | Consecutive commits open as one comparison in Search & Compare; other selections open a single document with all their patches |
| **Cherry Pick N Commits…** | Applies them to the current branch, oldest first. **Undoable** |
| **Squash / Fixup / Drop** | See [Rewriting history](#14-rewriting-history) |
| **Create Patch from N Commits** | One patch file containing all of them, oldest first |

Merge commits can't be cherry-picked by Revwise.

---

## 16. Local patches

Patches are ordinary `.patch` files you can email, attach to a ticket or keep as a backup. No cloud service is involved.

### Create
| From | Command | Format |
|---|---|---|
| One or more commits | **Create Patch from Commit(s)…** (graph or view right-click) | Mailbox format (`git format-patch`): keeps each commit's author, date and message |
| All uncommitted changes | **Create Patch from Working Changes…** (Command Palette or Changelists toolbar) | Plain diff, including new untracked files |
| One changelist | **Create Patch from Changelist…** | Plain diff of only those files |

The patch opens in an editor; then choose **Save As…** or **Copy to Clipboard**.

### Apply
Run **Apply Patch…** from the Command Palette, the Changelists toolbar, the editor title when a `.patch`/`.diff` file is open, or by right-clicking a patch file in the Explorer.

- **Mailbox patches** (from commits): choose **Apply as commits** to recreate the original commits with their authors and messages, or **Apply changes only** to change your files and commit later.
- **Plain diffs**: applied to your working tree. If the patch doesn't apply cleanly, you're offered a **3-way merge**, which applies what it can and marks conflicts for you to resolve.
- Applying is **undoable**. A paused "apply as commits" uses the same Continue / Skip / Abort flow as a rebase.

---

## 17. Undo & Reflog

Revwise records everything it does to your repository, so you can take it back.

**Undo the last operation:** `Ctrl+Alt+Z` (`Cmd+Alt+Z` on macOS), or **Revwise: Undo Last Revwise Operation**. The shortcut works when focus isn't in an editor you're typing in, for example after clicking in the sidebar. Otherwise use the Command Palette.

The **Undo & Reflog** view has two sections:

### Revwise Operations
Up to 30 recent operations per repository, newest first. Hover one to see exactly what undoing it will do, and click ↶ to undo it.

| Operation | Undo does |
|---|---|
| Reword, squash, fixup, drop, interactive rebase | Restores the branch to before the rewrite |
| Cherry-pick, revert, apply patch as commits | Removes the new commits |
| Commit changelist | Removes the commit and keeps its changes in your working tree |
| Delete branch | Recreates it at the same commit |
| Delete tag | Recreates it |
| Drop stash | Restores the stash |
| Apply patch (changes only) | Reverses the patch |
| Checkout | Switches back to where you were |
| Reset Current Branch Here | Moves the branch back |

Undo asks for confirmation first. It refuses rather than overwrite uncommitted changes it would conflict with, and warns you if the branch has moved since the operation. The list is saved with the workspace, so it survives restarts.

### HEAD Reflog
Every commit HEAD has pointed to recently: commits, checkouts, rebases, resets and merges, including ones made outside Revwise. Use it to rescue "lost" work:
- **Create Branch…** on an entry gives a lost commit a name.
- **Reset Current Branch Here…** moves the current branch to that point. Choose **Keep Changes** to keep your current files as uncommitted changes, or **Restore Files** to make the files match that point too. Either way it's undoable.
- Expand an entry to see its files, or right-click to show or copy the commit.

---

## 18. Branch cleanup

Run **Clean Up Branches…** from the Branches view toolbar or the Command Palette.

**It lists local branches that are:**
- **merged** into the current branch or the remote's default branch, or
- **remote deleted** (their upstream branch is gone), or
- **stale**: no commits for `revwise.branchCleanup.staleDays` days (default 90).

**How to use it:**
- Merged and remote-deleted branches are preselected; stale ones aren't. Adjust the selection and confirm.
- Click ☁ first to fetch and prune all remotes, so "remote deleted" is up to date.

**Never listed:** the current branch, branches checked out in any worktree, and protected branches (`revwise.branchCleanup.protected`: `main`, `master`, `develop`, `dev`, `trunk`, `release/*` by default).

Before deleting, you're told which selected branches aren't merged. Every deletion is recorded, so any branch can be brought back from Undo & Reflog.

---

## 19. Open on remote

Open (or copy a link to) your code on your hosting service:

| Command | Where | Opens |
|---|---|---|
| **Open File on Remote** / **Copy Remote File URL** | Editor right-click → Revwise, Explorer right-click, Command Palette | The file, highlighting the lines you've selected |
| **Open Commit on Remote** / **Copy Remote Commit URL** | Commit right-click, graph, Command Palette | The commit page |
| **Open Branch on Remote** | Branch right-click, Command Palette | The branch |
| **Open Repository on Remote** | Remote right-click, Command Palette | The repository home page |

**Supported:** GitHub (including GitHub Enterprise), GitLab, Bitbucket and Azure DevOps, with HTTPS or SSH remote URLs. Other hosts get GitHub-style links, which also work for Gitea and similar.

**How links are built:**
- File links use the branch your local branch tracks, or the current commit if there's no upstream.
- Revwise uses the tracked remote, then `origin`; with several remotes and no obvious choice it asks.

This is the only Revwise feature that leaves your machine: it opens your browser, and only when you ask.

---

## 20. Multiple repositories

- Revwise finds the repository of each workspace folder, plus the repository of any file you open (including repositories nested inside a folder).
- The **active repository** follows the active editor. Views show its name in their title.
- Use **Revwise: Select Repository** (in the view title "…" menu) to switch manually.
- Blame, file history and annotations always use the repository of the file you're looking at.

---

## 21. Privacy and safety

These are commitments, enforced by an automated test that fails the build if any is broken:

- **No account or sign-in.** Every feature works offline on every repository, public or private.
- **No network calls.** The code contains no HTTP, socket or `fetch` usage. *Open on Remote* opens your browser only when you ask.
- **No telemetry**, analytics or "phone home".
- **No pop-ups, upsells or trials.** Nothing is locked.
- **No AI or MCP added behind your back.** Revwise registers no language-model tools, MCP servers or chat participants.
- **Sandboxed webviews.** The Commit Graph and Visual File History can't load remote content.
- **No runtime dependencies.** Revwise is plain JavaScript that runs the `git` you already have.

**Safety rails:**
- Destructive actions (deleting branches or tags, dropping stashes or commits, detached checkouts, history rewrites) **ask for confirmation**.
- They're **journaled and undoable** ([section 17](#17-undo--reflog)).
- Rewrites **auto-stash** your uncommitted work, and undo refuses rather than overwrite it.
- Read-only git commands use `GIT_OPTIONAL_LOCKS=0`, so Revwise never fights your own git commands for `index.lock`.

---

## 22. Performance

- **One `git blame` per file version**, cached. Moving the cursor reads the cache instead of starting a process.
- Cursor handling waits 100 ms (`revwise.currentLine.delay`) and cancels outdated requests.
- Repository changes are detected by watching git's own files, debounced, so views refresh only when something actually changed.
- The Commit Graph loads 300 commits at a time and draws only the visible rows. Tree views load lazily, 50 commits at a time.
- CodeLens doesn't re-run blame on every keystroke while a file has unsaved changes.
- Activation waits until VS Code has finished starting.
- The whole extension is about 125 KB.

---

## 23. Keyboard shortcuts

| Shortcut (Windows/Linux) | macOS | Action | When |
|---|---|---|---|
| `Ctrl+Alt+G` | `Cmd+Alt+G` | Show Commit Graph | Anywhere |
| `Ctrl+Alt+B` | `Cmd+Alt+B` | Toggle File Blame | Editor focused |
| `Alt+,` | `Alt+,` | Open Changes with Previous Revision | Editor focused |
| `Alt+.` | `Alt+.` | Open Changes with Next Revision | In a revision diff |
| `Ctrl+Alt+Z` | `Cmd+Alt+Z` | Undo Last Revwise Operation | Not typing in an editor |

**Inside the Commit Graph:** `↑` `↓` `PgUp` `PgDn` `Home` move · `Enter` opens · `Ctrl`/`Cmd`+click and `Shift`+click multi-select · in the search box `Enter` / `Shift+Enter` jump between matches · `Esc` closes the menu.

Change any shortcut in **File → Preferences → Keyboard Shortcuts** (search "Revwise").

---

## 24. Settings

Open **Settings** and search for **Revwise**, or edit `settings.json`.

| Setting | Default | Description |
|---|---|---|
| `revwise.currentLine.enabled` | `true` | Show blame at the end of the current line |
| `revwise.currentLine.format` | `${author}, ${ago} • ${summary}` | Text of the current-line blame |
| `revwise.currentLine.delay` | `100` | Milliseconds to wait after the cursor moves before showing blame |
| `revwise.statusBar.enabled` | `true` | Show current-line blame in the status bar |
| `revwise.statusBar.format` | `${author}, ${ago}` | Text of the status bar item |
| `revwise.hovers.enabled` | `true` | Show the blame hover |
| `revwise.hovers.over` | `annotation` | `annotation`: only over the blame text · `line`: anywhere on the line |
| `revwise.codeLens.enabled` | `true` | Show the latest-change and authors CodeLens |
| `revwise.fileBlame.format` | `${agoShort\|4} ${author\|14} ${summary}` | Text of the file blame gutter |
| `revwise.heatmap.ageThreshold` | `90` | Days within which a change counts as "hot" in the heatmap |
| `revwise.history.limit` | `200` | Maximum commits in File History, Line History and search results |
| `revwise.youEmail` | *(empty)* | Your git email; your commits show as "You" |
| `revwise.blame.detectMoves` | `file` | `off` · `file` (follow moves within a file) · `files` (also follow code copied from other files; slower) |
| `revwise.blame.ignoreWhitespace` | `false` | Ignore whitespace-only changes in blame |
| `revwise.blame.ignoreRevsFile` | `.git-blame-ignore-revs` | File of commits to skip in blame, relative to the repository root. Used when it exists; empty disables it |
| `revwise.branchCleanup.protected` | `["main","master","develop","dev","trunk","release/*"]` | Branches Clean Up Branches never offers (`*` wildcards allowed) |
| `revwise.branchCleanup.staleDays` | `90` | Days without commits before a branch counts as stale |

### Format tokens
Use these in the `format` settings:

| Token | Example |
|---|---|
| `${author}` | Priya Rao (or "You") |
| `${email}` | priya@corp.dev |
| `${ago}` | 3 months ago |
| `${agoShort}` | 3mo |
| `${date}` | your locale's date and time |
| `${sha}` | a91f3c2 |
| `${summary}` | the commit subject, shortened to 50 characters in the current-line and status bar text |

Add `|N` to any token to pad or truncate it to exactly N characters, so columns line up: `${author|14}`.

Example: `"revwise.currentLine.format": "${sha} · ${author} · ${ago}"`

---

## 25. Theme colors

Override these under `workbench.colorCustomizations`:

| Color ID | Used for |
|---|---|
| `revwise.trailingLineForegroundColor` | Current-line blame text |
| `revwise.gutterForegroundColor` | File blame gutter text |
| `revwise.gutterBackgroundColor` | File blame gutter background |
| `revwise.changesAddedColor` | Changes annotation: added lines |
| `revwise.changesModifiedColor` | Changes annotation: modified lines |
| `revwise.changesDeletedColor` | Changes annotation: deleted-lines marker |

```json
"workbench.colorCustomizations": {
  "revwise.trailingLineForegroundColor": "#8888aa80"
}
```

---

## 26. Command reference

All commands are listed under the **Revwise** category in the Command Palette, except those marked *(menus only)*, which need a selected item.

### Blame and annotations
| Command | Description |
|---|---|
| Toggle Current Line Blame | Turn inline blame on or off |
| Toggle File Blame | Gutter blame for the whole file (`Ctrl+Alt+B`) |
| Toggle File Heatmap | Age heatmap |
| Toggle File Changes | Added/modified/deleted markers |
| Clear File Annotations | Remove the file's annotation |
| Show Commit for Current Line | Open the line's commit |
| Diff Line Commit with Previous | Diff the line's commit for this file |
| Copy Commit SHA for Current Line | Copy the full SHA |
| Refresh | Re-run blame and refresh all views |

### History and navigation
| Command | Description |
|---|---|
| Show Commit Graph | Open the graph in an editor tab (`Ctrl+Alt+G`) |
| Quick File History | Searchable list of the file's commits |
| Show Visual File History | Timeline chart in an editor tab |
| Open Changes with Previous / Next Revision | Step through the file's history (`Alt+,` / `Alt+.`) |
| Open Working File | Go from a revision back to your file |
| Open File at Revision… | View a past version of the file |
| Select Repository | Choose the active repository |

### Commits
| Command | Description |
|---|---|
| Show Commit | Full commit with its diff |
| Copy SHA · Copy Message | Copy to the clipboard |
| Checkout… | Switch to a branch, tag or commit |
| Create Branch… · Create Tag… | At a commit or ref |
| Delete Branch… · Delete Tag… *(menus only)* | Undoable |
| Cherry Pick Commit(s)… | Apply commits to the current branch |
| Revert Commit… | New commit that undoes another |
| Reword Commit… | Change a commit's subject |
| Squash Selected Commits… · Fixup Selected Commits into Oldest… · Drop Commit(s)… | Rewrite history |
| Interactive Rebase from Here… | Editable rebase plan |
| Start Rebase · Cancel Rebase Plan *(editor title)* | Run or discard the plan |
| Resolve Paused Operation… · Continue Rebase/Cherry-Pick · Skip Commit in Rebase/Cherry-Pick · Abort Rebase/Cherry-Pick | Handle a paused rebase, cherry-pick or patch (shown only while one is paused) |
| Show Combined Changes of Selected Commits | One view of several commits |

### Search and compare
| Command | Description |
|---|---|
| Search Commits… | By message, author, SHA, file name or code change |
| Compare with HEAD · Compare with Working Tree · Compare References… | Add a comparison to Search & Compare |
| Clear Results · Dismiss *(menus only)* | Remove results |

### Changelists
| Command | Description |
|---|---|
| New Changelist… | Create a list |
| Set Active Changelist | Where new changes go |
| Move to Changelist… | Move files |
| Commit Changelist… | Commit only that list |
| Stash Changelist | Stash only that list |
| Create Patch from Changelist… | Patch of only that list |
| Rename Changelist… · Delete Changelist… *(menus only)* | Manage lists |

### Patches
| Command | Description |
|---|---|
| Create Patch from Commit(s)… | Mailbox patch keeping authors and messages |
| Create Patch from Working Changes… | Diff of all uncommitted changes |
| Apply Patch… | As commits or as changes; undoable |

### Undo
| Command | Description |
|---|---|
| Undo Last Revwise Operation | `Ctrl+Alt+Z` |
| Undo *(menus only)* | Undo a specific operation |
| Reset Current Branch Here… *(menus only)* | From a reflog entry |

### Branches, stashes, remotes and worktrees
| Command | Description |
|---|---|
| Clean Up Branches… | Delete merged, gone or stale branches |
| Fetch | Fetch all remotes and prune, or one remote |
| Stash All Changes… | Including untracked files |
| Apply Stash · Pop Stash · Drop Stash… *(menus only)* | Manage stashes |
| Create Worktree… | New linked working tree |
| Open Worktree in New Window · Reveal Worktree in File Explorer · Remove Worktree… *(menus only)* | Manage worktrees |

### Remote links
| Command | Description |
|---|---|
| Open File on Remote · Copy Remote File URL | With selected lines |
| Open Commit on Remote · Copy Remote Commit URL | Commit page |
| Open Branch on Remote · Open Repository on Remote | Branch or home page |

---

## 27. Common tasks: quick recipes

| I want to… | Do this |
|---|---|
| Find out why a line exists | Hover its blame → **Show Commit**, or open **Line History** with the line selected |
| See who knows a file best | **Visual File History**, or the authors CodeLens |
| Fix a typo in an old commit message | Hover the blame or right-click the commit → **Reword…** |
| Turn 5 "WIP" commits into one | Select them in the graph → **Squash 5 Commits…** |
| Commit my fix but not my debug logging | Put them in separate **Changelists** → **Commit Changelist** on the fix |
| Undo something I just did in Revwise | `Ctrl+Alt+Z`, or **Undo & Reflog** → ↶ |
| Recover a commit I lost after a reset | **Undo & Reflog** → **HEAD Reflog** → right-click the entry → **Create Branch…** |
| Move commits to another branch | Check out the target, select the commits in the graph → **Cherry Pick** |
| Review a branch before merging | Right-click the branch → **Compare with HEAD** |
| Find when a function or string was introduced | **Search Commits… → Changes**, type the name |
| Share a change without pushing | **Create Patch from Commit(s)…** → Save As |
| Apply a patch a colleague sent | Right-click the `.patch` file → **Apply Patch** |
| Tidy up old branches | **Branches** view → **Clean Up Branches…** |
| Send someone a link to these lines | Select them → right-click → **Revwise → Copy Remote File URL** |
| Stop a reformatting commit hiding the real author | List its SHA in `.git-blame-ignore-revs` at the repository root |
| Get out of a rebase that went wrong | Click ⚠ in the status bar → **Abort** |

---

## 28. Troubleshooting

| Problem | Fix |
|---|---|
| No blame appears | The file must be in a git repository and committed at least once (new untracked files have no history). Check `revwise.currentLine.enabled`. Make sure `git --version` works in a terminal |
| Nothing works at all | Revwise is disabled in untrusted workspaces: choose **Trust** for the folder. Check that `git` 2.31+ is on your PATH |
| The Revwise icon is missing from the Activity Bar | Right-click the Activity Bar and make sure **Revwise** is ticked. Reload the window after installing |
| Blame credits the wrong person after a reformat | Add the reformatting commit to `.git-blame-ignore-revs`. For code moved between files, set `revwise.blame.detectMoves` to `files` |
| A view shows another repository | Run **Revwise: Select Repository**, or focus a file from the repository you want |
| "Only commits reachable from HEAD can be rewritten" | Check out the branch that contains the commit first |
| "…include merge commits" when rewriting | Revwise won't flatten merges. Use the terminal for that history, or rewrite only commits after the merge |
| A rebase or cherry-pick is stuck | Click ⚠ in the status bar: resolve and **Continue**, or **Abort** to restore everything |
| Undo refuses to run | It won't overwrite conflicting uncommitted changes. Commit or stash them, then undo again. Undo also needs the same branch checked out as when the operation ran |
| `Ctrl+Alt+Z` does nothing | It's disabled while you're typing in an editor, so it doesn't clash with editor undo. Click in the sidebar first, or use the Command Palette |
| Line History doesn't include my edits | It shows committed history only; save and commit, or use the Changes annotation for uncommitted edits |
| The patch doesn't apply | Accept the **3-way merge** offer, then resolve any conflict markers |

---

*Git and the Git logo are either registered trademarks or trademarks of Software Freedom Conservancy, Inc., corporate home of the Git Project, in the United States and/or other countries. Revwise is not affiliated with or endorsed by the Git Project.*
