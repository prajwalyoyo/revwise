'use strict';
// Revwise's promise: no account, no network calls, no telemetry, no bundled third-party code.
// These checks fail the build if shipped code ever starts talking to the network on its own.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHIPPED_DIRS = ['src', 'media', 'scripts'];

function shippedFiles() {
	const out = [];
	for (const d of SHIPPED_DIRS) {
		for (const f of fs.readdirSync(path.join(ROOT, d))) {
			if (/\.(js|css|html)$/.test(f)) out.push(path.join(d, f));
		}
	}
	return out;
}

test('shipped code uses no network or telemetry APIs', () => {
	const forbidden = [
		[/require\(['"](node:)?(https?|http2|net|tls|dgram|dns)['"]\)/, 'Node network module'],
		[/\bfetch\s*\(/, 'fetch()'],
		[/XMLHttpRequest|WebSocket|EventSource|sendBeacon/, 'browser network API'],
		[/createTelemetryLogger|TelemetryReporter|applicationinsights|telemetry\.send/i, 'telemetry'],
		[/authentication\.getSession/, 'account sign-in'],
		[/registerMcpServerDefinitionProvider|lm\.registerTool/, 'MCP / AI tool registration'],
	];
	const hits = [];
	for (const rel of shippedFiles()) {
		const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		for (const [re, what] of forbidden) if (re.test(text)) hits.push(`${rel}: ${what}`);
	}
	assert.deepStrictEqual(hits, []);
});

test('the only outbound action is opening a URL the user explicitly asked for', () => {
	const uses = shippedFiles().filter(rel => /openExternal/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
	assert.deepStrictEqual(uses, [path.join('src', 'commands.js')], 'openExternal only in the explicit "Open on Remote" commands');
});

test('webviews cannot load remote content', () => {
	for (const rel of ['src/graphView.js', 'src/visualHistory.js']) {
		const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		const csp = /Content-Security-Policy" content="([^"]+)"/.exec(text);
		assert.ok(csp, `${rel} sets a CSP`);
		assert.match(csp[1], /default-src 'none'/, `${rel}: default-src 'none'`);
		assert.doesNotMatch(csp[1], /connect-src|https?:/, `${rel}: no remote origins`);
	}
});

test('manifest: no runtime dependencies, no auth, no MCP, no AI contributions, lazy activation', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.deepStrictEqual(Object.keys(pkg.dependencies || {}), []);
	assert.strictEqual(pkg.extensionDependencies, undefined);
	for (const key of ['authentication', 'mcpServerDefinitionProviders', 'languageModelTools', 'chatParticipants']) {
		assert.strictEqual(pkg.contributes[key], undefined, `contributes.${key}`);
	}
	assert.deepStrictEqual(pkg.activationEvents, ['onStartupFinished']);
});
