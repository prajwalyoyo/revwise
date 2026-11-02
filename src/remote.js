'use strict';

/**
 * Converts a git remote URL into a browsable web base and provider kind.
 * Supports https/ssh/scp-style URLs for GitHub (incl. Enterprise), GitLab, Bitbucket and Azure DevOps.
 */
function parseRemoteUrl(url) {
	if (!url) return undefined;
	let host;
	let repoPath;
	let m;
	url = url.trim();
	if ((m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url))) {
		host = m[1];
		repoPath = m[2];
	} else if ((m = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(url))) {
		host = m[1];
		repoPath = m[2];
	} else {
		return undefined;
	}
	repoPath = repoPath.replace(/\.git$/, '').replace(/\/+$/, '').replace(/^\/+/, '');
	host = host.toLowerCase();

	// Azure DevOps ssh: ssh.dev.azure.com:v3/org/project/repo
	if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
		const [, org, project, repo] = repoPath.split('/');
		return { kind: 'azure', base: `https://dev.azure.com/${org}/${project}/_git/${repo}` };
	}
	if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
		return { kind: 'azure', base: `https://${host}/${repoPath}` };
	}
	if (host.includes('gitlab')) return { kind: 'gitlab', base: `https://${host}/${repoPath}` };
	if (host.includes('bitbucket')) return { kind: 'bitbucket', base: `https://${host}/${repoPath}` };
	// GitHub and unknown hosts (GitHub Enterprise, Gitea, etc. share GitHub's URL layout).
	return { kind: 'github', base: `https://${host}/${repoPath}` };
}

const enc = p => p.split('/').map(encodeURIComponent).join('/');

function fileUrl(remote, ref, filePath, startLine, endLine) {
	const { kind, base } = remote;
	const hasLines = startLine != null;
	const end = endLine != null && endLine !== startLine ? endLine : undefined;
	switch (kind) {
		case 'gitlab':
			return `${base}/-/blob/${enc(ref)}/${enc(filePath)}${hasLines ? `#L${startLine}${end ? `-${end}` : ''}` : ''}`;
		case 'bitbucket':
			return `${base}/src/${enc(ref)}/${enc(filePath)}${hasLines ? `#lines-${startLine}${end ? `:${end}` : ''}` : ''}`;
		case 'azure': {
			const version = /^[0-9a-f]{40}$/.test(ref) ? `GC${ref}` : `GB${ref}`;
			let u = `${base}?path=${encodeURIComponent('/' + filePath)}&version=${encodeURIComponent(version)}`;
			if (hasLines) u += `&line=${startLine}&lineEnd=${(end ?? startLine) + 1}&lineStartColumn=1&lineEndColumn=1&lineStyle=plain`;
			return u;
		}
		default:
			return `${base}/blob/${enc(ref)}/${enc(filePath)}${hasLines ? `#L${startLine}${end ? `-L${end}` : ''}` : ''}`;
	}
}

function commitUrl(remote, sha) {
	switch (remote.kind) {
		case 'gitlab':
			return `${remote.base}/-/commit/${sha}`;
		case 'bitbucket':
			return `${remote.base}/commits/${sha}`;
		default:
			return `${remote.base}/commit/${sha}`;
	}
}

function branchUrl(remote, branch) {
	switch (remote.kind) {
		case 'gitlab':
			return `${remote.base}/-/tree/${enc(branch)}`;
		case 'bitbucket':
			return `${remote.base}/branch/${enc(branch)}`;
		case 'azure':
			return `${remote.base}?version=${encodeURIComponent('GB' + branch)}`;
		default:
			return `${remote.base}/tree/${enc(branch)}`;
	}
}

function repoUrl(remote) {
	return remote.base;
}

module.exports = { parseRemoteUrl, fileUrl, commitUrl, branchUrl, repoUrl };
