/* Login, then the Trial of the Rising Sun.  The shrine (the server) draws the questions, grades them and decides the
   clearance; this page only shows them. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const screen = $('#screen');

  const RANKS = [
    ['ASHIGARU', '足軽', 1, 50, 'foot soldier of the ranks'],
    ['SAMURAI', '侍', 2, 65, 'sworn blade of a lord'],
    ['DAIMYO', '大名', 3, 80, 'lord of a domain'],
    ['SHOGUN', '将軍', 4, 93, 'supreme commander of the realm'],
  ];
  const KANJI = { RONIN: '浪人', ASHIGARU: '足軽', SAMURAI: '侍', DAIMYO: '大名', SHOGUN: '将軍' };

  let me = null;                         // /api/auth/status
  let trial = null, secIdx = 0, ans = [], deadline = 0, tick = null, tab = 'login', retryTimer = null;

  async function api(path, body) {
    const res = await fetch('/api/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let data = {};
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) { const err = new Error(data.error || 'The shrine did not answer.'); err.status = res.status; err.retryIn = data.retryIn || 0; throw err; }
    return data;
  }
  const status = async () => (await fetch('/api/auth/status', { cache: 'no-store' })).json();
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const bar = (pct, n = 20) => { const f = Math.round(pct / 100 * n); return '█'.repeat(f) + '░'.repeat(n - f); };
  const foot = (t) => { $('#footMsg').textContent = '> ' + t; };

  // ------------------------------------------------------------------ login / register
  function viewAuth(err) {
    clearInterval(tick);
    const reg = tab === 'register';
    screen.innerHTML = `
      <h1 class="lg-h">&gt; IDENTIFY YOURSELF, OPERATOR</h1>
      <div class="lg-tabs" role="tablist">
        <button class="lg-tab ${reg ? '' : 'on'}" data-tab="login" role="tab">[ LOG IN ]</button>
        <button class="lg-tab ${reg ? 'on' : ''}" data-tab="register" role="tab">[ NEW OPERATOR ]</button>
      </div>
      <form id="authForm" autocomplete="off">
        <label class="lg-field"><span>CALLSIGN</span><input class="lg-input" id="fName" maxlength="16" spellcheck="false" autocomplete="username" autofocus></label>
        <label class="lg-field"><span>PASSCODE</span><input class="lg-input" id="fPass" type="password" maxlength="64" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
        ${reg ? '<label class="lg-field"><span>REPEAT PASSCODE</span><input class="lg-input" id="fPass2" type="password" maxlength="64" autocomplete="new-password"></label>' : ''}
        <div id="authErr">${err ? `<div class="lg-err">&gt; ${esc(err)}</div>` : ''}</div>
        <p class="lg-p">${reg
          ? 'Pick a callsign (3-16 letters, digits, <b>. - _</b>) and a passcode of 4+ characters. They live only on this computer, the passcode salted and hashed. Your callsign becomes your player name. A new operator has <b>no clearance</b> until the trial is passed.'
          : 'Already an operator? Log in, then prove your clearance. Returning operators keep the rank they earned.'}</p>
        <div class="lg-row"><button class="lg-btn big" type="submit" id="authGo">${reg ? '[ REGISTER ]' : '[ LOG IN ]'}</button></div>
      </form>`;
    foot('CLEARANCE IS GRADED BY THE SHRINE (THIS COMPUTER), NOT BY THIS PAGE.');
    $('#fName').focus();
  }

  async function submitAuth(e) {
    e.preventDefault();
    const name = $('#fName').value.trim(), pass = $('#fPass').value;
    const reg = tab === 'register';
    const fail = (m) => { $('#authErr').innerHTML = `<div class="lg-err">&gt; ${esc(m)}</div>`; };
    if (!name || !pass) return fail('Enter a callsign and a passcode.');
    if (reg && pass !== $('#fPass2').value) return fail('The two passcodes differ.');
    $('#authGo').disabled = true;
    try {
      me = await api(reg ? 'register' : 'login', { name, pass });
      route();
    } catch (err) {
      $('#authGo').disabled = false;
      fail(err.retryIn ? `${err.message} (${err.retryIn}s)` : err.message);
    }
  }

  // ------------------------------------------------------------------ briefing
  function route() { me.cleared ? viewWelcome() : viewBrief(); }

  function ladder() {
    return `<div class="lg-ranks">${RANKS.map(([n, k, l, pct, d]) => `<div class="lg-rank"><b>${n}</b><span lang="ja">${k}</span> &middot; level ${l}<br><em>${pct}%+</em> &middot; ${esc(d)}</div>`).join('')}</div>`;
  }

  function viewWelcome() {
    screen.innerHTML = `
      <h1 class="lg-h">&gt; WELCOME BACK, <span class="lg-gold">${esc(me.name.toUpperCase())}</span></h1>
      <div class="rs-rank"><div class="rs-kanji" lang="ja">${KANJI[me.rank] || ''}</div><div class="rs-name pass">${esc(me.rank)}</div><div class="rs-pct">CLEARANCE LEVEL ${me.level} // BEST TRIAL ${me.pct}%</div></div>
      <p class="lg-p" style="text-align:center">The shrine remembers you. You may enter as you are, or sit the trial again to climb the ranks. A lower score never costs you a rank.</p>
      <div class="lg-row" style="justify-content:center"><button class="lg-btn big" data-go="enter">[ ENTER G3 ]</button><button class="lg-btn" data-go="brief">[ RETAKE THE TRIAL ]</button><button class="lg-btn" data-go="logout">[ NOT ME: LOG OUT ]</button></div>`;
    foot(`CLEARANCE ${me.level} // ${me.rank}`);
  }

  function viewBrief(err) {
    clearInterval(retryTimer);
    const wait = me.retryIn || 0;
    screen.innerHTML = `
      <h1 class="lg-h">&gt; THE TRIAL OF THE RISING SUN</h1>
      <p class="lg-p">Operator <b>${esc(me.name)}</b>, the launcher is sealed. Beyond the gate lie the games, and the keeper of the gate asks only that you know the <b lang="ja">日出づる国</b>, <b>the Land of the Rising Sun</b>.</p>
      <p class="lg-p">You will face <b>six scrolls</b> of six questions: myth, symbols, history, warriors, folklore and the arts of Japan. Questions are drawn at random and the choices shuffled each time. Some ask you to pick one answer, some to pick <b>all</b> that apply, and some to <b>write</b> the word yourself. You have <b>45 minutes</b>. The shrine marks harder questions higher.</p>
      ${ladder()}
      <p class="lg-p">Score under <span class="lg-red">50%</span> and you are a <b>RONIN</b>: no entry, and the shrine is closed to you for <b>60 seconds</b>. Your best rank is kept.</p>
      ${err ? `<div class="lg-err">&gt; ${esc(err)}</div>` : ''}
      <div class="lg-row end">
        <button class="lg-btn big sun" id="beginBtn" data-go="begin" ${wait ? 'disabled' : ''}>${wait ? `[ CLOSED: ${wait}s ]` : '[ BEGIN THE TRIAL ]'}</button>
        <button class="lg-btn" data-go="logout">[ LOG OUT ]</button>
      </div>`;
    foot('NO RANK, NO ENTRY.');
    if (wait) {
      let left = wait;
      retryTimer = setInterval(() => {
        left -= 1;
        const b = $('#beginBtn'); if (!b) return clearInterval(retryTimer);
        if (left <= 0) { clearInterval(retryTimer); me.retryIn = 0; b.disabled = false; b.textContent = '[ BEGIN THE TRIAL ]'; } else b.textContent = `[ CLOSED: ${left}s ]`;
      }, 1000);
    }
  }

  // ------------------------------------------------------------------ the trial
  async function begin() {
    try {
      trial = await api('quiz');
    } catch (err) {
      if (err.status === 401) { me = null; return viewAuth('Your session ended. Log in again.'); }
      if (err.retryIn) me.retryIn = err.retryIn;
      return viewBrief(err.message);
    }
    secIdx = 0; ans = new Array(trial.total).fill(null);
    deadline = Date.now() + trial.minutes * 60000;
    clearInterval(tick);
    tick = setInterval(updateTimer, 1000);
    viewScroll();
  }

  const qsOf = (sid) => trial.questions.filter((q) => q.s === sid);
  const answered = (q) => { const a = ans[q.n]; return q.t === 'multi' ? Array.isArray(a) && a.length > 0 : q.t === 'text' ? typeof a === 'string' && a.trim() !== '' : a !== null; };

  function updateTimer() {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const el = $('#trTime'); if (el) { el.textContent = mmss(left); el.style.color = left < 300 ? '#FF3366' : ''; }
    if (left === 0) { clearInterval(tick); submit(true); }
  }

  function viewScroll(warn) {
    const sec = trial.sections[secIdx], qs = qsOf(sec.id), done = trial.questions.filter(answered).length;
    const last = secIdx === trial.sections.length - 1;
    screen.innerHTML = `
      <div class="tr-top"><span>SCROLL ${secIdx + 1} OF ${trial.sections.length}</span><span>ANSWERED ${done}/${trial.total}</span><span>TIME <b id="trTime">${mmss(Math.max(0, Math.round((deadline - Date.now()) / 1000)))}</b></span></div>
      <div class="tr-bar">[${bar(done / trial.total * 100, 36)}]</div>
      <div class="tr-scroll">
        <h2 class="tr-sectitle">${esc(sec.title)}</h2><div class="tr-secsub">${esc(sec.sub)}</div>
        ${qs.map(renderQ).join('')}
      </div>
      ${warn ? `<div class="lg-note">&gt; ${esc(warn)}</div>` : ''}
      <div class="lg-row end">
        <button class="lg-btn" data-go="prev" ${secIdx === 0 ? 'disabled' : ''}>[ &lt; PREVIOUS SCROLL ]</button>
        ${last ? '<button class="lg-btn big sun" data-go="submit">[ SUBMIT TO THE SHRINE ]</button>' : '<button class="lg-btn big" data-go="next">[ NEXT SCROLL &gt; ]</button>'}
      </div>`;
    foot(`SCROLL ${secIdx + 1}/${trial.sections.length}: ${sec.title}`);
    window.scrollTo({ top: 0 });
  }

  function renderQ(q) {
    const a = ans[q.n];
    let body = '';
    if (q.t === 'text') {
      body = `<input class="lg-input" data-q="${q.n}" value="${esc(a || '')}" maxlength="80" spellcheck="false" autocomplete="off" placeholder="type your answer">`;
    } else {
      const multi = q.t === 'multi';
      body = q.o.map((o, i) => {
        const on = multi ? Array.isArray(a) && a.includes(i) : a === i;
        return `<label class="opt ${on ? 'sel' : ''}"><input type="${multi ? 'checkbox' : 'radio'}" name="q${q.n}" data-q="${q.n}" data-i="${i}" ${on ? 'checked' : ''}><span class="mark">${multi ? (on ? '[x]' : '[ ]') : (on ? '(o)' : '( )')}</span><span>${esc(o)}</span></label>`;
      }).join('');
    }
    return `<div class="tr-q"><div class="tr-qt"><span class="n">${String(q.n + 1).padStart(2, '0')}.</span>${esc(q.q)}</div>${q.t === 'multi' ? '<div class="tr-hint">select every answer that applies</div>' : ''}${body}</div>`;
  }

  function onAnswer(e) {
    const el = e.target, n = el.dataset && el.dataset.q;
    if (n === undefined || !trial) return;
    const q = trial.questions[+n];
    if (q.t === 'text') ans[q.n] = el.value;
    else if (q.t === 'one') { ans[q.n] = +el.dataset.i; refreshOpts(q); }
    else {
      const set = new Set(Array.isArray(ans[q.n]) ? ans[q.n] : []);
      if (el.checked) set.add(+el.dataset.i); else set.delete(+el.dataset.i);
      ans[q.n] = [...set].sort(); refreshOpts(q);
    }
    const done = trial.questions.filter(answered).length;
    const top = $('.tr-top span:nth-child(2)'); if (top) top.textContent = `ANSWERED ${done}/${trial.total}`;
    const b = $('.tr-bar'); if (b) b.textContent = `[${bar(done / trial.total * 100, 36)}]`;
  }
  function refreshOpts(q) {                       // restyle in place so focus isn't lost
    screen.querySelectorAll(`input[name="q${q.n}"]`).forEach((inp) => {
      const lab = inp.closest('.opt'), on = inp.checked;
      lab.classList.toggle('sel', on);
      lab.querySelector('.mark').textContent = q.t === 'multi' ? (on ? '[x]' : '[ ]') : (on ? '(o)' : '( )');
    });
  }

  async function submit(forced) {
    const missing = trial.questions.filter((q) => !answered(q)).length;
    if (!forced && missing && !submit.confirmed) { submit.confirmed = true; return viewScroll(`${missing} question${missing > 1 ? 's' : ''} unanswered. Unanswered questions score nothing. Press submit again to send your answers as they are, or go back.`); }
    submit.confirmed = false;
    clearInterval(tick);
    screen.innerHTML = '<h1 class="lg-h">&gt; THE SHRINE WEIGHS YOUR ANSWERS<span class="cursor-blink">_</span></h1>';
    try {
      const res = await api('submit', { id: trial.id, answers: ans.map((a) => a === null ? null : a) });
      me = await status();
      trial = null;
      viewResult(res);
    } catch (err) {
      trial = null;
      me = await status();
      if (!me.authed) return viewAuth('Your session ended. Log in again.');
      viewBrief(err.message);
    }
  }

  function viewResult(r) {
    const pass = r.passed;
    screen.innerHTML = `
      <h1 class="lg-h">&gt; THE SHRINE HAS SPOKEN</h1>
      <div class="rs-rank"><div class="rs-kanji" lang="ja">${KANJI[r.rank] || ''}</div><div class="rs-name ${pass ? 'pass' : 'fail'}">${esc(pass ? r.rank : 'ACCESS DENIED')}</div>
        <div class="rs-pct">${r.pct}% &middot; ${r.correct} OF ${r.total} QUESTIONS CORRECT${pass ? ` &middot; CLEARANCE LEVEL ${r.level}` : ''}</div></div>
      <div class="rs-sec">${r.sections.map((s) => `<span>${esc(s.title)}</span><span class="${s.pct < 50 ? 'lg-red' : ''}">${s.pct}%</span><span class="bar ${s.pct < 50 ? 'low' : ''}">[${bar(s.pct, 30)}]</span>`).join('')}</div>
      ${pass
        ? `<p class="lg-p" style="text-align:center">You are a <b>${esc(r.rank)}</b>. ${r.best > r.level ? `Your best rank, <b>${esc(r.bestRank)}</b>, stands.` : 'The gate opens.'}</p>
           <div class="lg-row" style="justify-content:center"><button class="lg-btn big" data-go="enter">[ ENTER G3 ]</button>${r.level < 4 ? '<button class="lg-btn" data-go="brief">[ TRY FOR A HIGHER RANK ]</button>' : ''}</div>`
        : `<p class="lg-p" style="text-align:center">You are a <b class="lg-red">RONIN</b>: masterless, and the gate stays shut. Study the weakest scrolls above. The shrine reopens in <b>${r.retryIn}s</b>; the questions will be different.</p>
           <div class="lg-row" style="justify-content:center"><button class="lg-btn big sun" data-go="brief">[ RETURN TO THE SHRINE ]</button><button class="lg-btn" data-go="logout">[ LOG OUT ]</button></div>`}`;
    foot(pass ? `CLEARANCE ${r.level} // ${r.rank}` : 'ACCESS DENIED.');
  }

  // ------------------------------------------------------------------ wiring
  screen.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-go]');
    if (!t || t.disabled) return;
    if (t.dataset.tab) { tab = t.dataset.tab; return viewAuth(); }
    switch (t.dataset.go) {
      case 'enter': location.href = 'index.html'; break;
      case 'brief': viewBrief(); break;
      case 'begin': begin(); break;
      case 'next': secIdx = Math.min(secIdx + 1, trial.sections.length - 1); viewScroll(); break;
      case 'prev': secIdx = Math.max(secIdx - 1, 0); viewScroll(); break;
      case 'submit': submit(false); break;
      case 'logout': try { await api('logout'); } catch (err) { /* already gone */ } me = null; viewAuth(); break;
      default: break;
    }
  });
  screen.addEventListener('submit', (e) => { if (e.target.id === 'authForm') submitAuth(e); });
  screen.addEventListener('input', onAnswer);
  screen.addEventListener('change', onAnswer);

  (async function start() {
    try { me = await status(); } catch (e) { screen.innerHTML = '<div class="lg-err">&gt; CANNOT REACH THE LOCAL SERVER. IS G3 STILL RUNNING?</div>'; return; }
    if (!me.enabled) { location.href = 'index.html'; return; }
    me.authed ? route() : viewAuth();
  }());
}());
