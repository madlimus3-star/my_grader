/* my_grader frontend */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    problems: [],
    submissions: [],
    stats: { problems: 0, tests: 0, solved: 0, submissions: 0, tags: [] },
    tools: {},
    query: '',
    filter: { tag: null, status: 'all' },
    problem: null,
    tests: [],
    problemSubs: [],
    tab: 'statement',
    editor: null,
    submitting: false,
    reveal: false,
    lastSubmission: null,
    saveTimer: null,
  };

  const TEMPLATE = `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // your code here

    return 0;
}
`;

  /* ---------------- utils ---------------- */

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtBytes = (bytes) => {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  const fmtTime = (ms) => {
    const n = Number(ms) || 0;
    return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`;
  };

  const timeAgo = (iso) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '';
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(iso).toLocaleDateString();
  };

  const VERDICT_TEXT = {
    AC: 'Accepted',
    WA: 'Wrong answer',
    TLE: 'Time limit exceeded',
    RE: 'Runtime error',
    CE: 'Compilation error',
    OLE: 'Output limit exceeded',
    NO_TESTS: 'No tests',
  };
  const VERDICT_ICON = { AC: '✓', WA: '✕', TLE: '⏱', RE: '!', CE: '⚙', OLE: '⇢', NO_TESTS: '·' };

  const toast = (message, kind = '') => {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .2s';
      setTimeout(() => el.remove(), 220);
    }, 3200);
  };

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      ...options,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
    return data;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read the file'));
      reader.readAsDataURL(file);
    });
  }

  function codeKey(id) {
    return `mg:code:${id}`;
  }

  /* ---------------- data ---------------- */

  async function refreshData() {
    const [meta, list, subs] = await Promise.all([
      api('/api/meta'),
      api('/api/problems'),
      api('/api/submissions'),
    ]);
    state.stats = meta.stats;
    state.tools = meta.tools;
    state.problems = list.problems;
    state.submissions = subs.submissions;
    renderEngine();
    renderSidebar();
  }

  function statusOf(problemId) {
    const subs = state.submissions.filter((s) => s.problemId === problemId);
    if (subs.some((s) => s.verdict === 'AC')) return 'solved';
    if (subs.length) return 'attempted';
    return 'none';
  }

  function renderEngine() {
    const el = $('#engine');
    const text = $('#engine-text');
    const ok = state.tools && state.tools.gpp;
    el.classList.toggle('ok', Boolean(ok));
    el.classList.toggle('bad', !ok);
    const version = (state.tools.versions && state.tools.versions.gpp) || '';
    const semver = version.match(/(\d+\.\d+\.\d+)/);
    const short = semver ? `g++ ${semver[1]}` : ok ? 'g++' : 'no compiler';
    text.textContent = ok ? short : 'g++ missing';
    el.title = ok
      ? `${version}\nprlimit: ${state.tools.prlimit ? 'on' : 'off'} · unshare: ${state.tools.unshare ? 'on' : 'off'}`
      : 'Install g++ to enable judging';
  }

  /* ---------------- sidebar ---------------- */

  const ICON_LIST = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h10" stroke-linecap="round"/></svg>';
  const ICON_FOLDER = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';

  function renderSidebar() {
    const tags = state.stats.tags || [];
    const total = state.problems.length;
    const solved = state.problems.filter((p) => statusOf(p.id) === 'solved').length;
    const allActive = !state.filter.tag && state.filter.status === 'all';

    const navItem = (label, meta, act, active, icon = '') => `
      <button class="nav-item ${active ? 'active' : ''}" data-act="${act}" type="button">
        ${icon}<span>${esc(label)}</span><span class="count">${meta}</span>
      </button>`;

    $('#sidebar').innerHTML = `
      <div class="sidebar-scroll">
        <div class="nav-label">Library</div>
        ${navItem('All problems', total, 'filter:all', allActive, ICON_LIST)}
        ${navItem('Solved', solved, 'filter:solved', state.filter.status === 'solved')}
        ${navItem('Unsolved', total - solved, 'filter:unsolved', state.filter.status === 'unsolved')}
        <div class="nav-label">Categories</div>
        ${
          tags.length
            ? tags
                .map((t) =>
                  navItem(t.name, t.count, `tag:${encodeURIComponent(t.name)}`, state.filter.tag === t.name, ICON_FOLDER),
                )
                .join('')
            : '<div style="padding:6px 8px;color:var(--dim);font-size:12px">No tags yet</div>'
        }
      </div>
      <div class="sidebar-foot">
        <div class="foot-stat"><b>${state.stats.problems}</b><span>problems</span></div>
        <div class="foot-stat"><b>${state.stats.tests}</b><span>tests</span></div>
        <div class="foot-stat"><b>${state.stats.solved}</b><span>solved</span></div>
      </div>`;

    $$('#sidebar .nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'filter:all') state.filter = { tag: null, status: 'all' };
        else if (act === 'filter:solved') state.filter = { tag: null, status: 'solved' };
        else if (act === 'filter:unsolved') state.filter = { tag: null, status: 'unsolved' };
        else if (act.startsWith('tag:')) {
          const tag = decodeURIComponent(act.slice(4));
          state.filter = { tag: state.filter.tag === tag ? null : tag, status: 'all' };
        }
        renderSidebar();
        if (state.problem) {
          location.hash = '#/';
        } else {
          renderList();
        }
      });
    });
  }

  /* ---------------- list view ---------------- */

  function filteredProblems() {
    const q = state.query.trim().toLowerCase();
    return state.problems.filter((p) => {
      if (state.filter.tag && !p.tags.includes(state.filter.tag)) return false;
      if (state.filter.status !== 'all') {
        const status = statusOf(p.id);
        if (state.filter.status === 'solved' && status !== 'solved') return false;
        if (state.filter.status === 'unsolved' && status === 'solved') return false;
      }
      if (!q) return true;
      const hay = [p.title, p.id, p.difficulty, ...(p.tags || [])].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function renderList() {
    destroyEditor();
    const items = filteredProblems();
    const title = state.filter.tag
      ? state.filter.tag
      : state.filter.status === 'solved'
        ? 'Solved'
        : state.filter.status === 'unsolved'
          ? 'Unsolved'
          : 'All problems';

    const rows = items
      .map((p) => {
        const status = statusOf(p.id);
        return `
        <div class="prow" data-id="${p.id}" role="button" tabindex="0">
          <div class="prow-status"><span class="status-dot ${status}" title="${status === 'solved' ? 'Solved' : status === 'attempted' ? 'Attempted' : 'Not attempted'}"></span></div>
          <div class="prow-main">
            <div class="prow-title"><span>${esc(p.title)}</span><span class="id">${esc(p.id)}</span></div>
            <div class="prow-meta">
              ${(p.tags || []).map((t) => `<span class="chip chip-tag">${esc(t)}</span>`).join('')}
              <span class="chip chip-${p.difficulty.toLowerCase()}">${esc(p.difficulty)}</span>
              <span>${p.testCount} test${p.testCount === 1 ? '' : 's'}</span>
              <span>${p.statementFile ? 'PDF + statement' : 'no statement'}</span>
            </div>
          </div>
          <div class="prow-side">
            <div class="prow-limits"><span>${(p.timeLimitMs / 1000).toFixed(2)} s</span><span>${p.memoryLimitMb} MB</span></div>
          </div>
        </div>`;
      })
      .join('');

    $('#view').innerHTML = `
      <div class="list-page">
        <div class="page-head">
          <h1>${esc(title)}</h1>
          <p>${items.length} of ${state.problems.length} problems</p>
          <div class="spacer"></div>
          <button class="btn btn-sm" data-act="new" type="button">+ New problem</button>
        </div>
        ${
          items.length
            ? `<div class="problem-list">${rows}</div>`
            : `<div class="empty">
                 <h3>${state.problems.length ? 'Nothing matches this filter' : 'No problems yet'}</h3>
                 <p>${state.problems.length ? 'Try another category or clear the search.' : 'Create your first problem, upload its PDF statement, then add test cases.'}</p>
                 <button class="btn btn-primary" data-act="new" type="button">+ New problem</button>
               </div>`
        }
      </div>`;

    $$('#view .prow').forEach((row) => {
      const open = () => (location.hash = `#/p/${row.dataset.id}`);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
    $$('#view [data-act="new"]').forEach((b) => b.addEventListener('click', () => openProblemModal()));
  }

  /* ---------------- problem view ---------------- */

  async function openProblem(id, tab) {
    destroyEditor();
    $('#view').innerHTML = `<div class="empty" style="margin:30px"><h3>Loading…</h3></div>`;
    try {
      const [problem, tests, subs] = await Promise.all([
        api(`/api/problems/${id}`),
        api(`/api/problems/${id}/tests`),
        api(`/api/problems/${id}/submissions`),
      ]);
      state.problem = problem;
      state.tests = tests.tests;
      state.problemSubs = subs.submissions;
      state.tab = tab || 'statement';
      state.lastSubmission = null;
      state.reveal = false;
      renderProblem();
    } catch (err) {
      $('#view').innerHTML = `<div class="empty" style="margin:30px"><h3>Problem not found</h3><p>${esc(err.message)}</p><a class="btn" href="#/">Back to problems</a></div>`;
    }
  }

  function renderProblem() {
    const p = state.problem;
    if (!p) return;
    $('#view').innerHTML = `
      <div class="problem">
        <div class="phead">
          <div class="crumbs"><a href="#/">Problems</a><span>/</span><span>${esc(p.id)}</span></div>
          <div class="phead-row">
            <div>
              <div class="id">${esc(p.id)}</div>
              <h1>${esc(p.title)}</h1>
              <div class="phead-tags">
                ${(p.tags || []).map((t) => `<span class="chip chip-tag">${esc(t)}</span>`).join('')}
                <span class="chip chip-${p.difficulty.toLowerCase()}">${esc(p.difficulty)}</span>
              </div>
            </div>
            <div class="phead-actions">
              <button class="btn btn-sm" data-act="edit" type="button">Edit</button>
              <button class="btn btn-sm btn-danger" data-act="delete" type="button">Delete</button>
            </div>
          </div>
          <div class="pmeta">
            <span>Time <b>${(p.timeLimitMs / 1000).toFixed(2)} s</b></span>
            <span class="sep"></span>
            <span>Memory <b>${p.memoryLimitMb} MB</b></span>
            <span class="sep"></span>
            <span>Tests <b>${p.testCount}</b> (${p.sampleCount} sample)</span>
            <span class="sep"></span>
            <span>Updated <b>${timeAgo(p.updatedAt)}</b></span>
          </div>
        </div>
        <div class="tabs">
          ${tabButton('statement', 'Statement')}
          ${tabButton('solve', 'Solve')}
          ${tabButton('tests', 'Test cases', state.tests.length)}
          ${tabButton('subs', 'Submissions', state.problemSubs.length)}
        </div>
        <div class="tab-body" id="tab-body"></div>
      </div>`;

    $$('#view .tab').forEach((tabEl) =>
      tabEl.addEventListener('click', () => {
        state.tab = tabEl.dataset.tab;
        history.replaceState(null, '', `#/p/${p.id}?tab=${state.tab}`);
        $$('#view .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
        renderTabBody();
      }),
    );
    $('[data-act="edit"]').addEventListener('click', () => openProblemModal(p));
    $('[data-act="delete"]').addEventListener('click', () => deleteProblem(p));

    renderTabBody();
  }

  function tabButton(id, label, count) {
    return `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}" type="button">${label}${
      count !== undefined ? `<span class="tcount">${count}</span>` : ''
    }</button>`;
  }

  function renderTabBody() {
    const body = $('#tab-body');
    if (!body) return;
    destroyEditor();
    if (state.tab === 'statement') renderStatementTab(body);
    else if (state.tab === 'solve') renderSolveTab(body);
    else if (state.tab === 'tests') renderTestsTab(body);
    else renderSubsTab(body);
  }

  /* ---------------- statement ---------------- */

  function renderStatementTab(body) {
    const p = state.problem;
    if (!p.statementFile) {
      body.innerHTML = `
        <div class="statement-missing">
          <div class="empty" style="max-width:460px">
            <h3>No statement uploaded</h3>
            <p>Upload the problem PDF (or an image of it) and it will render right here.</p>
            <button class="btn btn-primary" data-act="upload" type="button">Upload PDF</button>
          </div>
        </div>`;
      attachUpload(body);
      return;
    }
    body.innerHTML = `
      <div class="statement-wrap">
        <div class="statement-bar">
          <span class="name">${esc(p.statementName || p.statementFile)}</span>
          <span class="chip chip-dim">${fmtBytes(p.statementBytes)}</span>
          <div class="spacer"></div>
          <a class="btn btn-sm" href="/api/problems/${p.id}/statement" target="_blank" rel="noopener">Open</a>
          <a class="btn btn-sm" href="/api/problems/${p.id}/statement" download="${esc(p.statementName || 'statement.pdf')}">Download</a>
          <button class="btn btn-sm" data-act="upload" type="button">Replace</button>
        </div>
        <div class="statement-frame">
          ${
            /\.(png|jpe?g|webp)$/i.test(p.statementFile)
              ? `<img src="/api/problems/${p.id}/statement" alt="Statement" style="max-width:100%;border:1px solid var(--line);border-radius:10px">`
              : `<object data="/api/problems/${p.id}/statement#view=FitH" type="application/pdf">
                   <div class="empty"><h3>PDF cannot be embedded</h3><p><a href="/api/problems/${p.id}/statement" target="_blank" rel="noopener">Open the statement in a new tab</a></p></div>
                 </object>`
          }
        </div>
      </div>`;
    attachUpload(body);
  }

  function attachUpload(body) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,image/png,image/jpeg,image/webp';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        const base64 = await fileToBase64(file);
        const updated = await api(`/api/problems/${state.problem.id}/statement`, {
          method: 'POST',
          body: JSON.stringify({ base64, name: file.name }),
        });
        state.problem = updated;
        toast('Statement uploaded', 'ok');
        renderProblem();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    $$('[data-act="upload"]', body).forEach((b) => b.addEventListener('click', () => input.click()));
  }

  /* ---------------- solve ---------------- */

  function renderSolveTab(body) {
    const p = state.problem;
    body.innerHTML = `
      <div class="solve">
        <div class="editor-pane">
          <div class="editor-bar">
            <span class="file"><span style="color:var(--dim)">~/</span>main.cpp</span>
            <span class="lang">C++17</span>
            <div class="spacer"></div>
            <button class="btn btn-sm" data-act="reset" type="button" title="Restore the starter template">Reset</button>
            <button class="btn btn-sm" data-act="samples" type="button">Run samples</button>
            <button class="btn btn-sm btn-primary" data-act="submit" type="button">Submit</button>
          </div>
          <div class="editor-host" id="editor-host"></div>
          <div class="editor-foot">
            <span><span class="kbd">Ctrl</span> + <span class="kbd">Enter</span> run samples</span>
            <span><span class="kbd">Ctrl</span> + <span class="kbd">Shift</span> + <span class="kbd">Enter</span> submit</span>
            <div class="spacer"></div>
            <span id="save-state">saved locally</span>
          </div>
        </div>
        <aside class="result-pane">
          <div class="result-head">
            <h3>Result</h3>
            <div class="spacer"></div>
            <span class="vbadge v-NO_TESTS" id="result-verdict" hidden></span>
          </div>
          <div class="result-body" id="result-body">
            <div class="hint">Run the samples to check your code, or submit to grade every test case.</div>
          </div>
        </aside>
      </div>`;

    const saved = localStorage.getItem(codeKey(p.id));
    const host = $('#editor-host');
    state.editor = CodeMirror(host, {
      value: saved !== null ? saved : TEMPLATE,
      mode: 'text/x-c++src',
      theme: 'mg',
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      smartIndent: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      extraKeys: {
        'Ctrl-Enter': () => runJudge('sample'),
        'Cmd-Enter': () => runJudge('sample'),
        'Ctrl-Shift-Enter': () => runJudge('all'),
        'Cmd-Shift-Enter': () => runJudge('all'),
        Tab: (cm) => cm.replaceSelection('    ', 'end'),
      },
    });
    state.editor.on('change', () => {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        localStorage.setItem(codeKey(p.id), state.editor.getValue());
        const el = $('#save-state');
        if (el) el.textContent = 'saved locally';
      }, 400);
    });

    $('[data-act="samples"]').addEventListener('click', () => runJudge('sample'));
    $('[data-act="submit"]').addEventListener('click', () => runJudge('all'));
    $('[data-act="reset"]').addEventListener('click', () => {
      if (!confirm('Replace the editor content with the starter template?')) return;
      state.editor.setValue(TEMPLATE);
      localStorage.removeItem(codeKey(p.id));
    });

    if (state.lastSubmission) renderResult(state.lastSubmission);
    else loadLatestSubmission();
  }

  async function loadLatestSubmission() {
    if (!state.problemSubs.length) return;
    try {
      const sub = await api(`/api/submissions/${state.problemSubs[0].id}?problemId=${state.problem.id}`);
      if (state.tab === 'solve' && !state.lastSubmission) {
        state.lastSubmission = sub;
        renderResult(sub);
      }
    } catch {
      /* ignore */
    }
  }

  async function runJudge(mode) {
    if (state.submitting || !state.editor) return;
    state.submitting = true;
    const buttons = $$('[data-act="submit"], [data-act="samples"]');
    buttons.forEach((b) => (b.disabled = true));
    const body = $('#result-body');
    if (body) body.innerHTML = `<div class="hint">Compiling and running…</div>`;
    try {
      const sub = await api(`/api/problems/${state.problem.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ code: state.editor.getValue(), mode, reveal: state.reveal }),
      });
      state.lastSubmission = sub;
      renderResult(sub);
      const summary = {
        id: sub.id,
        problemId: sub.problemId,
        verdict: sub.verdict,
        mode: sub.mode,
        timeMs: sub.timeMs,
        passed: sub.passed,
        total: sub.total,
        createdAt: sub.createdAt,
      };
      state.problemSubs.unshift(summary);
      state.submissions.unshift(summary);
      renderSidebar();
    } catch (err) {
      if (body) body.innerHTML = `<div class="hint" style="color:var(--wa)">${esc(err.message)}</div>`;
      toast(err.message, 'err');
    } finally {
      state.submitting = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function renderResult(sub) {
    const body = $('#result-body');
    if (!body) return;
    const badge = $('#result-verdict');
    if (badge) {
      badge.hidden = false;
      badge.className = `vbadge v-${sub.verdict}`;
      badge.textContent = sub.verdict;
    }
    const verdictClass = `v-${sub.verdict}`;
    const testsHtml = (sub.tests || [])
      .map((t) => {
        const hasDetail = Object.prototype.hasOwnProperty.call(t, 'input');
        return `
        <details class="test-row">
          <summary>
            <span class="vbadge v-${t.verdict}">${t.verdict}</span>
            <span class="tname">Test ${esc(t.id)}</span>
            ${t.sample ? '<span class="chip chip-sample">sample</span>' : ''}
            <span class="tmeta">${fmtTime(t.timeMs)}</span>
          </summary>
          <div class="test-detail">
            ${
              hasDetail
                ? `
                <div class="io-block"><label>Input</label><pre>${esc(t.input || '(empty)')}</pre></div>
                <div class="io-block"><label>Expected</label><pre>${esc(t.expected || '(empty)')}</pre></div>
                <div class="io-block"><label>Your output</label><pre>${esc(t.stdout || '(empty)')}</pre></div>
                ${t.stderr ? `<div class="io-block"><label>Stderr</label><pre>${esc(t.stderr)}</pre></div>` : ''}
              `
                : '<div class="hint">Hidden test. Turn on “show hidden test data” and submit again to inspect it.</div>'
            }
          </div>
        </details>`;
      })
      .join('');

    body.innerHTML = `
      <div class="verdict ${verdictClass}">
        <div class="vicon">${VERDICT_ICON[sub.verdict] || '?'}</div>
        <div>
          <div class="vlabel">${VERDICT_TEXT[sub.verdict] || sub.verdict}</div>
          <div class="vsub">${sub.passed} / ${sub.total} tests · ${fmtTime(sub.timeMs)}</div>
        </div>
      </div>
      ${sub.compileOutput ? `<div class="compile-box"><pre>${esc(sub.compileOutput)}</pre></div>` : ''}
      <label class="reveal-row"><input type="checkbox" id="reveal-toggle" ${state.reveal ? 'checked' : ''}> show hidden test data</label>
      ${testsHtml || '<div class="hint">No test cases ran.</div>'}`;

    const toggle = $('#reveal-toggle');
    if (toggle) {
      toggle.addEventListener('change', () => {
        state.reveal = toggle.checked;
        toast('Submit again to see hidden test data');
      });
    }
    $$('.test-row', body).forEach((row) => row.addEventListener('toggle', () => {
      /* details handled natively */
    }));
  }

  /* ---------------- test cases ---------------- */

  function renderTestsTab(body) {
    const p = state.problem;
    body.innerHTML = `
      <div class="tc-page">
        <div class="row" style="margin-bottom:4px">
          <div>
            <div style="font-weight:600">${state.tests.length} test case${state.tests.length === 1 ? '' : 's'}</div>
            <div class="hint">Sample tests are shown with the problem and can be run without submitting.</div>
          </div>
          <div class="spacer"></div>
          <button class="btn btn-sm" data-act="import" type="button">Import .in/.out pairs</button>
        </div>

        <div class="tc-list" id="tc-list">
          ${
            state.tests.length
              ? state.tests
                  .map(
                    (t) => `
            <details class="test-row" data-tid="${t.id}">
              <summary>
                <span class="tname">Test ${esc(t.id)}</span>
                ${t.sample ? '<span class="chip chip-sample">sample</span>' : '<span class="chip chip-dim">hidden</span>'}
                <span class="tmeta">view</span>
              </summary>
              <div class="test-detail">
                <div class="row">
                  <label class="check"><input type="checkbox" data-act="sample" ${t.sample ? 'checked' : ''}> sample test</label>
                  <div class="spacer"></div>
                  <button class="btn btn-sm btn-danger" data-act="del" type="button">Delete</button>
                </div>
                <div class="io-block"><label>Input</label><pre data-slot="in">loading…</pre></div>
                <div class="io-block"><label>Expected output</label><pre data-slot="out">loading…</pre></div>
              </div>
            </details>`,
                  )
                  .join('')
              : '<div class="empty" style="padding:26px"><h3>No test cases</h3><p>Add one below, or import a folder of .in/.out files.</p></div>'
          }
        </div>

        <div class="section-title">Add a test case</div>
        <div class="tc-grid">
          <div class="field">
            <label for="new-in">Input</label>
            <textarea class="textarea" id="new-in" spellcheck="false" placeholder="2&#10;4&#10;1"></textarea>
          </div>
          <div class="field">
            <label for="new-out">Expected output</label>
            <textarea class="textarea" id="new-out" spellcheck="false" placeholder="4"></textarea>
          </div>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" id="new-sample" checked> mark as sample</label>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-act="add" type="button">Add test case</button>
        </div>
      </div>`;

    $$('#tc-list details').forEach((det) => {
      det.addEventListener('toggle', async () => {
        if (!det.open || det.dataset.loaded) return;
        det.dataset.loaded = '1';
        try {
          const test = await api(`/api/problems/${p.id}/tests/${det.dataset.tid}`);
          $('[data-slot="in"]', det).textContent = test.input || '(empty)';
          $('[data-slot="out"]', det).textContent = test.expected || '(empty)';
        } catch (err) {
          $('[data-slot="in"]', det).textContent = err.message;
        }
      });
    });

    $$('#tc-list [data-act="sample"]').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        const det = checkbox.closest('details');
        try {
          await api(`/api/problems/${p.id}/tests/${det.dataset.tid}`, {
            method: 'PATCH',
            body: JSON.stringify({ sample: checkbox.checked }),
          });
          await reloadProblem();
          renderTabBody();
          toast('Test updated', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    });

    $$('#tc-list [data-act="del"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const det = btn.closest('details');
        const ok = await confirmModal('Delete test case', `Test ${det.dataset.tid} will be removed permanently.`);
        if (!ok) return;
        try {
          await api(`/api/problems/${p.id}/tests/${det.dataset.tid}`, { method: 'DELETE' });
          await reloadProblem();
          renderTabBody();
          toast('Test deleted', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    });

    $('[data-act="add"]').addEventListener('click', async () => {
      try {
        await api(`/api/problems/${p.id}/tests`, {
          method: 'POST',
          body: JSON.stringify({
            input: $('#new-in').value,
            expected: $('#new-out').value,
            sample: $('#new-sample').checked,
          }),
        });
        await reloadProblem();
        renderTabBody();
        toast('Test case added', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    $('[data-act="import"]').addEventListener('click', () => importPairs(p));
  }

  function importPairs(p) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.in,.out,.txt,text/plain';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const files = [...(input.files || [])];
      input.remove();
      if (!files.length) return;
      const groups = new Map();
      for (const file of files) {
        const base = file.name.replace(/\.(in|out|ans|txt)$/i, '');
        if (!groups.has(base)) groups.set(base, {});
        const slot = /\.(out|ans)$/i.test(file.name) ? 'out' : 'in';
        groups.get(base)[slot] = await file.text();
      }
      const tests = [...groups.values()]
        .filter((g) => g.in !== undefined && g.out !== undefined)
        .map((g) => ({ input: g.in, expected: g.out, sample: false }));
      if (!tests.length) {
        toast('No matching .in/.out pairs found', 'err');
        return;
      }
      try {
        await api(`/api/problems/${p.id}/tests/bulk`, { method: 'POST', body: JSON.stringify({ tests }) });
        await reloadProblem();
        renderTabBody();
        toast(`Imported ${tests.length} test case${tests.length === 1 ? '' : 's'}`, 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    input.click();
  }

  /* ---------------- submissions ---------------- */

  function renderSubsTab(body) {
    const p = state.problem;
    if (!state.problemSubs.length) {
      body.innerHTML = `<div class="empty" style="margin:26px"><h3>No submissions yet</h3><p>Open the Solve tab and submit your code.</p><button class="btn" data-act="go-solve" type="button">Go to editor</button></div>`;
      $('[data-act="go-solve"]').addEventListener('click', () => {
        state.tab = 'solve';
        history.replaceState(null, '', `#/p/${p.id}?tab=solve`);
        $$('#view .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'solve'));
        renderTabBody();
      });
      return;
    }
    body.innerHTML = `
      <div class="subs-page">
        ${state.problemSubs
          .map(
            (s) => `
          <div class="sub-row" data-sid="${s.id}" role="button" tabindex="0">
            <span class="vbadge v-${s.verdict}">${s.verdict}</span>
            <span class="mono">${s.passed}/${s.total} tests · ${s.mode === 'sample' ? 'samples' : 'full'} · ${fmtTime(s.timeMs)}</span>
            <span class="mono hide-sm">${fmtTime(s.timeMs)}</span>
            <span class="mono hide-sm">${s.mode}</span>
            <span class="when">${timeAgo(s.createdAt)}</span>
          </div>`,
          )
          .join('')}
      </div>`;

    $$('.sub-row').forEach((row) => {
      const open = async () => {
        try {
          const sub = await api(`/api/submissions/${row.dataset.sid}?problemId=${p.id}`);
          state.lastSubmission = sub;
          state.tab = 'solve';
          history.replaceState(null, '', `#/p/${p.id}?tab=solve`);
          $$('#view .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'solve'));
          renderTabBody();
          if (state.editor && sub.code) {
            state.editor.setValue(sub.code);
            localStorage.setItem(codeKey(p.id), sub.code);
          }
        } catch (err) {
          toast(err.message, 'err');
        }
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') open();
      });
    });
  }

  /* ---------------- problem modal ---------------- */

  function openProblemModal(problem = null) {
    const isEdit = Boolean(problem);
    const allTags = (state.stats.tags || []).map((t) => t.name);
    const p = problem || {
      title: '',
      tags: [],
      difficulty: 'Easy',
      timeLimitMs: 1000,
      memoryLimitMb: 256,
    };
    let selectedTags = [...(p.tags || [])];
    let statementFile = null;

    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop" data-act="backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>${isEdit ? 'Edit problem' : 'New problem'}</h2>
            <div class="spacer"></div>
            <button class="btn btn-ghost btn-sm" data-act="close" type="button">✕</button>
          </div>
          <div class="modal-body">
            <div class="field">
              <label for="f-title">Title</label>
              <input class="input" id="f-title" value="${esc(p.title)}" placeholder="A1-003 — Maximum of three" autofocus>
            </div>
            <div class="field">
              <label for="f-tags">Categories</label>
              <input class="input" id="f-tags" value="${esc(selectedTags.join(', '))}" placeholder="TOI Zero, Array">
              <div class="tag-picker" id="tag-picker">
                ${allTags.map((t) => `<button class="tag-opt ${selectedTags.includes(t) ? 'on' : ''}" data-tag="${esc(t)}" type="button">${esc(t)}</button>`).join('')}
              </div>
            </div>
            <div class="row" style="align-items:flex-start">
              <div class="field" style="flex:1">
                <label for="f-diff">Difficulty</label>
                <select class="select" id="f-diff">
                  ${['Easy', 'Medium', 'Hard'].map((d) => `<option ${p.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}
                </select>
              </div>
              <div class="field" style="flex:1">
                <label for="f-time">Time limit (ms)</label>
                <input class="input" id="f-time" type="number" min="200" max="20000" step="100" value="${p.timeLimitMs}">
              </div>
              <div class="field" style="flex:1">
                <label for="f-mem">Memory (MB)</label>
                <input class="input" id="f-mem" type="number" min="32" max="4096" step="32" value="${p.memoryLimitMb}">
              </div>
            </div>
            ${
              isEdit
                ? ''
                : `<div class="field">
                    <label>Statement (PDF, optional)</label>
                    <div class="dropzone" id="dropzone" tabindex="0">
                      <b>Drop the PDF here</b> or click to choose a file
                      <span class="file-name" id="file-name"></span>
                    </div>
                  </div>`
            }
          </div>
          <div class="modal-foot">
            <div class="spacer"></div>
            <button class="btn" data-act="close" type="button">Cancel</button>
            <button class="btn btn-primary" data-act="save" type="button">${isEdit ? 'Save changes' : 'Create problem'}</button>
          </div>
        </div>
      </div>`;

    const close = () => (root.innerHTML = '');
    $$('[data-act="close"]', root).forEach((b) => b.addEventListener('click', close));
    $('[data-act="backdrop"]', root).addEventListener('click', (e) => {
      if (e.target === $('[data-act="backdrop"]', root)) close();
    });

    $$('#tag-picker .tag-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        selectedTags = selectedTags.includes(tag) ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag];
        btn.classList.toggle('on');
        $('#f-tags').value = selectedTags.join(', ');
      });
    });

    if (!isEdit) {
      const zone = $('#dropzone');
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,image/png,image/jpeg,image/webp';
      input.style.display = 'none';
      document.body.appendChild(input);
      const choose = () => input.click();
      zone.addEventListener('click', choose);
      zone.addEventListener('keydown', (e) => e.key === 'Enter' && choose());
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('over');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        if (e.dataTransfer.files[0]) {
          statementFile = e.dataTransfer.files[0];
          $('#file-name').textContent = statementFile.name;
        }
      });
      input.addEventListener('change', () => {
        if (input.files[0]) {
          statementFile = input.files[0];
          $('#file-name').textContent = statementFile.name;
        }
      });
      root.addEventListener('remove', () => input.remove());
    }

    $('[data-act="save"]', root).addEventListener('click', async () => {
      const title = $('#f-title').value.trim();
      if (!title) {
        toast('Give the problem a title', 'err');
        return;
      }
      const tags = $('#f-tags')
        .value.split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .concat(selectedTags)
        .filter((t, i, arr) => arr.indexOf(t) === i);
      const payload = {
        title,
        tags,
        difficulty: $('#f-diff').value,
        timeLimitMs: Number($('#f-time').value),
        memoryLimitMb: Number($('#f-mem').value),
      };
      try {
        if (isEdit) {
          const updated = await api(`/api/problems/${problem.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
          state.problem = updated;
          close();
          await refreshData();
          renderProblem();
          toast('Problem saved', 'ok');
        } else {
          if (statementFile) {
            payload.statement = { base64: await fileToBase64(statementFile), name: statementFile.name };
          }
          const created = await api('/api/problems', { method: 'POST', body: JSON.stringify(payload) });
          close();
          await refreshData();
          location.hash = `#/p/${created.id}?tab=tests`;
          toast('Problem created — add some test cases', 'ok');
        }
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  function confirmModal(title, message) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      root.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal" style="max-width:420px">
            <div class="modal-head"><h2>${esc(title)}</h2></div>
            <div class="modal-body"><p style="margin:0;color:var(--muted)">${esc(message)}</p></div>
            <div class="modal-foot">
              <div class="spacer"></div>
              <button class="btn" data-act="no" type="button">Cancel</button>
              <button class="btn btn-danger" data-act="yes" type="button">Delete</button>
            </div>
          </div>
        </div>`;
      const done = (value) => {
        root.innerHTML = '';
        resolve(value);
      };
      $('[data-act="no"]', root).addEventListener('click', () => done(false));
      $('[data-act="yes"]', root).addEventListener('click', () => done(true));
    });
  }

  async function deleteProblem(p) {
    const ok = await confirmModal('Delete problem', `“${p.title}” and all of its test cases and submissions will be removed.`);
    if (!ok) return;
    try {
      await api(`/api/problems/${p.id}`, { method: 'DELETE' });
      state.problem = null;
      location.hash = '#/';
      await refreshData();
      toast('Problem deleted', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function reloadProblem() {
    const [problem, tests] = await Promise.all([
      api(`/api/problems/${state.problem.id}`),
      api(`/api/problems/${state.problem.id}/tests`),
    ]);
    state.problem = problem;
    state.tests = tests.tests;
    const tab = $('#view .tab[data-tab="tests"] .tcount');
    if (tab) tab.textContent = state.tests.length;
    $$('#view .tab').forEach((t) => {
      if (t.dataset.tab === 'tests') {
        let count = t.querySelector('.tcount');
        if (!count) {
          count = document.createElement('span');
          count.className = 'tcount';
          t.appendChild(count);
        }
        count.textContent = state.tests.length;
      }
    });
    await refreshData();
  }

  /* ---------------- routing ---------------- */

  function destroyEditor() {
    if (state.editor) {
      const wrapper = state.editor.getWrapperElement();
      if (wrapper && wrapper.parentNode) wrapper.remove();
      state.editor = null;
    }
  }

  async function route() {
    const hash = location.hash || '#/';
    const match = hash.match(/^#\/p\/([a-z0-9-]{1,64})(?:\?tab=(statement|solve|tests|subs))?/);
    if (match) {
      await openProblem(match[1], match[2] || 'statement');
      return;
    }
    state.problem = null;
    renderList();
  }

  /* ---------------- boot ---------------- */

  $('#q').addEventListener('input', (e) => {
    state.query = e.target.value;
    if (!state.problem) renderList();
    else location.hash = '#/';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('#q') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $('#q').focus();
      $('#q').select();
    }
    if (e.key === 'Escape') {
      const backdrop = $('.modal-backdrop');
      if (backdrop) $('#modal-root').innerHTML = '';
    }
  });

  $('#new-problem').addEventListener('click', () => openProblemModal());
  window.addEventListener('hashchange', route);

  (async () => {
    try {
      await refreshData();
    } catch (err) {
      toast(err.message, 'err');
    }
    await route();
  })();
})();
