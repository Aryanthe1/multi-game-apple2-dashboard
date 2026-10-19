/* Login, then the Riddle of the Rising Sun.  The gatekeeper (the server) tells the riddle, judges the answer and decides
   the clearance; this page only shows it. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const screen = $('#screen');

  let me = null;                         // /api/auth/status
  let riddle = null, tab = 'login', retryTimer = null, entering = false;

  async function api(path, body) {
    const res = await fetch('/api/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let data = {};
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) { const err = new Error(data.error || 'The gatekeeper did not answer.'); err.status = res.status; err.retryIn = data.retryIn || 0; throw err; }
    return data;
  }
  const status = async () => (await fetch('/api/auth/status', { cache: 'no-store' })).json();
  const foot = (t) => { $('#footMsg').textContent = '> ' + t; };

  // ------------------------------------------------------------------ login / register
  function viewAuth(err) {
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
          ? 'Pick a callsign (3-16 letters, digits, <b>. - _</b>) and a passcode of 4+ characters. They live only on this computer, the passcode salted and hashed. Your callsign becomes your player name. A new operator has <b>no clearance</b> until the riddle is solved.'
          : 'Already an operator? Log in, then prove your clearance. Returning operators keep the clearance they earned.'}</p>
        <div class="lg-row"><button class="lg-btn big" type="submit" id="authGo">${reg ? '[ REGISTER ]' : '[ LOG IN ]'}</button></div>
      </form>`;
    foot('THE RIDDLE IS JUDGED BY THE GATEKEEPER (THIS COMPUTER), NOT BY THIS PAGE.');
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

  const riddleBox = (lines) => `<div class="rd-box">${lines.map((l) => `<p class="rd-line">${esc(l)}</p>`).join('')}</div>`;

  function viewWelcome() {
    screen.innerHTML = `
      <h1 class="lg-h">&gt; WELCOME BACK, <span class="lg-gold">${esc(me.name.toUpperCase())}</span></h1>
      <div class="rs-rank"><div class="rs-sun"></div><div class="rs-name pass">${esc(me.rank)}</div><div class="rs-pct">CLEARANCE LEVEL ${me.level}</div></div>
      <p class="lg-p" style="text-align:center">The gatekeeper remembers you. The sun is up and the gate is open.</p>
      <div class="lg-row" style="justify-content:center"><button class="lg-btn big" data-go="enter">[ ENTER G3 ]</button><button class="lg-btn" data-go="logout">[ NOT ME: LOG OUT ]</button></div>`;
    foot(`CLEARANCE ${me.level} // ${me.rank}`);
  }

  function viewBrief(err) {
    clearInterval(retryTimer);
    const wait = me.retryIn || 0;
    screen.innerHTML = `
      <h1 class="lg-h">&gt; THE RIDDLE OF THE RISING SUN</h1>
      <p class="lg-p">Operator <b>${esc(me.name)}</b>, the launcher is sealed. Beyond the gate lie the games, and the keeper of the gate asks only one thing: <b>answer his riddle</b>.</p>
      <p class="lg-p">The riddle describes a man. Give the gatekeeper his <b>name</b> and the sun rises for you. A wrong answer keeps the gate shut for a short while.</p>
      ${err ? `<div class="lg-err">&gt; ${esc(err)}</div>` : ''}
      <div class="lg-row end">
        <button class="lg-btn big hot" id="beginBtn" data-go="begin" ${wait ? 'disabled' : ''}>${wait ? `[ CLOSED: ${wait}s ]` : '[ HEAR THE RIDDLE ]'}</button>
        <button class="lg-btn" data-go="logout">[ LOG OUT ]</button>
      </div>`;
    foot('NO ANSWER, NO ENTRY.');
    if (wait) {
      let left = wait;
      retryTimer = setInterval(() => {
        left -= 1;
        const b = $('#beginBtn'); if (!b) return clearInterval(retryTimer);
        if (left <= 0) { clearInterval(retryTimer); me.retryIn = 0; b.disabled = false; b.textContent = '[ HEAR THE RIDDLE ]'; } else b.textContent = `[ CLOSED: ${left}s ]`;
      }, 1000);
    }
  }

  // ------------------------------------------------------------------ the riddle
  async function begin() {
    try {
      riddle = await api('quiz');
    } catch (err) {
      if (err.status === 401) { me = null; return viewAuth('Your session ended. Log in again.'); }
      if (err.retryIn) me.retryIn = err.retryIn;
      return viewBrief(err.message);
    }
    viewRiddle();
  }

  function viewRiddle(warn) {
    screen.innerHTML = `
      <h1 class="lg-h">&gt; ${esc(riddle.title)}</h1>
      ${riddleBox(riddle.riddle)}
      <form id="riddleForm" autocomplete="off">
        <label class="lg-field"><span>YOUR ANSWER</span><input class="lg-input" id="fAnswer" maxlength="80" spellcheck="false" autocomplete="off" placeholder="his name" autofocus></label>
        ${warn ? `<div class="lg-note">&gt; ${esc(warn)}</div>` : ''}
        <div class="lg-row end">
          <button class="lg-btn" type="button" data-go="logout">[ LOG OUT ]</button>
          <button class="lg-btn big hot" type="submit" id="answerGo">[ ANSWER THE GATE ]</button>
        </div>
      </form>`;
    foot('ONE GUESS PER HEARING.');
    $('#fAnswer').focus();
  }

  async function submitAnswer(e) {
    e.preventDefault();
    const answer = $('#fAnswer').value.trim();
    if (!answer) return viewRiddle('Say a name first.');
    $('#answerGo').disabled = true;
    try {
      const res = await api('submit', { id: riddle.id, answer });
      me = await status();
      riddle = null;
      viewResult(res);
    } catch (err) {
      riddle = null;
      me = await status();
      if (!me.authed) return viewAuth('Your session ended. Log in again.');
      viewBrief(err.message);
    }
  }

  function viewResult(r) {
    const pass = r.passed;
    screen.innerHTML = `
      <h1 class="lg-h">&gt; THE GATEKEEPER HAS SPOKEN</h1>
      <div class="rs-rank"><div class="rs-sun ${pass ? '' : 'set'}"></div><div class="rs-name ${pass ? 'pass' : 'fail'}">${esc(pass ? 'THE SUN RISES' : 'ACCESS DENIED')}</div>
        <div class="rs-pct">${pass ? `CLEARANCE LEVEL ${r.level} // ${esc(r.rank)}` : 'THAT IS NOT HIS NAME'}</div></div>
      ${pass
        ? `<p class="lg-p" style="text-align:center">Correct. The gate opens.</p>
           <div class="lg-row" style="justify-content:center"><button class="lg-btn big" data-go="enter">[ ENTER G3 ]</button></div>`
        : `<p class="lg-p" style="text-align:center">The gate stays shut. Read the riddle again, closely. The gate reopens in <b>${r.retryIn}s</b>.</p>
           <div class="lg-row" style="justify-content:center"><button class="lg-btn big hot" data-go="brief">[ RETURN TO THE GATE ]</button><button class="lg-btn" data-go="logout">[ LOG OUT ]</button></div>`}`;
    foot(pass ? `CLEARANCE ${r.level} // ${r.rank}` : 'ACCESS DENIED.');
  }

  // ------------------------------------------------------------------ leaving the terminal
  // The sun climbs and floods the screen while G3 "boots" over it; index.html powers on from the flood (see css/g3.css).
  function enter() {
    if (entering) return;
    entering = true;
    try { sessionStorage.setItem('g3.boot', '1'); } catch (e) { /* no storage: no intro on the other side */ }
    const go = () => { location.href = 'index.html'; };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
    document.body.classList.add('ascend');
    const boot = document.createElement('div');
    boot.className = 'boot';
    boot.innerHTML = '<div class="boot-box"><div id="bootLog"></div><div class="boot-bar"><i></i></div></div>';
    const flash = document.createElement('div');
    flash.className = 'boot-flash';
    document.body.append(boot, flash);
    const log = boot.querySelector('#bootLog');
    ['CLEARANCE VERIFIED // ' + (me && me.rank ? me.rank : 'DAYBREAK'), 'THE SUN IS UP', 'MOUNTING G3 LAUNCHER ...', 'CUBE ONLINE'].forEach((t, i) => {
      setTimeout(() => { const p = document.createElement('p'); p.textContent = '> ' + t; log.appendChild(p); }, 600 + i * 430);
    });
    setTimeout(() => { boot.classList.add('go'); flash.classList.add('go'); }, 2400);
    setTimeout(go, 2800);
    const skip = () => go();                                    // any key or click skips the show
    setTimeout(() => { window.addEventListener('keydown', skip, { once: true }); window.addEventListener('pointerdown', skip, { once: true }); }, 300);
  }
  window.addEventListener('pageshow', (e) => {                  // back button: don't come back to a half-played exit
    if (!e.persisted) return;
    entering = false;
    document.body.classList.remove('ascend');
    document.querySelectorAll('.boot, .boot-flash').forEach((n) => n.remove());
  });

  // ------------------------------------------------------------------ wiring
  screen.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-go]');
    if (!t || t.disabled) return;
    if (t.dataset.tab) { tab = t.dataset.tab; return viewAuth(); }
    switch (t.dataset.go) {
      case 'enter': enter(); break;
      case 'brief': viewBrief(); break;
      case 'begin': begin(); break;
      case 'logout': try { await api('logout'); } catch (err) { /* already gone */ } me = null; viewAuth(); break;
      default: break;
    }
  });
  screen.addEventListener('submit', (e) => { if (e.target.id === 'authForm') submitAuth(e); else if (e.target.id === 'riddleForm') submitAnswer(e); });

  (async function start() {
    try { me = await status(); } catch (e) { screen.innerHTML = '<div class="lg-err">&gt; CANNOT REACH THE LOCAL SERVER. IS G3 STILL RUNNING?</div>'; return; }
    if (!me.enabled) { location.href = 'index.html'; return; }
    me.authed ? route() : viewAuth();
  }());
}());
