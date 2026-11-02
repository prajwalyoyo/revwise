'use strict';
// Launches an isolated VS Code instance (separate user-data/extensions dirs) against a fixture repo.
// Usage: node test-int/run.js [path-to-Code.exe]
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codeExe =
	process.argv[2] ||
	process.env.VSCODE_EXE ||
	path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'revwise-int-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
// Each commit/merge gets its own timestamp a minute apart, so "most recent" is never a same-second tie.
let clock = Math.floor(Date.now() / 1000) - 3600;
const g = (...a) => {
	const env = { ...process.env };
	if (a[0] === 'commit' || a[0] === 'merge') {
		clock += 60;
		env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = `${clock} +0000`;
	}
	return execFileSync('git', a, { cwd: repo, env });
};
g('init', '-q', '-b', 'main');
g('config', 'commit.gpgsign', 'false');
g('config', 'user.name', 'Alice');
g('config', 'user.email', 'alice@example.com');
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
g('add', '.');
g('commit', '-q', '-m', 'first commit');
g('config', 'user.name', 'Bob');
g('config', 'user.email', 'bob@example.com');
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
g('commit', '-q', '-am', 'second: change line 2');
g('mv', 'a.txt', 'b.txt');
g('commit', '-q', '-m', 'rename a to b');
g('tag', 'v1');
g('switch', '-q', '-c', 'feature');
g('config', 'user.name', 'Carol');
g('config', 'user.email', 'carol@example.com');
fs.writeFileSync(path.join(repo, 'c.txt'), 'carol\n');
g('add', '.');
g('commit', '-q', '-m', 'add c on feature');
g('switch', '-q', 'main');
g('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
g('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
fs.writeFileSync(path.join(repo, 'c.txt'), 'carol\nstashed\n');
g('stash', 'push', '-q', '-m', 'wip on c');

const results = path.join(tmp, 'results.json');
const root = path.resolve(__dirname, '..');
const env = { ...process.env, REVWISE_REPO: repo, REVWISE_RESULTS: results };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(
	codeExe,
	[
		repo,
		`--extensionDevelopmentPath=${root}`,
		`--extensionTestsPath=${path.join(__dirname, 'index.js')}`,
		`--user-data-dir=${path.join(tmp, 'ud')}`,
		`--extensions-dir=${path.join(tmp, 'ext')}`,
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		'--new-window',
	],
	{ env, stdio: 'inherit', timeout: 600000 },
);
let out = '(no results written)';
let ok = false;
try {
	out = fs.readFileSync(results, 'utf8');
	const parsed = JSON.parse(out);
	ok = r.status === 0 && parsed.every(x => x.ok);
	const failed = parsed.filter(x => !x.ok);
	out = `PASS ${parsed.length - failed.length}/${parsed.length}\n` + failed.map(f => `FAIL ${f.name}\n${f.error.split('\n').slice(0, 10).join('\n')}`).join('\n\n');
} catch {}
console.log(out, '\nCode.exe exit status:', r.status, r.error ? String(r.error) : '');
try {
	fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
process.exit(ok ? 0 : 1);
