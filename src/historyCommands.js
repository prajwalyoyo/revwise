'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const git = require('./git');
const rw = require('./rewrite');
const { shortSha, fromNow } = require('./format');
const { showPatch, readPatchInput, applyPatch } = require('./patches');

const cfg = () => vscode.workspace.getConfiguration('revwise');

/**
 * Collects commits from any invocation style:
 *   graph rows           { root, sha, shas: [...] }
 *   tree multi-select    (clickedNode, selectedNodes[])
 *   blame / palette      { root, sha } or nothing (falls back to the current line's commit)
 */
function commitsOf(a, all) {
	const nodes = Array.isArray(all) && all.length > 1 ? all : a ? [a] : [];
	const root = nodes.find(n => n?.root)?.root;
	const shas = [];
	for (const n of nodes) {
		if (n?.shas) shas.push(...n.shas);
		else {
			const sha = n?.sha ?? n?.commit?.sha;
			if (sha && !n.uncommitted) shas.push(sha);
		}
	}
	return { root, shas: [...new Set(shas)] };
}

function registerHistoryCommands(context, { repos, views, journal, blameArgsForActiveLine }) {
	const reg = (id, fn) =>
		context.subscriptions.push(
			vscode.commands.registerCommand(id, async (...a) => {
				try {
					return await fn(...a);
				} catch (e) {
					if (e instanceof rw.RewriteError && e.state) return sequencerPrompt(e.root, e);
					vscode.window.showErrorMessage(`Revwise: ${String(e.stderr || e.message || e).trim()}`);
				} finally {
					updateSequencerStatus();
				}
			}),
		);
	const refresh = root => repos.refresh(root);
	const confirm = async (message, action, detail) =>
		(await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;

	async function resolveCommits(a, all) {
		let { root, shas } = commitsOf(a, all);
		if (!shas.length) {
			const line = await blameArgsForActiveLine();
			if (line && !line.uncommitted) ({ root, shas } = { root: line.root, shas: [line.sha] });
		}
		return { root, shas };
	}

	async function withTracked(root, label, fn) {
		try {
			await journal.trackHead(root, label, fn);
		} catch (e) {
			if (e instanceof rw.RewriteError) e.root = root;
			throw e;
		} finally {
			refresh(root);
		}
	}

	// ----- paused rebase / cherry-pick / am -----

	const statusItem = vscode.window.createStatusBarItem('revwise.sequencer', vscode.StatusBarAlignment.Left, 100);
	statusItem.name = 'Revwise: operation in progress';
	statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	statusItem.command = 'revwise.sequencer.menu';
	context.subscriptions.push(statusItem, repos.onDidChangeRepo(() => updateSequencerStatus()), repos.onDidChangeActive(() => updateSequencerStatus()));

	let statusTimer;
	function updateSequencerStatus() {
		clearTimeout(statusTimer);
		statusTimer = setTimeout(async () => {
			const root = repos.active;
			const state = root ? await git.sequencerState(root).catch(() => undefined) : undefined;
			vscode.commands.executeCommand('setContext', 'revwise.sequencerState', state || '');
			if (state) {
				statusItem.text = `$(warning) ${state[0].toUpperCase() + state.slice(1)} in progress`;
				statusItem.tooltip = 'Click to continue, skip or abort';
				statusItem.show();
			} else statusItem.hide();
		}, 150);
	}
	updateSequencerStatus();

	async function sequencerPrompt(root, err) {
		root ??= repos.active;
		const state = err?.state || (await git.sequencerState(root));
		if (!state) return;
		const actions = state === 'merge' ? ['Continue', 'Abort'] : ['Continue', 'Skip', 'Abort'];
		const pick = await vscode.window.showWarningMessage(
			`Revwise: the ${state} stopped and needs your attention.`,
			{
				modal: true,
				detail:
					`${err?.message ? err.message + '\n\n' : ''}Resolve any conflicts (they're marked in the Source Control view), stage the files, then Continue. ` +
					'Abort returns everything to how it was before.',
			},
			...actions,
		);
		if (pick) await vscode.commands.executeCommand(`revwise.sequencer.${pick.toLowerCase()}`, root);
	}

	reg('revwise.sequencer.menu', () => sequencerPrompt(repos.active));
	reg('revwise.sequencer.continue', async root => {
		root = typeof root === 'string' ? root : repos.active;
		try {
			const s = await rw.continueOp(root);
			if (s) vscode.window.setStatusBarMessage(`$(check) ${s} continued`, 3000);
		} catch (e) {
			e.root = root;
			throw e;
		} finally {
			refresh(root);
		}
	});
	reg('revwise.sequencer.skip', async root => {
		root = typeof root === 'string' ? root : repos.active;
		try {
			await rw.skipOp(root);
		} catch (e) {
			e.root = root;
			throw e;
		} finally {
			refresh(root);
		}
	});
	reg('revwise.sequencer.abort', async root => {
		root = typeof root === 'string' ? root : repos.active;
		const s = await rw.abortOp(root);
		if (s) vscode.window.setStatusBarMessage(`$(check) ${s} aborted — everything is back as it was`, 4000);
		refresh(root);
	});

	// ----- rewriting history -----

	reg('revwise.rewordCommit', async (a, all) => {
		const { root, shas } = await resolveCommits(a, all);
		if (!root || !shas.length) return;
		const sha = shas[0];
		const current = (await git.run(['log', '-1', '--format=%B', sha], { cwd: root })).replace(/\s+$/, '');
		const [subject, ...rest] = current.split('\n');
		const next = await vscode.window.showInputBox({
			title: `Reword ${shortSha(sha)}`,
			prompt: rest.join('\n').trim() ? 'New subject line (the message body is kept)' : 'New commit message',
			value: subject,
			validateInput: v => (v.trim() ? undefined : 'The message cannot be empty'),
		});
		if (next === undefined || next === subject) return;
		const message = [next, ...rest].join('\n');
		await rw.validate(root, [sha]).catch(e => {
			// HEAD can always be amended even if validation (e.g. merges below) would reject a rebase.
			if (!/merge commits/.test(e.message)) throw e;
		});
		await withTracked(root, `Reword ${shortSha(sha)}`, () => rw.reword(root, sha, message));
		vscode.window.setStatusBarMessage(`$(check) Reworded ${shortSha(sha)}`, 3000);
	});

	reg('revwise.squashCommits', async (a, all) => {
		const { root, shas } = await resolveCommits(a, all);
		if (!root) return;
		if (shas.length < 2) return vscode.window.showInformationMessage('Revwise: select two or more commits to squash (Ctrl/Cmd+click in the graph or views).');
		const v = await rw.validate(root, shas);
		const msgs = [];
		for (const s of v.shas) msgs.push((await git.run(['log', '-1', '--format=%s', s], { cwd: root })).trim());
		const message = await vscode.window.showInputBox({
			title: `Squash ${shas.length} commits into one`,
			prompt: 'Message for the combined commit',
			value: msgs[0],
			validateInput: x => (x.trim() ? undefined : 'The message cannot be empty'),
		});
		if (message === undefined) return;
		await withTracked(root, `Squash ${shas.length} commits`, () => rw.squash(root, v.shas, message));
		vscode.window.setStatusBarMessage(`$(check) Squashed ${shas.length} commits`, 3000);
	});

	reg('revwise.fixupCommits', async (a, all) => {
		const { root, shas } = await resolveCommits(a, all);
		if (!root) return;
		if (shas.length < 2) return vscode.window.showInformationMessage('Revwise: select two or more commits; they are folded into the oldest one.');
		const v = await rw.validate(root, shas);
		if (!(await confirm(`Fold ${shas.length - 1} commit(s) into ${shortSha(v.shas[0])}?`, 'Fixup', 'The oldest commit keeps its message. You can undo this from the Undo view.'))) return;
		await withTracked(root, `Fixup ${shas.length - 1} commit(s) into ${shortSha(v.shas[0])}`, () => rw.squash(root, v.shas));
	});

	reg('revwise.dropCommits', async (a, all) => {
		const { root, shas } = await resolveCommits(a, all);
		if (!root || !shas.length) return;
		await rw.validate(root, shas);
		if (!(await confirm(`Remove ${shas.length} commit(s) from the current branch?`, 'Drop', 'Later commits are replayed without them. You can undo this from the Undo view.'))) return;
		await withTracked(root, `Drop ${shas.length} commit(s)`, () => rw.drop(root, shas));
	});

	// Edit-plan flow: open a plan document, then Start/Cancel from the editor title.
	let pendingPlan;
	const setPlanContext = v => vscode.commands.executeCommand('setContext', 'revwise.rebasePlanOpen', v);
	reg('revwise.rebase.editPlan', async (a, all) => {
		const { root, shas } = await resolveCommits(a, all);
		if (!root || !shas.length) return;
		const { shas: sorted } = await rw.validate(root, shas);
		const { base, text } = await rw.planText(root, sorted[0]);
		const dir = path.join(context.globalStorageUri.fsPath, 'rebase');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'git-rebase-todo');
		fs.writeFileSync(file, text);
		pendingPlan = { root, base, file };
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc, { preview: false });
		setPlanContext(true);
		vscode.window.setStatusBarMessage('Edit the plan, then click ▶ Start Rebase in the editor title.', 6000);
	});
	reg('revwise.rebase.start', async () => {
		if (!pendingPlan) return;
		const { root, base, file } = pendingPlan;
		const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file);
		const text = doc ? doc.getText() : fs.readFileSync(file, 'utf8');
		if (doc?.isDirty) await doc.save();
		pendingPlan = undefined;
		setPlanContext(false);
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		await withTracked(root, 'Interactive rebase', () => rw.applyPlan(root, base, text));
		vscode.window.setStatusBarMessage('$(check) Rebase complete', 3000);
	});
	reg('revwise.rebase.cancel', async () => {
		pendingPlan = undefined;
		setPlanContext(false);
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});

	// ----- multiple commits -----

	reg('revwise.cherryPick', async (a, all) => {
		const { root, shas } = await resolveCommits(a, all);
		if (!root || !shas.length) return;
		const branch = (await git.currentBranch(root)) || 'HEAD';
		const what = shas.length === 1 ? shortSha(shas[0]) : `${shas.length} commits`;
		if (!(await confirm(`Cherry-pick ${what} onto ${branch}?`, 'Cherry Pick', shas.length > 1 ? 'Commits are applied oldest first.' : undefined))) return;
		await withTracked(root, `Cherry-pick ${what}`, () => rw.cherryPick(root, shas));
		vscode.window.setStatusBarMessage(`$(check) Cherry-picked ${what}`, 3000);
	});

	reg('revwise.showCombinedChanges', async (a, all) => {
		const { root, shas } = await resolveCommits(a, all);
		if (!root || !shas.length) return;
		const sorted = await git.sortOldestFirst(root, shas);
		// A contiguous first-parent chain can be shown as one ref-to-ref comparison.
		let chain = true;
		for (let i = 1; i < sorted.length && chain; i++) chain = (await git.parentsOf(root, sorted[i]))[0] === sorted[i - 1];
		if (chain) {
			const base = (await git.parentsOf(root, sorted[0]))[0] || git.EMPTY_TREE;
			views.searchCompare.addCompare(root, base, sorted[sorted.length - 1]);
			return;
		}
		const parts = [];
		for (const s of sorted) parts.push(await git.run(['show', '--format=fuller', '--patch', '--no-color', s], { cwd: root }));
		const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: parts.join('\n') });
		await vscode.window.showTextDocument(doc, { preview: true });
	});

	// ----- patches -----

	reg('revwise.createPatchFromCommits', async (a, all) => {
		const { root, shas } = await resolveCommits(a, all);
		if (!root || !shas.length) return;
		const text = await git.commitsPatch(root, shas);
		await showPatch(text, shas.length === 1 ? `${shortSha(shas[0])}.patch` : `${shas.length}-commits.patch`);
	});
	reg('revwise.createPatchFromChanges', async () => {
		const root = await repos.pick();
		if (!root) return;
		await showPatch(await git.workingPatch(root), 'working-changes.patch');
	});
	reg('revwise.applyPatch', async uri => {
		const root = uri instanceof vscode.Uri ? (await repos.resolve(uri.fsPath)) || (await repos.pick()) : await repos.pick();
		if (!root) return;
		const input = await readPatchInput(uri);
		if (!input) return;
		await applyPatch(root, input, journal, { onSequencer: sequencerPrompt });
		refresh(root);
	});

	// ----- undo -----

	reg('revwise.undo', async () => {
		const root = await repos.pick();
		if (!root) return;
		const [last] = journal.list(root);
		if (!last) {
			const open = await vscode.window.showInformationMessage(
				'Revwise: nothing Revwise did is waiting to be undone. The reflog lists every place HEAD has been, so you can recover from anything else.',
				'Open Reflog',
			);
			if (open) vscode.commands.executeCommand('revwise.undo.focus');
			return;
		}
		if (await journal.undo(root, last)) vscode.window.setStatusBarMessage(`$(check) Undid "${last.label}"`, 3000);
		refresh(root);
	});
	reg('revwise.undoEntry', async node => {
		if (!node?.entry) return;
		if (await journal.undo(node.root, node.entry)) vscode.window.setStatusBarMessage(`$(check) Undid "${node.entry.label}"`, 3000);
		refresh(node.root);
	});
	reg('revwise.resetToHere', async node => {
		const sha = node?.sha;
		if (!sha) return;
		const branch = (await git.currentBranch(node.root)) || 'HEAD';
		const pick = await vscode.window.showWarningMessage(
			`Move ${branch} to ${shortSha(sha)}?`,
			{
				modal: true,
				detail:
					'"Keep Changes" moves the branch and keeps your current files as uncommitted changes (git reset --mixed).\n' +
					'"Restore Files" also makes the files match that commit, refusing if it would overwrite uncommitted work (git reset --keep).\n' +
					'Either way you can undo it from the Undo view.',
			},
			'Keep Changes',
			'Restore Files',
		);
		if (!pick) return;
		const mode = pick === 'Keep Changes' ? 'mixed' : 'keep';
		await journal.trackHead(node.root, `Reset ${branch} to ${shortSha(sha)}`, () => git.run(['reset', `--${mode}`, sha], { cwd: node.root }), { mode });
		refresh(node.root);
	});

	// ----- branch cleanup -----

	reg('revwise.cleanupBranches', async a => {
		const root = a?.root || (await repos.pick());
		if (!root) return;
		const protectedGlobs = cfg().get('branchCleanup.protected', ['main', 'master', 'develop', 'dev', 'trunk', 'release/*']);
		const staleDays = cfg().get('branchCleanup.staleDays', 90);
		const isProtected = name =>
			protectedGlobs.some(g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name));
		const qp = vscode.window.createQuickPick();
		qp.title = 'Clean Up Branches';
		qp.canSelectMany = true;
		qp.matchOnDescription = true;
		qp.buttons = [{ iconPath: new vscode.ThemeIcon('cloud-download'), tooltip: 'Fetch & prune remotes, then re-check' }];
		const load = async () => {
			qp.busy = true;
			const info = await git.branchCleanupInfo(root);
			const now = Date.now();
			const items = [];
			for (const b of info) {
				if (b.current || b.worktree || isProtected(b.name)) continue;
				const reasons = [];
				if (b.merged) reasons.push('merged');
				if (b.gone) reasons.push('remote deleted');
				const age = (now - b.date.getTime()) / 86400000;
				if (age > staleDays) reasons.push(`no commits for ${Math.floor(age)} days`);
				if (!reasons.length) continue;
				items.push({ label: `$(git-branch) ${b.name}`, description: reasons.join(' • '), detail: `${shortSha(b.sha)} • last commit ${fromNow(b.date)}`, branch: b, safe: b.merged });
			}
			items.sort((x, y) => (y.branch.merged || y.branch.gone) - (x.branch.merged || x.branch.gone) || x.branch.date - y.branch.date);
			qp.items = items;
			qp.selectedItems = items.filter(i => i.branch.merged || i.branch.gone);
			qp.placeholder = items.length
				? 'Merged and remote-deleted branches are preselected. Protected, current and worktree branches are never listed.'
				: 'No branches to clean up 🎉';
			qp.busy = false;
		};
		qp.onDidTriggerButton(async () => {
			qp.busy = true;
			try {
				await git.run(['fetch', '--all', '--prune'], { cwd: root });
			} catch (e) {
				vscode.window.showWarningMessage(`Revwise: fetch failed: ${String(e.stderr || e.message).split('\n')[0]}`);
			}
			await load();
		});
		const picked = await new Promise(resolve => {
			qp.onDidAccept(() => {
				resolve(qp.selectedItems.slice());
				qp.hide();
			});
			qp.onDidHide(() => resolve(undefined));
			qp.show();
			load();
		});
		qp.dispose();
		if (!picked?.length) return;
		const unmerged = picked.filter(p => !p.safe);
		if (
			!(await confirm(
				`Delete ${picked.length} branch${picked.length === 1 ? '' : 'es'}?`,
				'Delete',
				(unmerged.length ? `${unmerged.length} of them aren't merged: ${unmerged.map(u => u.branch.name).join(', ')}.\n` : '') +
					'Each deletion is recorded in the Undo view so you can bring branches back.',
			))
		)
			return;
		let deleted = 0;
		for (const p of picked) {
			try {
				await git.run(['branch', p.safe ? '-d' : '-D', p.branch.name], { cwd: root });
				await journal.record(root, `Delete branch ${p.branch.name}`, 'branchDeleted', { name: p.branch.name, sha: p.branch.sha });
				deleted++;
			} catch (e) {
				vscode.window.showWarningMessage(`Revwise: couldn't delete ${p.branch.name}: ${String(e.stderr || e.message).split('\n')[0]}`);
			}
		}
		vscode.window.setStatusBarMessage(`$(check) Deleted ${deleted} branch${deleted === 1 ? '' : 'es'}`, 4000);
		refresh(root);
	});

	return { sequencerPrompt };
}

module.exports = { registerHistoryCommands, commitsOf };
