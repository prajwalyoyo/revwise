'use strict';
const vscode = require('vscode');
const git = require('./git');
const { shortSha } = require('./format');

const MAX = 30;

/**
 * Undo journal for operations Revwise performs. Each entry stores just enough to reverse it:
 *   head          { branch, from, to }      → git reset --keep <from>   (rebase, reword, squash, cherry-pick, revert, am, reset)
 *   branchDeleted { name, sha }             → git branch <name> <sha>
 *   tagDeleted    { name, object }          → git update-ref refs/tags/<name> <object>
 *   stashDropped  { sha, message }          → git stash store -m <message> <sha>
 *   checkout      { from, fromSha }         → git switch <from> | git checkout --detach <fromSha>
 *   patchApplied  { patch }                 → git apply -R
 * Entries persist per repository in workspace state.
 */
class Journal {
	constructor(context) {
		this.state = context.workspaceState;
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChange = this._onDidChange.event;
	}

	dispose() {
		this._onDidChange.dispose();
	}

	_key(root) {
		return `revwise.journal:${root.toLowerCase()}`;
	}

	list(root) {
		return (this.state.get(this._key(root)) || []).map(e => ({ ...e, time: new Date(e.time) }));
	}

	async record(root, label, kind, data) {
		const entries = this.state.get(this._key(root)) || [];
		entries.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, time: Date.now(), label, kind, data });
		await this.state.update(this._key(root), entries.slice(0, MAX));
		this._onDidChange.fire(root);
	}

	async _remove(root, id) {
		const entries = (this.state.get(this._key(root)) || []).filter(e => e.id !== id);
		await this.state.update(this._key(root), entries);
		this._onDidChange.fire(root);
	}

	/**
	 * Runs `fn` and journals the HEAD move it causes (if any). Use for every history-rewriting or commit-creating operation.
	 * Also journals on failure when HEAD moved (e.g. a rebase that stopped part-way), so it can be rolled back.
	 * mode 'keep' restores the old tree on undo (rewrites, cherry-picks); 'mixed' keeps the changes in the working tree (new commits).
	 */
	async trackHead(root, label, fn, { mode = 'keep' } = {}) {
		const branch = await git.currentBranch(root);
		const from = await git.revParse(root, 'HEAD').catch(() => undefined);
		const recordIfMoved = async () => {
			const to = await git.revParse(root, 'HEAD').catch(() => undefined);
			if (from && to && to !== from) await this.record(root, label, 'head', { branch, from, to, mode });
		};
		try {
			const result = await fn();
			await recordIfMoved();
			return result;
		} catch (e) {
			await recordIfMoved();
			throw e;
		}
	}

	describe(entry) {
		const d = entry.data;
		switch (entry.kind) {
			case 'head':
				return d.mode === 'mixed'
					? `Move ${d.branch || 'HEAD'} back to ${shortSha(d.from)}, keeping the changes in your working tree`
					: `Reset ${d.branch || 'HEAD'} from ${shortSha(d.to)} back to ${shortSha(d.from)}`;
			case 'branchDeleted':
				return `Recreate branch ${d.name} at ${shortSha(d.sha)}`;
			case 'tagDeleted':
				return `Recreate tag ${d.name}`;
			case 'stashDropped':
				return `Restore stash "${d.message}"`;
			case 'checkout':
				return `Switch back to ${d.from || shortSha(d.fromSha)}`;
			case 'patchApplied':
				return 'Reverse the applied patch';
			default:
				return entry.label;
		}
	}

	async undo(root, entry, { confirm = true } = {}) {
		const d = entry.data;
		if (confirm) {
			const ok = await vscode.window.showWarningMessage(
				`Undo "${entry.label}"?`,
				{ modal: true, detail: this.describe(entry) },
				'Undo',
			);
			if (ok !== 'Undo') return false;
		}
		const run = args => git.run(args, { cwd: root });
		switch (entry.kind) {
			case 'head': {
				const branch = await git.currentBranch(root);
				if ((d.branch || undefined) !== (branch || undefined)) {
					throw new Error(`This undo applies to ${d.branch || 'a detached HEAD'}, but ${branch || 'a detached HEAD'} is checked out. Switch back first.`);
				}
				const now = await git.revParse(root, 'HEAD');
				if (now !== d.to && confirm) {
					const go = await vscode.window.showWarningMessage(
						`${branch || 'HEAD'} has moved since this operation (now ${shortSha(now)}). Undoing will also discard the later commits from the branch (they stay in the reflog).`,
						{ modal: true },
						'Undo Anyway',
					);
					if (go !== 'Undo Anyway') return false;
				}
				// --keep refuses instead of overwriting uncommitted changes that would conflict.
				await run(['reset', d.mode === 'mixed' ? '--mixed' : '--keep', d.from]);
				break;
			}
			case 'branchDeleted':
				await run(['branch', d.name, d.sha]);
				break;
			case 'tagDeleted':
				await run(['update-ref', `refs/tags/${d.name}`, d.object]);
				break;
			case 'stashDropped':
				await run(['stash', 'store', '-m', d.message, d.sha]);
				break;
			case 'checkout':
				if (d.from) await run(['switch', d.from]);
				else await run(['checkout', '--detach', d.fromSha]);
				break;
			case 'patchApplied':
				await git.run(['apply', '-R', '--whitespace=nowarn', '-'], { cwd: root, input: d.patch });
				break;
			default:
				throw new Error(`Unknown journal entry: ${entry.kind}`);
		}
		await this._remove(root, entry.id);
		return true;
	}
}

module.exports = { Journal };
