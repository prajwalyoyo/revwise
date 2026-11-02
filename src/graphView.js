'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const git = require('./git');
const { GraphLayout } = require('./graphLayout');

const PAGE_SIZE = 300;

/**
 * Commit Graph, rendered in a webview. The same host logic drives both the sidebar view
 * (`revwise.graph`) and the editor panel (`revwise.showGraph`).
 * Commits are paged (`git log --date-order`), laid out incrementally in the extension host,
 * and the webview virtualizes rows so only the visible slice is in the DOM.
 */
class GraphController {
	constructor(context, repos) {
		this.context = context;
		this.repos = repos;
		this.hosts = new Set();
		this.panel = undefined;
		this.disposables = [
			vscode.window.registerWebviewViewProvider('revwise.graph', this, { webviewOptions: { retainContextWhenHidden: false } }),
			vscode.commands.registerCommand('revwise.showGraph', () => this.showPanel()),
			repos.onDidChangeRepo(root => {
				for (const h of this.hosts) if (!root || h.root === root) this._reloadWhenVisible(h);
			}),
			repos.onDidChangeActive(root => {
				for (const h of this.hosts) {
					if (h.root !== root) {
						h.root = root;
						this._reloadWhenVisible(h);
					}
				}
			}),
		];
	}

	dispose() {
		this.panel?.dispose();
		for (const d of this.disposables) d.dispose();
	}

	resolveWebviewView(view) {
		this._attach(view.webview, view, 'view');
	}

	showPanel() {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		this.panel = vscode.window.createWebviewPanel(
			'revwise.graphPanel',
			'Commit Graph',
			{ viewColumn: vscode.ViewColumn.Active },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this._media()] },
		);
		this.panel.iconPath = {
			light: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'revwise-light.svg'),
			dark: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'revwise-dark.svg'),
		};
		this._attach(this.panel.webview, this.panel, 'panel');
		this.panel.onDidDispose(() => (this.panel = undefined));
	}

	_media() {
		return vscode.Uri.joinPath(this.context.extensionUri, 'media');
	}

	_attach(webview, owner, kind) {
		webview.options = { enableScripts: true, localResourceRoots: [this._media()] };
		const host = { webview, owner, kind, root: this.repos.active, scope: 'all', stale: false, gen: 0 };
		this.hosts.add(host);
		webview.html = this._html(webview, kind);
		const onVisibility = owner.onDidChangeVisibility ?? owner.onDidChangeViewState;
		const subs = [
			webview.onDidReceiveMessage(m => this._onMessage(host, m)),
			onVisibility.call(owner, () => {
				if (owner.visible && host.stale) this._load(host, true);
			}),
		];
		owner.onDidDispose(() => {
			this.hosts.delete(host);
			host.abort?.abort();
			for (const s of subs) s.dispose();
		});
	}

	_reloadWhenVisible(host) {
		if (host.owner.visible) this._load(host, true);
		else host.stale = true;
	}

	async _onMessage(host, m) {
		switch (m.type) {
			case 'ready':
				if (!host.root) host.root = await this.repos.pick();
				return this._load(host, true);
			case 'more':
				return this._load(host, false);
			case 'refresh':
				return this._load(host, true);
			case 'scope':
				if (m.value === 'all' || m.value === 'current') host.scope = m.value;
				else if (typeof m.value === 'string' && m.value.startsWith('branch:')) {
					const name = m.value.slice(7);
					// Only accept names git actually reported, so arbitrary input never reaches the git CLI.
					host.scope = host.branches?.some(b => b.name === name) ? name : 'all';
				} else host.scope = 'all';
				return this._load(host, true);
			case 'action':
				return this._action(host, m);
		}
	}

	async _load(host, reset) {
		if (!host.root) {
			host.webview.postMessage({ type: 'empty', message: 'No git repository found.' });
			return;
		}
		if (!reset && (host.loading || host.done)) return;
		if (reset) {
			host.abort?.abort();
			host.gen++;
			host.layout = new GraphLayout();
			host.skip = 0;
			host.done = false;
			host.stale = false;
		}
		const gen = host.gen;
		host.loading = true;
		host.abort = new AbortController();
		try {
			if (reset) {
				host.branches = await git.branches(host.root).catch(() => []);
				if (gen !== host.gen) return;
				if (host.scope !== 'all' && host.scope !== 'current' && !host.branches.some(b => b.name === host.scope))
					host.scope = 'all';
			}
			const [commits, head] = await Promise.all([
				git.graphLog(host.root, { skip: host.skip, limit: PAGE_SIZE, scope: host.scope, signal: host.abort.signal }),
				reset ? git.revParse(host.root, 'HEAD').catch(() => undefined) : Promise.resolve(host.head),
			]);
			if (gen !== host.gen) return;
			host.head = head;
			host.skip += commits.length;
			host.done = commits.length < PAGE_SIZE;
			const rows = commits.map(c => ({
				sha: c.sha,
				parents: c.parents,
				author: c.author,
				email: c.email,
				date: c.date.getTime(),
				summary: c.summary,
				refs: c.refs,
				g: host.layout.add(c),
			}));
			host.webview.postMessage({
				type: 'rows',
				reset,
				rows,
				done: host.done,
				head,
				maxWidth: host.layout.maxWidth,
				repo: require('path').basename(host.root),
				scope: host.scope === 'all' || host.scope === 'current' ? host.scope : `branch:${host.scope}`,
				branches: reset ? host.branches.map(b => ({ name: b.name, remote: b.remote, current: b.current })) : undefined,
			});
		} catch (e) {
			if (e?.name === 'AbortError' || gen !== host.gen) return;
			host.webview.postMessage({ type: 'error', message: String(e.stderr || e.message || e) });
		} finally {
			if (gen === host.gen) host.loading = false;
		}
	}

	async _action(host, m) {
		const arg = { root: host.root, sha: m.sha, shas: m.shas || [m.sha], summary: m.summary, refName: m.ref };
		const map = {
			showCommit: 'revwise.showCommitDetails',
			copySha: 'revwise.copyCommitSha',
			copyMessage: 'revwise.copyCommitMessage',
			checkout: 'revwise.checkout',
			createBranch: 'revwise.createBranch',
			createTag: 'revwise.createTag',
			compareWithHead: 'revwise.compareWithHead',
			compareWithWorking: 'revwise.compareWithWorkingTree',
			openOnRemote: 'revwise.openCommitOnRemote',
			cherryPick: 'revwise.cherryPick',
			revert: 'revwise.revertCommit',
			reword: 'revwise.rewordCommit',
			squash: 'revwise.squashCommits',
			fixup: 'revwise.fixupCommits',
			drop: 'revwise.dropCommits',
			editPlan: 'revwise.rebase.editPlan',
			combined: 'revwise.showCombinedChanges',
			createPatch: 'revwise.createPatchFromCommits',
		};
		const command = map[m.action];
		if (command) await vscode.commands.executeCommand(command, arg);
	}

	_html(webview, kind) {
		const nonce = crypto.randomBytes(16).toString('base64');
		const media = this._media();
		const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.css'));
		const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.js'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Commit Graph</title>
</head>
<body class="${kind}">
<div class="toolbar">
	<select id="scope" title="Branches to show">
		<option value="all">All branches</option>
		<option value="current">Current branch</option>
	</select>
	<input id="search" type="search" placeholder="Search message, author, SHA, ref…" spellcheck="false">
	<span id="matches" class="muted"></span>
	<button id="prev" title="Previous match (Shift+Enter)">&#x2191;</button>
	<button id="next" title="Next match (Enter)">&#x2193;</button>
	<span class="spacer"></span>
	<span id="status" class="muted"></span>
	<button id="refresh" title="Refresh">&#x21bb;</button>
</div>
<div class="header">
	<div class="c-graph">Graph</div><div class="c-msg">Commit Message</div><div class="c-author">Author</div><div class="c-date">Date</div><div class="c-sha">SHA</div>
</div>
<div id="viewport" tabindex="0"><div id="spacer"></div><div id="rows"></div></div>
<div id="menu" class="menu hidden"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}
}

module.exports = { GraphController };
