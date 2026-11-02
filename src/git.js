'use strict';
const { execFile } = require('child_process');
const path = require('path');

const UNCOMMITTED = '0000000000000000000000000000000000000000';
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Runs git and resolves with stdout.
 * `env` adds variables; `okCodes` lists non-zero exit codes that still count as success (e.g. `diff --no-index` exits 1).
 */
function run(args, { cwd, input, signal, env, okCodes } = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile(
			'git',
			args,
			{
				cwd,
				signal,
				maxBuffer: MAX_BUFFER,
				windowsHide: true,
				// Read-only commands must not take index.lock, or they fight with the user's own git operations.
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env },
			},
			(err, stdout, stderr) => {
				if (err && !(okCodes && okCodes.includes(err.code))) {
					err.stderr = stderr;
					reject(err);
				} else {
					resolve(stdout);
				}
			},
		);
		if (input != null) {
			child.stdin.on('error', () => {});
			child.stdin.end(input, 'utf8');
		}
	});
}

const rootCache = new Map();

/** Resolves the repository root for a directory; caches misses as null. */
function getRepoRoot(dir) {
	let p = rootCache.get(dir);
	if (p === undefined) {
		p = run(['rev-parse', '--show-toplevel'], { cwd: dir }).then(
			out => path.normalize(out.trim()),
			() => null,
		);
		rootCache.set(dir, p);
	}
	return p;
}

function clearRootCache() {
	rootCache.clear();
}

function toGitPath(root, fsPath) {
	return path.relative(root, fsPath).split(path.sep).join('/');
}

/**
 * Parses `git blame --incremental` output.
 * Returns { commits: Map<sha, commit>, lines: Array<{ sha, origLine, filename }> } indexed by 0-based final line.
 */
function parseIncrementalBlame(out) {
	const commits = new Map();
	const lines = [];
	let group;
	let commit;
	let start = 0;
	const len = out.length;
	while (start < len) {
		let end = out.indexOf('\n', start);
		if (end === -1) end = len;
		let line = out.slice(start, end);
		start = end + 1;
		if (line.endsWith('\r')) line = line.slice(0, -1);
		if (line.length === 0) continue;

		if (group === undefined) {
			const parts = line.split(' ');
			if (parts.length !== 4 || parts[0].length !== 40) continue;
			const sha = parts[0];
			group = { sha, orig: +parts[1], final: +parts[2], count: +parts[3] };
			commit = commits.get(sha);
			if (commit === undefined) {
				commit = { sha, uncommitted: sha === UNCOMMITTED };
				commits.set(sha, commit);
			}
			continue;
		}

		const sp = line.indexOf(' ');
		const key = sp === -1 ? line : line.slice(0, sp);
		const value = sp === -1 ? '' : line.slice(sp + 1);
		switch (key) {
			case 'filename':
				if (commit.filename === undefined) commit.filename = value;
				for (let i = 0; i < group.count; i++) {
					lines[group.final - 1 + i] = { sha: group.sha, origLine: group.orig + i, filename: value };
				}
				group = undefined;
				commit = undefined;
				break;
			case 'author':
				commit.author = value;
				break;
			case 'author-mail':
				commit.email = value.replace(/^<|>$/g, '');
				break;
			case 'author-time':
				commit.date = new Date(+value * 1000);
				break;
			case 'summary':
				commit.summary = value;
				break;
			case 'previous': {
				const i = value.indexOf(' ');
				commit.previousSha = value.slice(0, i);
				commit.previousFilename = value.slice(i + 1);
				break;
			}
			case 'boundary':
				commit.boundary = true;
				break;
		}
	}
	return { commits, lines };
}

/**
 * Blame options:
 *   detectMoves: 'off' | 'file' (-M: lines moved within the file) | 'files' (-C: also copied from other files in the same commit)
 *   ignoreWhitespace: -w
 *   ignoreRevsFile: absolute path to a list of commits to skip (formatting commits); ignored if it makes git fail.
 */
async function blame(root, fsPath, { contents, signal, detectMoves = 'off', ignoreWhitespace = false, ignoreRevsFile } = {}) {
	const args = ['blame', '--root', '--incremental', '--encoding=utf-8'];
	if (detectMoves === 'file') args.push('-M');
	else if (detectMoves === 'files') args.push('-C');
	if (ignoreWhitespace) args.push('-w');
	if (contents != null) args.push('--contents', '-');
	const tail = ['--', toGitPath(root, fsPath)];
	if (ignoreRevsFile) {
		try {
			return parseIncrementalBlame(
				await run([...args, '--ignore-revs-file', ignoreRevsFile, ...tail], { cwd: root, input: contents, signal }),
			);
		} catch (e) {
			if (e?.name === 'AbortError') throw e;
		}
	}
	const out = await run([...args, ...tail], { cwd: root, input: contents, signal });
	return parseIncrementalBlame(out);
}

async function notes(root, sha) {
	try {
		return (await run(['notes', 'show', sha], { cwd: root })).trim() || undefined;
	} catch {
		return undefined;
	}
}

function show(root, ref, gitPath) {
	return run(['show', '--textconv', `${ref}:${gitPath}`], { cwd: root });
}

function showCommit(root, sha) {
	return run(['show', '--stat', '--patch', '--format=fuller', '--no-color', sha], { cwd: root });
}

const RS = '\x1e';
const US = '\x1f';

/** Parses `git log --follow --name-only` records emitted with RS/US separators. */
function parseFileLog(out, fallbackPath) {
	const entries = [];
	for (const record of out.split(RS)) {
		const lines = record.split('\n').filter(l => l.trim().length);
		if (!lines.length) continue;
		const [sha, parents, author, time, summary] = lines[0].split(US);
		entries.push({
			sha,
			parent: (parents || '').split(' ')[0] || undefined,
			author,
			date: new Date(+time * 1000),
			summary,
			filename: (lines[1] || fallbackPath).trim(),
		});
	}
	return entries;
}

async function fileLog(root, fsPath, limit = 200) {
	const gitPath = toGitPath(root, fsPath);
	const out = await run(
		['log', '--follow', `-n${limit}`, `--format=${RS}%H${US}%P${US}%an${US}%at${US}%s`, '--name-only', '--', gitPath],
		{ cwd: root },
	);
	return parseFileLog(out, gitPath);
}

// ---------- commit log (graph, views, search) ----------

const LOG_FORMAT = `--format=${RS}%H${US}%P${US}%an${US}%ae${US}%at${US}%s${US}%D`;

/** Parses `%D` output produced with `--decorate=full` (short names are accepted as a fallback). */
function parseRefs(decoration) {
	const refs = [];
	if (!decoration) return refs;
	for (let r of decoration.split(', ')) {
		r = r.trim();
		if (!r) continue;
		let current = false;
		if (r.startsWith('HEAD -> ')) {
			refs.push({ type: 'head', name: 'HEAD' });
			r = r.slice(8);
			current = true;
		} else if (r === 'HEAD') {
			refs.push({ type: 'head', name: 'HEAD' });
			continue;
		}
		if (r.startsWith('tag: ')) r = r.slice(5);
		if (r.endsWith('/HEAD')) continue;
		if (r.startsWith('refs/heads/')) refs.push({ type: 'branch', name: r.slice(11), ...(current && { current }) });
		else if (r.startsWith('refs/remotes/')) refs.push({ type: 'remote', name: r.slice(13) });
		else if (r.startsWith('refs/tags/')) refs.push({ type: 'tag', name: r.slice(10) });
		else if (r.startsWith('refs/')) continue; // stash, notes, etc.
		else if (current) refs.push({ type: 'branch', name: r, current });
		else refs.push({ type: decoration.includes(`tag: ${r}`) ? 'tag' : r.includes('/') ? 'remote' : 'branch', name: r });
	}
	return refs;
}

/** Parses records produced with LOG_FORMAT; any trailing per-record lines (patches, file names) are ignored. */
function parseLog(out) {
	const commits = [];
	for (const record of out.split(RS)) {
		const nl = record.indexOf('\n');
		const header = nl === -1 ? record : record.slice(0, nl);
		const f = header.split(US);
		if (f.length < 7 || f[0].length < 40) continue;
		commits.push({
			sha: f[0],
			parents: f[1] ? f[1].split(' ') : [],
			author: f[2],
			email: f[3],
			date: new Date(+f[4] * 1000),
			summary: f[5],
			refs: parseRefs(f[6]),
		});
	}
	return commits;
}

async function log(root, args, { signal } = {}) {
	return parseLog(await run(['log', '--decorate=full', LOG_FORMAT, ...args], { cwd: root, signal }));
}

/** Commits for the graph. `scope` is 'all', 'current', or a validated branch name (stash commits excluded). */
function graphLog(root, { skip = 0, limit = 500, scope = 'all', signal } = {}) {
	const refs =
		scope === 'all' ? ['--branches', '--remotes', '--tags', 'HEAD'] : scope === 'current' ? ['HEAD'] : [scope];
	return log(root, ['--date-order', `--skip=${skip}`, `-n${limit}`, ...refs, '--'], { signal });
}

/** History of a line range (`git log -L`), following the lines through edits. */
function lineLog(root, fsPath, startLine, endLine, limit = 100) {
	return log(root, [`-n${limit}`, `-L${startLine},${endLine}:${toGitPath(root, fsPath)}`]);
}

const SEARCH_MODES = ['message', 'author', 'sha', 'file', 'changes'];
function searchCommits(root, mode, query, limit = 200) {
	const scope = ['--branches', '--remotes', '--tags', 'HEAD'];
	switch (mode) {
		case 'message':
			return log(root, [`-n${limit}`, '-i', '--fixed-strings', `--grep=${query}`, ...scope, '--']);
		case 'author':
			return log(root, [`-n${limit}`, '-i', `--author=${query}`, ...scope, '--']);
		case 'sha':
			return log(root, ['--no-walk', query, '--']).catch(() => []);
		case 'file':
			return log(root, [`-n${limit}`, ...scope, '--', `:(glob,icase)**/*${query}*`]);
		case 'changes':
			return log(root, [`-n${limit}`, `-G${query}`, ...scope, '--']);
		default:
			throw new Error(`Unknown search mode: ${mode}`);
	}
}

// ---------- refs ----------

async function branches(root) {
	const out = await run(
		[
			'for-each-ref',
			'--sort=-committerdate',
			'--format=%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(contents:subject)',
			'refs/heads',
			'refs/remotes',
		],
		{ cwd: root },
	);
	const result = [];
	for (const line of out.split('\n')) {
		if (!line) continue;
		const [head, ref, name, sha, upstream, track, time, subject] = line.split(US);
		if (ref.endsWith('/HEAD')) continue;
		const remote = ref.startsWith('refs/remotes/');
		const ahead = /ahead (\d+)/.exec(track);
		const behind = /behind (\d+)/.exec(track);
		result.push({
			name,
			sha,
			current: head === '*',
			remote,
			remoteName: remote ? name.slice(0, name.indexOf('/')) : undefined,
			upstream: upstream || undefined,
			gone: track === 'gone',
			ahead: ahead ? +ahead[1] : 0,
			behind: behind ? +behind[1] : 0,
			date: new Date(+time * 1000),
			subject,
		});
	}
	return result;
}

async function remotes(root) {
	const out = await run(['remote', '-v'], { cwd: root });
	const map = new Map();
	for (const line of out.split('\n')) {
		const m = /^(\S+)\t(\S+)\s+\((fetch|push)\)/.exec(line);
		if (!m) continue;
		const r = map.get(m[1]) || { name: m[1] };
		r[m[3]] = m[2];
		map.set(m[1], r);
	}
	return [...map.values()].map(r => ({ name: r.name, url: r.fetch || r.push, pushUrl: r.push || r.fetch }));
}

async function tags(root) {
	const out = await run(
		[
			'for-each-ref',
			'--sort=-creatordate',
			'--format=%(refname:short)%1f%(objectname)%1f%(*objectname)%1f%(creatordate:unix)%1f%(contents:subject)',
			'refs/tags',
		],
		{ cwd: root },
	);
	return out
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [name, obj, peeled, time, subject] = line.split(US);
			return { name, sha: peeled || obj, annotated: !!peeled, date: new Date(+time * 1000), subject };
		});
}

async function stashes(root) {
	const out = await run(['stash', 'list', `--format=%gd${US}%H${US}%at${US}%gs`], { cwd: root });
	return out
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [ref, sha, time, subject] = line.split(US);
			const m = /^(?:On|WIP on) ([^:]+): (.*)$/s.exec(subject);
			return { ref, sha, date: new Date(+time * 1000), message: m ? m[2] : subject, branch: m ? m[1] : undefined };
		});
}

function parseWorktrees(out) {
	const result = [];
	for (const block of out.replace(/\r/g, '').split('\n\n')) {
		const wt = {};
		for (const line of block.split('\n')) {
			if (line.startsWith('worktree ')) wt.path = path.normalize(line.slice(9));
			else if (line.startsWith('HEAD ')) wt.sha = line.slice(5);
			else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
			else if (line === 'detached') wt.detached = true;
			else if (line === 'bare') wt.bare = true;
			else if (line.startsWith('locked')) wt.locked = true;
			else if (line.startsWith('prunable')) wt.prunable = true;
		}
		if (wt.path) result.push(wt);
	}
	return result;
}

async function worktrees(root) {
	return parseWorktrees(await run(['worktree', 'list', '--porcelain'], { cwd: root }));
}

function parseShortlog(out) {
	const result = [];
	for (const line of out.split('\n')) {
		const m = /^\s*(\d+)\t(.*?)(?: <([^>]*)>)?\s*$/.exec(line);
		if (m) result.push({ count: +m[1], name: m[2], email: m[3] || '' });
	}
	return result;
}

async function contributors(root) {
	return parseShortlog(await run(['shortlog', '-sne', '--no-merges', 'HEAD', '--'], { cwd: root }));
}

// ---------- files changed ----------

function parseNameStatus(out) {
	const files = [];
	for (const line of out.split('\n')) {
		if (!line.trim()) continue;
		const parts = line.split('\t');
		const status = parts[0][0];
		if (status === 'R' || status === 'C') files.push({ status, originalPath: parts[1], path: parts[2] });
		else files.push({ status, path: parts[1] });
	}
	return files;
}

/** Files changed by a commit, relative to its first parent (or the empty tree for root commits). */
async function commitFiles(root, sha) {
	return parseNameStatus(
		await run(['show', '--format=', '--name-status', '-M', '--diff-merges=first-parent', sha, '--'], { cwd: root }),
	);
}

async function stashFiles(root, ref) {
	return parseNameStatus(await run(['stash', 'show', '--name-status', '-M', ref], { cwd: root }));
}

/** Files that differ between two refs; omit `right` to compare against the working tree. */
async function diffFiles(root, left, right) {
	const args = ['diff', '--name-status', '-M', left];
	if (right) args.push(right);
	args.push('--');
	return parseNameStatus(await run(args, { cwd: root }));
}

/** Changed line ranges (`git diff -U0`) between a ref and the working file. */
function parseUnifiedZero(out) {
	const hunks = [];
	const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
	let m;
	while ((m = re.exec(out))) {
		const oldCount = m[2] === undefined ? 1 : +m[2];
		const newStart = +m[3];
		const newCount = m[4] === undefined ? 1 : +m[4];
		hunks.push({
			type: oldCount === 0 ? 'added' : newCount === 0 ? 'deleted' : 'modified',
			start: newStart,
			count: newCount,
		});
	}
	return hunks;
}

async function diffHunks(root, ref, fsPath) {
	return parseUnifiedZero(
		await run(['diff', '-U0', '--no-color', '--no-ext-diff', ref, '--', toGitPath(root, fsPath)], { cwd: root }),
	);
}

// ---------- refs: misc ----------

async function currentBranch(root) {
	try {
		return (await run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root })).trim() || undefined;
	} catch {
		return undefined;
	}
}

async function revParse(root, ref) {
	return (await run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: root })).trim();
}

async function gitDir(root) {
	return path.normalize((await run(['rev-parse', '--absolute-git-dir'], { cwd: root })).trim());
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function isAncestor(root, ancestor, descendant) {
	try {
		await run(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root });
		return true;
	} catch {
		return false;
	}
}

/**
 * Sorts commits oldest → newest by ancestry (topological), not by date: rewritten commits often share
 * the same timestamp, so date order can't be trusted. The walk is bounded at the selection's merge-base.
 */
async function sortOldestFirst(root, shas) {
	const unique = [...new Set(shas)];
	if (unique.length < 2) return unique;
	const args = ['rev-list', '--topo-order', '--reverse', ...unique];
	try {
		const mb = (await run(['merge-base', '--octopus', ...unique], { cwd: root })).trim();
		if (mb) args.push(`^${mb}^@`);
	} catch {
		// Unrelated histories: walk everything.
	}
	const wanted = new Set(unique);
	const ordered = (await run(args, { cwd: root })).split('\n').filter(s => wanted.has(s));
	// Anything not reached (shouldn't happen) keeps its relative position at the end.
	for (const s of unique) if (!ordered.includes(s)) ordered.push(s);
	return ordered;
}

async function parentsOf(root, sha) {
	const out = await run(['rev-list', '--parents', '-n1', sha], { cwd: root });
	return out.trim().split(' ').slice(1);
}

/** Which in-progress operation (if any) is waiting for the user: rebase, cherry-pick, revert, merge or am. */
async function sequencerState(root) {
	const dir = await gitDir(root);
	const fs = require('fs');
	const has = p => fs.existsSync(path.join(dir, p));
	if (has('rebase-merge') || (has('rebase-apply') && !has('rebase-apply/applying'))) return 'rebase';
	if (has('rebase-apply')) return 'am';
	if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
	if (has('REVERT_HEAD')) return 'revert';
	if (has('MERGE_HEAD')) return 'merge';
	return undefined;
}

// ---------- reflog ----------

function parseReflog(out) {
	const entries = [];
	for (const line of out.split('\n')) {
		if (!line) continue;
		const [sha, selector, subject, time, parents, author, summary] = line.split(US);
		entries.push({
			sha,
			selector,
			action: subject,
			date: new Date(+time * 1000),
			parents: parents ? parents.split(' ') : [],
			author,
			summary,
			email: '',
			refs: [],
		});
	}
	return entries;
}

async function reflog(root, limit = 200) {
	try {
		return parseReflog(
			await run(['reflog', `-n${limit}`, `--format=%H${US}%gd${US}%gs${US}%ct${US}%P${US}%an${US}%s`], { cwd: root }),
		);
	} catch {
		return [];
	}
}

// ---------- working tree status (porcelain v2) ----------

/**
 * Parses `git status --porcelain=v2 -z`. Each file: { path, origPath?, x, y, status } where
 * status is a single display letter: M/A/D/R/C/T, '?' untracked, '!' conflicted.
 */
function parseStatusV2(out) {
	const files = [];
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (!rec) continue;
		const kind = rec[0];
		if (kind === '?') {
			files.push({ path: rec.slice(2), x: '?', y: '?', status: '?' });
		} else if (kind === '1' || kind === '2' || kind === 'u') {
			const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : 10;
			let idx = 0;
			for (let n = 0; n < fieldCount; n++) idx = rec.indexOf(' ', idx) + 1;
			const filePath = rec.slice(idx);
			const xy = rec.slice(2, 4);
			const x = xy[0];
			const y = xy[1];
			const f = { path: filePath, x, y };
			if (kind === '2') f.origPath = parts[++i];
			f.status = kind === 'u' ? '!' : y !== '.' ? y : x;
			files.push(f);
		}
	}
	return files;
}

async function status(root) {
	return parseStatusV2(await run(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: root }));
}

// ---------- per-commit line stats (visual history) ----------

/** Resolves numstat rename notation (`a => b`, `dir/{a => b}/f`) to the new path. */
function numstatPath(p) {
	if (!p.includes(' => ')) return p;
	const brace = /\{([^{}]*) => ([^{}]*)\}/;
	if (brace.test(p)) return p.replace(brace, (_, _a, b) => b).replace(/\/\//g, '/');
	return p.split(' => ')[1];
}

function parseNumstatLog(out, fallbackPath) {
	const entries = [];
	for (const record of out.split(RS)) {
		const lines = record.split('\n');
		const header = lines[0];
		const f = header.split(US);
		if (f.length < 6 || f[0].length < 40) continue;
		let adds = 0;
		let dels = 0;
		let filename;
		let binary = false;
		for (const l of lines.slice(1)) {
			const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(l);
			if (!m) continue;
			if (m[1] === '-') binary = true;
			else {
				adds += +m[1];
				dels += +m[2];
			}
			filename = numstatPath(m[3]);
		}
		entries.push({
			sha: f[0],
			parent: f[1] ? f[1].split(' ')[0] : undefined,
			author: f[2],
			email: f[3],
			date: new Date(+f[4] * 1000),
			summary: f[5],
			adds,
			dels,
			binary,
			filename: filename || fallbackPath,
		});
	}
	return entries;
}

async function fileStatsLog(root, fsPath, limit = 2000) {
	const gitPath = toGitPath(root, fsPath);
	const out = await run(
		['log', '--follow', `-n${limit}`, '--numstat', `--format=${RS}%H${US}%P${US}%an${US}%ae${US}%at${US}%s`, '--', gitPath],
		{ cwd: root },
	);
	return parseNumstatLog(out, gitPath);
}

// ---------- branch cleanup ----------

/** Local branches with merge/upstream/worktree facts used to suggest safe deletions. */
async function branchCleanupInfo(root) {
	const out = await run(
		[
			'for-each-ref',
			`--format=%(refname:short)${US}%(objectname)${US}%(upstream:short)${US}%(upstream:track,nobracket)${US}%(committerdate:unix)${US}%(HEAD)${US}%(worktreepath)`,
			'refs/heads',
		],
		{ cwd: root },
	);
	const bases = ['HEAD'];
	try {
		const def = (await run(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { cwd: root })).trim();
		if (def) bases.push(def);
	} catch {}
	const merged = new Set();
	for (const base of bases) {
		try {
			const m = await run(['branch', '--merged', base, '--format=%(refname:short)'], { cwd: root });
			for (const b of m.split('\n')) if (b) merged.add(b.trim());
		} catch {}
	}
	return out
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [name, sha, upstream, track, time, head, worktree] = line.split(US);
			return {
				name,
				sha,
				upstream: upstream || undefined,
				gone: track === 'gone',
				date: new Date(+time * 1000),
				current: head === '*',
				worktree: worktree || undefined,
				merged: merged.has(name),
			};
		});
}

// ---------- patches ----------

/** Patch for working-tree changes vs HEAD (optionally limited to paths), including untracked files. */
async function workingPatch(root, paths) {
	const st = await status(root);
	const wanted = paths ? new Set(paths) : undefined;
	const untracked = st.filter(f => f.status === '?' && (!wanted || wanted.has(f.path))).map(f => f.path);
	const tracked = paths ? paths.filter(p => !untracked.includes(p)) : undefined;
	let out = '';
	if (!tracked || tracked.length) {
		const args = ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--'];
		if (tracked) args.push(...tracked);
		out += await run(args, { cwd: root });
	}
	for (const p of untracked) {
		out += await run(['diff', '--no-index', '--binary', '--no-color', '--no-ext-diff', '--', '/dev/null', p], { cwd: root, okCodes: [1] });
	}
	return out;
}

/** `git format-patch` mailbox for the given commits (oldest first); merge commits produce no output. */
async function commitsPatch(root, shas) {
	let out = '';
	for (const sha of await sortOldestFirst(root, shas)) {
		out += await run(['format-patch', '--stdout', '--binary', '--no-color', '-1', sha], { cwd: root });
	}
	return out;
}

function isMailboxPatch(text) {
	return /^From [0-9a-f]{40} /m.test(text);
}

module.exports = {
	UNCOMMITTED,
	SEARCH_MODES,
	run,
	getRepoRoot,
	clearRootCache,
	toGitPath,
	parseIncrementalBlame,
	parseFileLog,
	parseLog,
	parseRefs,
	parseWorktrees,
	parseShortlog,
	parseNameStatus,
	parseUnifiedZero,
	blame,
	show,
	showCommit,
	fileLog,
	log,
	graphLog,
	lineLog,
	searchCommits,
	branches,
	remotes,
	tags,
	stashes,
	worktrees,
	contributors,
	commitFiles,
	stashFiles,
	diffFiles,
	diffHunks,
	currentBranch,
	revParse,
	EMPTY_TREE,
	notes,
	isAncestor,
	sortOldestFirst,
	parentsOf,
	sequencerState,
	parseReflog,
	reflog,
	parseStatusV2,
	status,
	numstatPath,
	parseNumstatLog,
	fileStatsLog,
	branchCleanupInfo,
	workingPatch,
	commitsPatch,
	isMailboxPatch,
	gitDir,
};
