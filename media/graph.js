// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const ROW_H = 26;
	const LANE_W = 14;
	const MAX_LANES = 24;
	const OVERSCAN = 12;
	const COLORS = ['#15a0bf', '#0669f7', '#8e00c2', '#c517b6', '#d90171', '#cd0101', '#f25d2e', '#f2ca33', '#7bd938', '#2ece9d'];

	const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
	const viewport = $('viewport');
	const spacer = $('spacer');
	const rowsEl = $('rows');
	const menu = $('menu');
	const search = /** @type {HTMLInputElement} */ ($('search'));
	const scopeEl = /** @type {HTMLSelectElement} */ ($('scope'));

	let rows = [];
	let head;
	let done = false;
	let requested = false;
	let maxWidth = 1;
	let selected = -1;
	let multi = new Set();
	let anchor = -1;
	let matches = [];
	let matchIndex = -1;
	let query = '';

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const color = i => COLORS[i % COLORS.length];
	const x = c => c * LANE_W + LANE_W / 2;

	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
	function ago(ms) {
		const diff = (ms - Date.now()) / 1000;
		for (const [u, s] of UNITS) {
			if (Math.abs(diff) >= +s || u === 'second') return rtf.format(Math.round(diff / +s), /** @type {any} */ (u));
		}
		return '';
	}

	const graphWidth = () => Math.min(maxWidth, MAX_LANES) * LANE_W + 6;

	function svgFor(r) {
		const g = r.g;
		const mid = ROW_H / 2;
		let p = '';
		for (const l of g.pass) p += `<path d="M${x(l.col)} 0V${ROW_H}" stroke="${color(l.color)}"/>`;
		for (const u of g.up) {
			p +=
				u.from === g.col
					? `<path d="M${x(u.from)} 0V${mid}" stroke="${color(u.color)}"/>`
					: `<path d="M${x(u.from)} 0Q${x(u.from)} ${mid} ${x(g.col)} ${mid}" stroke="${color(u.color)}"/>`;
		}
		for (const d of g.down) {
			p +=
				d.to === g.col
					? `<path d="M${x(g.col)} ${mid}V${ROW_H}" stroke="${color(d.color)}"/>`
					: `<path d="M${x(g.col)} ${mid}Q${x(d.to)} ${mid} ${x(d.to)} ${ROW_H}" stroke="${color(d.color)}"/>`;
		}
		const c = color(g.color);
		const cx = x(g.col);
		const node =
			r.sha === head
				? `<circle cx="${cx}" cy="${mid}" r="5.5" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="2.5"/>`
				: r.parents.length > 1
					? `<circle cx="${cx}" cy="${mid}" r="3.5" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="2"/>`
					: `<circle cx="${cx}" cy="${mid}" r="4" fill="${c}"/>`;
		return `<svg width="${graphWidth()}" height="${ROW_H}" fill="none" stroke-width="2">${p}${node}</svg>`;
	}

	function refsFor(r) {
		let h = '';
		for (const ref of r.refs) {
			if (ref.type === 'head') continue;
			const icon = ref.type === 'tag' ? '&#x25C6;' : ref.type === 'remote' ? '&#x2601;&#xFE0E;' : ref.current ? '&#x2713;' : '&#x2387;';
			h += `<span class="ref ref-${ref.type}${ref.current ? ' current' : ''}" data-ref="${esc(ref.name)}" title="${esc(ref.type)}: ${esc(ref.name)}">${icon} ${esc(ref.name)}</span>`;
		}
		return h;
	}

	function highlight(text) {
		const s = String(text ?? '');
		if (!query) return esc(s);
		const i = s.toLowerCase().indexOf(query);
		if (i === -1) return esc(s);
		return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + query.length)) + '</mark>' + esc(s.slice(i + query.length));
	}

	function render() {
		const top = viewport.scrollTop;
		const h = viewport.clientHeight;
		const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
		const end = Math.min(rows.length, Math.ceil((top + h) / ROW_H) + OVERSCAN);
		const matchSet = new Set(matches);
		let html = '';
		for (let i = start; i < end; i++) {
			const r = rows[i];
			let cls = 'row';
			if (i === selected || multi.has(i)) cls += ' selected';
			if (r.sha === head) cls += ' head';
			if (query) cls += matchSet.has(i) ? ' match' : ' dim';
			html +=
				`<div class="${cls}" data-i="${i}" style="top:${i * ROW_H}px">` +
				`<div class="c-graph">${svgFor(r)}</div>` +
				`<div class="c-msg">${refsFor(r)}<span class="summary" title="${esc(r.summary)}">${highlight(r.summary)}</span></div>` +
				`<div class="c-author" title="${esc(r.author)} &lt;${esc(r.email)}&gt;">${highlight(r.author)}</div>` +
				`<div class="c-date" title="${esc(new Date(r.date).toLocaleString())}">${esc(ago(r.date))}</div>` +
				`<div class="c-sha">${highlight(r.sha.slice(0, 7))}</div>` +
				`</div>`;
		}
		rowsEl.innerHTML = html;
		if (!done && !requested && end >= rows.length - 50) {
			requested = true;
			$('status').textContent = 'Loading…';
			vscode.postMessage({ type: 'more' });
		}
	}

	function updateStatus() {
		const sel = multi.size > 1 ? ` • ${multi.size} selected` : '';
		$('status').textContent = `${rows.length}${done ? '' : '+'} commits${sel}`;
	}

	function computeMatches() {
		matches = [];
		if (query) {
			rows.forEach((r, i) => {
				if (
					r.summary.toLowerCase().includes(query) ||
					r.author.toLowerCase().includes(query) ||
					r.email.toLowerCase().includes(query) ||
					r.sha.startsWith(query) ||
					r.refs.some(ref => ref.name.toLowerCase().includes(query))
				)
					matches.push(i);
			});
		}
		$('matches').textContent = query ? `${matches.length ? matchIndex + 1 : 0}/${matches.length}${done ? '' : '+'}` : '';
	}

	function select(i, reveal = true) {
		if (i < 0 || i >= rows.length) return;
		selected = i;
		anchor = i;
		multi = new Set([i]);
		updateStatus();
		if (reveal) {
			const top = i * ROW_H;
			if (top < viewport.scrollTop) viewport.scrollTop = top;
			else if (top + ROW_H > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top - viewport.clientHeight + ROW_H * 2;
		}
		render();
	}

	function jump(dir) {
		if (!matches.length) return;
		matchIndex = (matchIndex + dir + matches.length) % matches.length;
		computeMatches();
		select(matches[matchIndex]);
	}

	function selectedShas() {
		return [...multi].sort((a, b) => a - b).map(i => rows[i].sha);
	}

	function action(name, i, ref) {
		const r = rows[i];
		if (!r) return;
		const shas = multi.has(i) && multi.size > 1 ? selectedShas() : [r.sha];
		vscode.postMessage({ type: 'action', action: name, sha: r.sha, shas, summary: r.summary, ref });
	}

	function showMenu(ev, i) {
		const refEl = /** @type {HTMLElement} */ (ev.target).closest('.ref');
		const ref = refEl ? refEl.getAttribute('data-ref') : '';
		if (!multi.has(i)) select(i, false);
		const n = multi.size;
		const items =
			n > 1
				? [
						['combined', `Show Combined Changes (${n})`],
						['createPatch', `Create Patch from ${n} Commits`],
						['-'],
						['cherryPick', `Cherry Pick ${n} Commits…`],
						['squash', `Squash ${n} Commits…`],
						['fixup', `Fixup into Oldest…`],
						['drop', `Drop ${n} Commits…`],
						['-'],
						['copySha', 'Copy SHA'],
					]
				: [
						['showCommit', 'Show Commit'],
						['compareWithHead', 'Compare with HEAD'],
						['compareWithWorking', 'Compare with Working Tree'],
						['-'],
						['copySha', 'Copy SHA'],
						['copyMessage', 'Copy Message'],
						['openOnRemote', 'Open Commit on Remote'],
						['createPatch', 'Create Patch…'],
						['-'],
						['checkout', ref ? `Checkout ${ref}` : 'Checkout Commit (detached)…'],
						['createBranch', 'Create Branch Here…'],
						['createTag', 'Create Tag Here…'],
						['cherryPick', 'Cherry Pick Commit…'],
						['revert', 'Revert Commit…'],
						['-'],
						['reword', 'Reword…'],
						['drop', 'Drop Commit…'],
						['editPlan', 'Interactive Rebase from Here…'],
					];
		menu.innerHTML = items
			.map(([a, label]) => (a === '-' ? '<div class="sep"></div>' : `<div class="item" data-a="${a}">${esc(label)}</div>`))
			.join('');
		menu.dataset.i = String(i);
		menu.dataset.ref = ref || '';
		menu.classList.remove('hidden');
		menu.style.left = Math.max(0, Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 4)) + 'px';
		menu.style.top = Math.max(0, Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 4)) + 'px';
		render();
	}

	const hideMenu = () => menu.classList.add('hidden');
	const rowIndex = ev => {
		const row = /** @type {HTMLElement} */ (ev.target).closest('.row');
		return row ? +(/** @type {HTMLElement} */ (row).dataset.i) : -1;
	};

	viewport.addEventListener('scroll', () => {
		hideMenu();
		render();
	});
	window.addEventListener('resize', render);
	rowsEl.addEventListener('click', ev => {
		const i = rowIndex(ev);
		if (i >= 0) {
			if (ev.shiftKey && anchor >= 0) {
				const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
				multi = new Set();
				for (let k = a; k <= b; k++) multi.add(k);
				selected = i;
				updateStatus();
				render();
			} else if (ev.ctrlKey || ev.metaKey) {
				if (multi.has(i) && multi.size > 1) multi.delete(i);
				else multi.add(i);
				selected = i;
				anchor = i;
				updateStatus();
				render();
			} else select(i, false);
		}
		viewport.focus();
	});
	rowsEl.addEventListener('dblclick', ev => {
		const i = rowIndex(ev);
		if (i >= 0) action('showCommit', i);
	});
	rowsEl.addEventListener('contextmenu', ev => {
		const i = rowIndex(ev);
		if (i < 0) return;
		ev.preventDefault();
		showMenu(ev, i);
	});
	menu.addEventListener('click', ev => {
		const item = /** @type {HTMLElement} */ (ev.target).closest('.item');
		if (!item) return;
		action(item.getAttribute('data-a'), +(menu.dataset.i || -1), menu.dataset.ref || undefined);
		hideMenu();
	});
	document.addEventListener('click', ev => {
		if (!menu.contains(/** @type {Node} */ (ev.target))) hideMenu();
	});
	document.addEventListener('keydown', ev => {
		if (ev.key === 'Escape') hideMenu();
	});
	viewport.addEventListener('keydown', ev => {
		const page = Math.floor(viewport.clientHeight / ROW_H);
		if (ev.key === 'ArrowDown') select(Math.min(rows.length - 1, selected + 1));
		else if (ev.key === 'ArrowUp') select(Math.max(0, selected - 1));
		else if (ev.key === 'PageDown') select(Math.min(rows.length - 1, selected + page));
		else if (ev.key === 'PageUp') select(Math.max(0, selected - page));
		else if (ev.key === 'Home') select(0);
		else if (ev.key === 'Enter' && selected >= 0) action('showCommit', selected);
		else return;
		ev.preventDefault();
	});

	let searchTimer;
	search.addEventListener('input', () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			query = search.value.trim().toLowerCase();
			matchIndex = -1;
			computeMatches();
			if (matches.length) jump(1);
			else render();
		}, 120);
	});
	search.addEventListener('keydown', ev => {
		if (ev.key === 'Enter') {
			jump(ev.shiftKey ? -1 : 1);
			ev.preventDefault();
		}
	});
	$('next').addEventListener('click', () => jump(1));
	$('prev').addEventListener('click', () => jump(-1));
	$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
	scopeEl.addEventListener('change', () => vscode.postMessage({ type: 'scope', value: scopeEl.value }));

	function setBranches(branches) {
		for (const g of scopeEl.querySelectorAll('optgroup')) g.remove();
		for (const [label, remote] of [['Local', false], ['Remote', true]]) {
			const list = branches.filter(b => b.remote === remote);
			if (!list.length) continue;
			const group = document.createElement('optgroup');
			group.label = label;
			for (const b of list) {
				const opt = document.createElement('option');
				opt.value = 'branch:' + b.name;
				opt.textContent = b.current ? `${b.name} (current)` : b.name;
				group.appendChild(opt);
			}
			scopeEl.appendChild(group);
		}
	}

	window.addEventListener('message', ev => {
		const m = ev.data;
		if (m.type === 'rows') {
			if (m.reset) {
				rows = [];
				selected = -1;
				multi = new Set();
				anchor = -1;
				viewport.scrollTop = 0;
			}
			rows = rows.concat(m.rows);
			head = m.head;
			done = m.done;
			requested = false;
			maxWidth = Math.max(1, m.maxWidth);
			if (m.branches) setBranches(m.branches);
			scopeEl.value = m.scope;
			scopeEl.title = scopeEl.selectedOptions[0]?.textContent || 'Branches to show';
			spacer.style.height = rows.length * ROW_H + 'px';
			document.documentElement.style.setProperty('--graph-w', graphWidth() + 'px');
			if (m.reset) {
				selected = rows.findIndex(r => r.sha === head);
				if (selected >= 0) multi = new Set([selected]);
			}
			computeMatches();
			updateStatus();
			render();
		} else if (m.type === 'error' || m.type === 'empty') {
			requested = false;
			rowsEl.innerHTML = `<div class="message">${esc(m.message)}</div>`;
			$('status').textContent = '';
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
