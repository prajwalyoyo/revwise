'use strict';
const vscode = require('vscode');
const path = require('path');
const git = require('./git');
const remote = require('./remote');
const { shortSha } = require('./format');
const { diffFile, showCommitDocument } = require('./uris');

/**
 * Normalizes command arguments from tree nodes, graph rows and blame lines into
 * { root, sha, ref, summary, branch }.
 */
function refOf(a) {
	if (!a) return undefined;
	return {
		root: a.root,
		sha: a.sha ?? a.commit?.sha ?? a.branch?.sha ?? a.tag?.sha ?? a.stash?.sha,
		ref: a.refName ?? a.branch?.name ?? a.tag?.name,
		summary: a.summary ?? a.commit?.summary,
		branch: a.branch,
		uncommitted: a.uncommitted,
	};
}

async function exec(root, args, success) {
	try {
		const out = await git.run(args, { cwd: root });
		if (success) vscode.window.setStatusBarMessage(`$(check) ${success}`, 3000);
		return out;
	} catch (e) {
		const msg = String(e.stderr || e.message || e).trim();
		vscode.window.showErrorMessage(`Revwise: git ${args[0]} failed: ${msg}`);
		throw e;
	}
}

async function confirm(message, action) {
	return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}

function registerCommands(context, { repos, views, blameArgsForActiveLine, journal }) {
	const reg = (id, fn) =>
		context.subscriptions.push(
			vscode.commands.registerCommand(id, async (...a) => {
				try {
					return await fn(...a);
				} catch (e) {
					// exec() already reported git errors; surface anything else.
					if (!e?.stderr && e?.message) vscode.window.showErrorMessage(`Revwise: ${e.message}`);
				}
			}),
		);

	/** Resolve a commit for commands invoked from the palette: current line's commit, else ask. */
	async function commitRef(a) {
		const r = refOf(a);
		if (r?.root && (r.sha || r.ref)) {
			if (!r.sha) r.sha = await git.revParse(r.root, r.ref).catch(() => undefined);
			return r;
		}
		const line = await blameArgsForActiveLine();
		if (line && !line.uncommitted) return refOf(line);
		const root = await repos.pick();
		if (!root) return undefined;
		return pickRef(root, 'Select a branch, tag or commit');
	}

	async function pickRef(root, title, { includeWorking = false } = {}) {
		const [branches, tags] = await Promise.all([git.branches(root), git.tags(root)]);
		const items = [];
		if (includeWorking) items.push({ label: '$(file) Working Tree', ref: undefined, working: true });
		items.push({ label: '$(git-commit) HEAD', ref: 'HEAD' });
		for (const b of branches) {
			items.push({ label: `${b.current ? '$(check)' : b.remote ? '$(cloud)' : '$(git-branch)'} ${b.name}`, description: b.subject, ref: b.name, sha: b.sha });
		}
		for (const t of tags) items.push({ label: `$(tag) ${t.name}`, description: t.subject, ref: t.name, sha: t.sha });
		const qp = vscode.window.createQuickPick();
		qp.title = title;
		qp.placeholder = 'Pick a ref, or type a commit SHA';
		qp.items = items;
		qp.matchOnDescription = true;
		const result = await new Promise(resolve => {
			qp.onDidAccept(() => {
				const sel = qp.selectedItems[0];
				resolve(sel ?? (qp.value.trim() ? { ref: qp.value.trim() } : undefined));
				qp.hide();
			});
			qp.onDidHide(() => resolve(undefined));
			qp.show();
		});
		qp.dispose();
		if (!result) return undefined;
		if (result.working) return { root, working: true };
		return { root, ref: result.ref, sha: result.sha ?? (await git.revParse(root, result.ref).catch(() => result.ref)) };
	}

	async function pickRemote(root, preferred) {
		const list = await git.remotes(root);
		if (!list.length) {
			vscode.window.showInformationMessage('Revwise: this repository has no remotes.');
			return undefined;
		}
		const found = (preferred && list.find(r => r.name === preferred)) || list.find(r => r.name === 'origin') || (list.length === 1 && list[0]);
		const r =
			found ||
			(await vscode.window.showQuickPick(list.map(x => ({ label: x.name, description: x.url, r: x })), { title: 'Select a remote' }))?.r;
		if (!r) return undefined;
		const parsed = remote.parseRemoteUrl(r.url);
		if (!parsed) vscode.window.showWarningMessage(`Revwise: can't build a web URL for remote ${r.name} (${r.url}).`);
		return parsed && { ...parsed, name: r.name };
	}

	const refresh = () => repos.refresh(repos.active);

	// ----- views -----
	reg('revwise.views.refresh', () => repos.refresh());
	reg('revwise.views.loadMore', node => node?.loadMore());
	reg('revwise.views.openFileChanges', node => node?.openChanges());
	reg('revwise.views.diffCommitFile', a => diffFile(a.root, a.parent ?? `${a.sha}^`, a.path, a.sha, a.path));
	reg('revwise.views.openFile', node => node?.fsPath && vscode.window.showTextDocument(vscode.Uri.file(node.fsPath)));
	reg('revwise.views.openFileAtRevision', async node => {
		if (!node?.file) return;
		const { gitUri } = require('./uris');
		const ref = node.right ?? 'HEAD';
		const doc = await vscode.workspace.openTextDocument(gitUri(node.root, ref, node.file.path, node.fsPath));
		await vscode.window.showTextDocument(doc, { preview: true });
	});
	reg('revwise.searchCompare.remove', node => views.searchCompare.remove(node));
	reg('revwise.searchCompare.clear', () => views.searchCompare.clear());
	reg('revwise.selectRepository', async () => {
		await repos.ready;
		const pick = await vscode.window.showQuickPick(
			[...repos.roots.keys()].map(r => ({ label: path.basename(r), description: r, root: r, picked: r === repos.active })),
			{ title: 'Select active repository' },
		);
		if (pick) repos.setActive(pick.root);
	});

	// ----- commit actions -----
	reg('revwise.showCommitDetails', async a => {
		const r = await commitRef(a);
		if (r?.sha) await showCommitDocument(r.root, r.sha);
	});
	reg('revwise.copyCommitSha', async a => {
		const r = await commitRef(a);
		if (!r?.sha) return;
		await vscode.env.clipboard.writeText(r.sha);
		vscode.window.setStatusBarMessage(`$(check) Copied ${shortSha(r.sha)}`, 2000);
	});
	reg('revwise.copyCommitMessage', async a => {
		const r = await commitRef(a);
		if (!r?.sha) return;
		const msg = await git.run(['log', '-1', '--format=%B', r.sha], { cwd: r.root });
		await vscode.env.clipboard.writeText(msg.trim());
		vscode.window.setStatusBarMessage('$(check) Copied commit message', 2000);
	});
	reg('revwise.checkout', async a => {
		let r = refOf(a);
		if (!r?.root) {
			const root = await repos.pick();
			if (!root) return;
			r = await pickRef(root, 'Checkout');
			if (!r) return;
		}
		const before = { from: await git.currentBranch(r.root), fromSha: await git.revParse(r.root, 'HEAD').catch(() => undefined) };
		const branch = r.branch;
		let label;
		if (branch?.remote) {
			const local = branch.name.slice(branch.remoteName.length + 1);
			const exists = (await git.branches(r.root)).some(b => !b.remote && b.name === local);
			await exec(r.root, exists ? ['switch', local] : ['switch', '--track', branch.name], `Switched to ${local}`);
			label = `Checkout ${local}`;
		} else if (r.ref && r.ref !== 'HEAD' && !/^stash@/.test(r.ref)) {
			const isRemote = (await git.branches(r.root)).find(b => b.remote && b.name === r.ref);
			if (isRemote) {
				const local = r.ref.slice(isRemote.remoteName.length + 1);
				const exists = (await git.branches(r.root)).some(b => !b.remote && b.name === local);
				await exec(r.root, exists ? ['switch', local] : ['switch', '--track', r.ref], `Switched to ${local}`);
				label = `Checkout ${local}`;
			} else {
				await exec(r.root, ['checkout', r.ref], `Checked out ${r.ref}`);
				label = `Checkout ${r.ref}`;
			}
		} else if (r.sha) {
			if (!(await confirm(`Checkout ${shortSha(r.sha)}? This puts the repository in a detached HEAD state.`, 'Checkout'))) return;
			await exec(r.root, ['checkout', '--detach', r.sha], `Checked out ${shortSha(r.sha)}`);
			label = `Checkout ${shortSha(r.sha)}`;
		}
		if (label && before.fromSha) await journal?.record(r.root, label, 'checkout', before);
		refresh();
	});
	reg('revwise.createBranch', async a => {
		const r = (await commitRef(a)) || undefined;
		if (!r) return;
		const name = await vscode.window.showInputBox({
			title: `Create branch at ${r.ref || shortSha(r.sha)}`,
			prompt: 'Branch name',
			validateInput: v => (!v.trim() || /\s|\.\.|[~^:?*[\\]/.test(v) ? 'Enter a valid branch name' : undefined),
		});
		if (!name) return;
		const mode = await vscode.window.showQuickPick(['Create and Switch', 'Create Only'], { title: `Branch ${name}` });
		if (!mode) return;
		const start = r.ref && !/^stash@/.test(r.ref) ? r.ref : r.sha;
		if (mode === 'Create and Switch') await exec(r.root, ['switch', '-c', name, start], `Created and switched to ${name}`);
		else await exec(r.root, ['branch', name, start], `Created branch ${name}`);
		refresh();
	});
	reg('revwise.deleteBranch', async a => {
		const b = a?.branch;
		if (!b || b.remote || b.current) return;
		if (!(await confirm(`Delete branch ${b.name}?`, 'Delete'))) return;
		try {
			await git.run(['branch', '-d', b.name], { cwd: a.root });
		} catch (e) {
			if (!/not fully merged/.test(e.stderr || '')) {
				vscode.window.showErrorMessage(`Revwise: ${String(e.stderr || e.message).trim()}`);
				return;
			}
			if (!(await confirm(`Branch ${b.name} is not fully merged. Force delete it?`, 'Force Delete'))) return;
			await exec(a.root, ['branch', '-D', b.name]);
		}
		await journal?.record(a.root, `Delete branch ${b.name}`, 'branchDeleted', { name: b.name, sha: b.sha });
		vscode.window.setStatusBarMessage(`$(check) Deleted ${b.name}`, 3000);
		refresh();
	});
	reg('revwise.createTag', async a => {
		const r = await commitRef(a);
		if (!r) return;
		const name = await vscode.window.showInputBox({ title: `Create tag at ${shortSha(r.sha || r.ref)}`, prompt: 'Tag name' });
		if (!name) return;
		const message = await vscode.window.showInputBox({ title: `Tag ${name}`, prompt: 'Message (leave empty for a lightweight tag)' });
		if (message === undefined) return;
		const args = message ? ['tag', '-a', name, '-m', message, r.sha] : ['tag', name, r.sha];
		await exec(r.root, args, `Created tag ${name}`);
		refresh();
	});
	reg('revwise.deleteTag', async a => {
		if (!a?.tag) return;
		if (!(await confirm(`Delete tag ${a.tag.name}?`, 'Delete'))) return;
		const object = (await git.run(['rev-parse', `refs/tags/${a.tag.name}`], { cwd: a.root })).trim();
		await exec(a.root, ['tag', '-d', a.tag.name], `Deleted tag ${a.tag.name}`);
		await journal?.record(a.root, `Delete tag ${a.tag.name}`, 'tagDeleted', { name: a.tag.name, object });
		refresh();
	});
	reg('revwise.revertCommit', async a => {
		const r = await commitRef(a);
		if (!r?.sha) return;
		if (!(await confirm(`Revert ${shortSha(r.sha)} "${r.summary || ''}"? A new commit will be created.`, 'Revert'))) return;
		await journal.trackHead(r.root, `Revert ${shortSha(r.sha)}`, () => exec(r.root, ['revert', '--no-edit', r.sha], `Reverted ${shortSha(r.sha)}`));
		refresh();
	});

	// ----- compare & search -----
	reg('revwise.compareWithHead', async a => {
		const r = await commitRef(a);
		if (r) views.searchCompare.addCompare(r.root, r.ref || r.sha, 'HEAD');
	});
	reg('revwise.compareWithWorkingTree', async a => {
		const r = await commitRef(a);
		if (r) views.searchCompare.addCompare(r.root, r.ref || r.sha, undefined);
	});
	reg('revwise.compareRefs', async a => {
		let left = refOf(a);
		const root = left?.root || (await repos.pick());
		if (!root) return;
		if (!left?.sha && !left?.ref) left = await pickRef(root, 'Compare: select the base ref');
		if (!left) return;
		const right = await pickRef(root, `Compare ${left.ref || shortSha(left.sha)} with…`, { includeWorking: true });
		if (!right) return;
		views.searchCompare.addCompare(root, left.ref || left.sha, right.working ? undefined : right.ref || right.sha);
	});
	reg('revwise.searchCommits', async (mode, query) => {
		const root = await repos.pick();
		if (!root) return;
		if (!mode) {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: '$(comment) Message', mode: 'message' },
					{ label: '$(account) Author', mode: 'author' },
					{ label: '$(git-commit) Commit SHA', mode: 'sha' },
					{ label: '$(file) File name', mode: 'file' },
					{ label: '$(diff) Changes (code added/removed)', mode: 'changes' },
				],
				{ title: 'Search commits by' },
			);
			if (!pick) return;
			mode = pick.mode;
		}
		if (!query) {
			query = await vscode.window.showInputBox({ title: `Search commits by ${mode}`, prompt: 'Search text' });
			if (!query) return;
		}
		views.searchCompare.addSearch(root, mode, query);
	});

	// ----- remotes -----
	async function openOrCopy(url, copy) {
		if (!url) return;
		if (copy) {
			await vscode.env.clipboard.writeText(url);
			vscode.window.setStatusBarMessage('$(check) Copied remote URL', 2000);
		} else {
			await vscode.env.openExternal(vscode.Uri.parse(url, true));
		}
		return url;
	}
	async function fileRemoteUrl(uri) {
		const editor = vscode.window.activeTextEditor;
		uri = uri instanceof vscode.Uri ? uri : editor?.document.uri;
		if (!uri || uri.scheme !== 'file') return undefined;
		const root = await repos.resolve(uri.fsPath);
		if (!root) return undefined;
		const branch = await git.currentBranch(root);
		const upstream = branch && (await git.branches(root)).find(b => !b.remote && b.name === branch)?.upstream;
		const remoteName = upstream ? upstream.slice(0, upstream.indexOf('/')) : undefined;
		const r = await pickRemote(root, remoteName);
		if (!r) return undefined;
		const ref = upstream ? upstream.slice(remoteName.length + 1) : await git.revParse(root, 'HEAD');
		let start;
		let end;
		if (editor && editor.document.uri.toString() === uri.toString()) {
			start = editor.selection.start.line + 1;
			end = editor.selection.end.line + 1;
			if (editor.selection.isEmpty) end = start;
		}
		return remote.fileUrl(r, ref, git.toGitPath(root, uri.fsPath), start, end);
	}
	reg('revwise.openFileOnRemote', async uri => openOrCopy(await fileRemoteUrl(uri), false));
	reg('revwise.copyRemoteFileUrl', async uri => openOrCopy(await fileRemoteUrl(uri), true));
	reg('revwise.openCommitOnRemote', async a => {
		const r = await commitRef(a);
		if (!r?.sha) return;
		const rem = await pickRemote(r.root);
		return rem && openOrCopy(remote.commitUrl(rem, r.sha), false);
	});
	reg('revwise.copyRemoteCommitUrl', async a => {
		const r = await commitRef(a);
		if (!r?.sha) return;
		const rem = await pickRemote(r.root);
		return rem && openOrCopy(remote.commitUrl(rem, r.sha), true);
	});
	reg('revwise.openBranchOnRemote', async a => {
		const b = a?.branch;
		const root = a?.root || (await repos.pick());
		if (!root) return;
		let name;
		let remoteName;
		if (b?.remote) {
			remoteName = b.remoteName;
			name = b.name.slice(b.remoteName.length + 1);
		} else {
			const current = b || (await git.branches(root)).find(x => x.current);
			if (!current) return;
			if (current.upstream) {
				remoteName = current.upstream.slice(0, current.upstream.indexOf('/'));
				name = current.upstream.slice(remoteName.length + 1);
			} else name = current.name;
		}
		const rem = await pickRemote(root, remoteName);
		return rem && openOrCopy(remote.branchUrl(rem, name), false);
	});
	reg('revwise.openRepoOnRemote', async a => {
		const root = a?.root || (await repos.pick());
		if (!root) return;
		const rem = await pickRemote(root, a?.remote?.name);
		return rem && openOrCopy(remote.repoUrl(rem), false);
	});
	reg('revwise.fetch', async a => {
		const root = a?.root || (await repos.pick());
		if (!root) return;
		const args = a?.remote ? ['fetch', a.remote.name] : ['fetch', '--all', '--prune'];
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Revwise: fetching' }, () =>
			exec(root, args, 'Fetched'),
		);
		refresh();
	});

	// ----- stashes -----
	reg('revwise.stashSave', async () => {
		const root = await repos.pick();
		if (!root) return;
		const message = await vscode.window.showInputBox({ title: 'Stash changes', prompt: 'Stash message (optional)' });
		if (message === undefined) return;
		const args = ['stash', 'push', '--include-untracked'];
		if (message) args.push('-m', message);
		await exec(root, args, 'Stashed changes');
		refresh();
	});
	reg('revwise.stashApply', async a => {
		if (!a?.stash) return;
		await exec(a.root, ['stash', 'apply', a.stash.ref], `Applied ${a.stash.ref}`);
		refresh();
	});
	reg('revwise.stashPop', async a => {
		if (!a?.stash) return;
		await exec(a.root, ['stash', 'pop', a.stash.ref], `Popped ${a.stash.ref}`);
		refresh();
	});
	reg('revwise.stashDrop', async a => {
		if (!a?.stash) return;
		const s = a.stash;
		if (!(await confirm(`Drop ${s.ref} "${s.message}"? You can restore it from Revwise's Undo view.`, 'Drop'))) return;
		await exec(a.root, ['stash', 'drop', s.ref], `Dropped ${s.ref}`);
		await journal?.record(a.root, `Drop stash "${s.message}"`, 'stashDropped', {
			sha: s.sha,
			message: s.branch ? `On ${s.branch}: ${s.message}` : s.message,
		});
		refresh();
	});

	// ----- worktrees -----
	reg('revwise.openWorktree', a => {
		if (a?.worktree) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(a.worktree.path), { forceNewWindow: true });
	});
	reg('revwise.revealWorktree', a => {
		if (a?.worktree) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(a.worktree.path));
	});
	reg('revwise.createWorktree', async a => {
		const root = a?.root || (await repos.pick());
		if (!root) return;
		const r = await pickRef(root, 'Create worktree from…');
		if (!r) return;
		const branchName = await vscode.window.showInputBox({
			title: 'New worktree',
			prompt: 'New branch name (leave empty to check out the selected ref)',
		});
		if (branchName === undefined) return;
		const folder = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			openLabel: 'Select parent folder for worktree',
			defaultUri: vscode.Uri.file(path.dirname(root)),
		});
		if (!folder?.[0]) return;
		const target = path.join(folder[0].fsPath, `${path.basename(root)}-${(branchName || r.ref || shortSha(r.sha)).replace(/[\\/]/g, '-')}`);
		const args = ['worktree', 'add'];
		if (branchName) args.push('-b', branchName);
		args.push(target, r.ref || r.sha);
		await exec(root, args, `Created worktree at ${target}`);
		refresh();
	});
	reg('revwise.removeWorktree', async a => {
		if (!a?.worktree) return;
		if (!(await confirm(`Remove worktree at ${a.worktree.path}?`, 'Remove'))) return;
		await exec(a.root, ['worktree', 'remove', a.worktree.path], 'Removed worktree');
		refresh();
	});
}

module.exports = { registerCommands, refOf };
