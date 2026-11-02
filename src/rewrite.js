'use strict';
// History rewriting (reword / squash / fixup / drop / custom plan) via `git rebase -i` driven by scripts/seq-editor.js.
// No VS Code dependency so it can be unit-tested against real repositories.
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('./git');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'seq-editor.js');

function quote(p) {
	return `"${p.replace(/\\/g, '/')}"`;
}

/**
 * Editor environment for git. Inside VS Code `process.execPath` is the Electron binary, which behaves
 * as plain Node with ELECTRON_RUN_AS_NODE=1, so no separate Node install is required.
 */
function editorEnv(planFile) {
	const node = quote(process.execPath);
	const env = {
		ELECTRON_RUN_AS_NODE: '1',
		GIT_SEQUENCE_EDITOR: `${node} ${quote(SCRIPT)}`,
		GIT_EDITOR: `${node} ${quote(SCRIPT)} --noop`,
	};
	if (planFile) env.REVWISE_PLAN = planFile;
	return env;
}

class RewriteError extends Error {
	constructor(message, { state, stderr } = {}) {
		super(message);
		this.state = state;
		this.stderr = stderr;
	}
}

/** Checks the commits can be rewritten in place and returns { shas (oldest first), base (parent of oldest, or null for root) }. */
async function validate(root, shas) {
	const pending = await git.sequencerState(root);
	if (pending) throw new RewriteError(`A ${pending} is already in progress. Continue or abort it first.`, { state: pending });
	const head = await git.revParse(root, 'HEAD');
	const sorted = await git.sortOldestFirst(root, [...new Set(shas)]);
	for (const sha of sorted) {
		if (!(await git.isAncestor(root, sha, head))) {
			throw new RewriteError(`Commit ${sha.slice(0, 7)} isn't on the current branch. Only commits reachable from HEAD can be rewritten.`);
		}
	}
	const parents = await git.parentsOf(root, sorted[0]);
	const base = parents[0] || null;
	const merges = (await git.run(['rev-list', '--merges', base ? `${base}..HEAD` : 'HEAD'], { cwd: root })).trim();
	if (merges) {
		throw new RewriteError('The commits after this point include merge commits. Revwise only rewrites linear history, to avoid flattening merges.');
	}
	return { shas: sorted, base };
}

function makeDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'revwise-rebase-'));
}

async function runRebase(root, base, plan) {
	const dir = plan.dir;
	const planFile = path.join(dir, 'plan.json');
	fs.writeFileSync(planFile, JSON.stringify(plan));
	const args = ['rebase', '-i', '--autostash', base || '--root'];
	try {
		await git.run(args, { cwd: root, env: editorEnv(planFile) });
	} catch (e) {
		const state = await git.sequencerState(root);
		// Keep `dir` while a rebase is paused: pending `exec` lines read message files from it.
		if (!state) fs.rmSync(dir, { recursive: true, force: true });
		throw new RewriteError(firstLines(e.stderr || e.message), { state, stderr: e.stderr });
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

function firstLines(text, n = 6) {
	return String(text || '')
		.split('\n')
		.filter(l => l.trim() && !/^hint:/.test(l))
		.slice(0, n)
		.join('\n');
}

async function reword(root, sha, message) {
	if (!message.trim()) throw new RewriteError('The commit message is empty.');
	const head = await git.revParse(root, 'HEAD');
	if (sha === head) {
		await git.run(['commit', '--amend', '--only', '--allow-empty', '-F', '-'], { cwd: root, input: message, env: editorEnv() });
		return;
	}
	const { base } = await validate(root, [sha]);
	const dir = makeDir();
	const msg = path.join(dir, 'reword.txt');
	fs.writeFileSync(msg, message.endsWith('\n') ? message : message + '\n');
	await runRebase(root, base, { mode: 'ops', dir, shas: [sha], actions: {}, rewords: { [sha]: msg } });
}

/** Folds all commits into the oldest one. With `message` the result gets that message; without it keeps the oldest's message. */
async function squash(root, shas, message) {
	if (shas.length < 2) throw new RewriteError('Select at least two commits to squash.');
	const v = await validate(root, shas);
	const [target, ...members] = v.shas;
	const dir = makeDir();
	const actions = Object.fromEntries(members.map(s => [s, 'fixup']));
	const rewords = {};
	if (message != null) {
		if (!message.trim()) throw new RewriteError('The commit message is empty.');
		rewords[target] = path.join(dir, 'squash.txt');
		fs.writeFileSync(rewords[target], message.endsWith('\n') ? message : message + '\n');
	}
	await runRebase(root, v.base, { mode: 'ops', dir, shas: v.shas, actions, rewords, group: { target, members } });
}

async function drop(root, shas) {
	const v = await validate(root, shas);
	const dir = makeDir();
	await runRebase(root, v.base, { mode: 'ops', dir, shas: v.shas, actions: Object.fromEntries(v.shas.map(s => [s, 'drop'])), rewords: {} });
}

const PLAN_HELP = `
# Revwise rebase plan — edit, save, then click "Start Rebase" (▶) in the editor title.
# Commits are listed oldest first. Reorder lines to reorder commits.
#   pick   <sha> = keep the commit
#   reword <sha> <new subject> = keep the commit and change its subject line
#   squash <sha> = fold into the previous commit, combining messages
#   fixup  <sha> = fold into the previous commit, keeping the previous message
#   drop   <sha> = remove the commit
#   edit   <sha> = stop at the commit so you can amend it
# Deleting a line also removes that commit. Lines starting with # are ignored.
`;

/** Builds an editable plan for commits after (and including) `fromSha`. */
async function planText(root, fromSha) {
	const { base } = await validate(root, [fromSha]);
	const out = await git.run(['log', '--reverse', '--format=pick %h %s', base ? `${base}..HEAD` : 'HEAD'], { cwd: root });
	return { base, text: out + PLAN_HELP };
}

async function applyPlan(root, base, text) {
	const pending = await git.sequencerState(root);
	if (pending) throw new RewriteError(`A ${pending} is already in progress. Continue or abort it first.`, { state: pending });
	const todo = text
		.split(/\r?\n/)
		.filter(l => l.trim() && !l.trim().startsWith('#'))
		.join('\n');
	if (!todo.trim()) throw new RewriteError('The plan is empty. Use `drop` lines, or cancel, instead of deleting every line.');
	await runRebase(root, base, { mode: 'replace', dir: makeDir(), todo });
}

const CONTINUE = { rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert', am: 'am', merge: 'merge' };

async function continueOp(root) {
	const state = await git.sequencerState(root);
	if (!state) return undefined;
	const args = state === 'merge' ? ['commit', '--no-edit'] : [CONTINUE[state], '--continue'];
	try {
		await git.run(args, { cwd: root, env: editorEnv() });
	} catch (e) {
		throw new RewriteError(firstLines(e.stderr || e.message), { state: await git.sequencerState(root), stderr: e.stderr });
	}
	return state;
}

async function abortOp(root) {
	const state = await git.sequencerState(root);
	if (!state) return undefined;
	await git.run([CONTINUE[state], '--abort'], { cwd: root });
	return state;
}

async function skipOp(root) {
	const state = await git.sequencerState(root);
	if (!state || state === 'merge') return undefined;
	try {
		await git.run([CONTINUE[state], '--skip'], { cwd: root, env: editorEnv() });
	} catch (e) {
		throw new RewriteError(firstLines(e.stderr || e.message), { state: await git.sequencerState(root), stderr: e.stderr });
	}
	return state;
}

/** Cherry-picks commits (oldest first) onto HEAD. Merge commits are rejected. */
async function cherryPick(root, shas) {
	const sorted = await git.sortOldestFirst(root, shas);
	for (const s of sorted) {
		if ((await git.parentsOf(root, s)).length > 1) throw new RewriteError(`${s.slice(0, 7)} is a merge commit; cherry-pick it from the command line with -m.`);
	}
	try {
		await git.run(['cherry-pick', ...sorted], { cwd: root, env: editorEnv() });
	} catch (e) {
		throw new RewriteError(firstLines(e.stderr || e.message), { state: await git.sequencerState(root), stderr: e.stderr });
	}
}

module.exports = {
	RewriteError,
	editorEnv,
	validate,
	reword,
	squash,
	drop,
	planText,
	applyPlan,
	continueOp,
	abortOp,
	skipOp,
	cherryPick,
	firstLines,
};
