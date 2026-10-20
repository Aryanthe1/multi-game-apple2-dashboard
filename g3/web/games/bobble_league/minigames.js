/* Bobble League: the arena minigames.  They run on the player's own screen; the only thing the host hears is how long
 * the player took (opt.onDone(ms)), see Sim.miniDone in sim.js.
 *
 *   scrub   stadium     an onlooker pelted you: rub the screen clean with the mouse / your finger
 *   dig     desert      sandstorm: mash SPACE / click to dig yourself out (a race)
 *   shake   tundra      snowstorm: alternate LEFT and RIGHT (A / D) to shake the snow off (a race)
 *
 *   const mg = BobbleMini.start('dig', stageElement, { what, onDone(ms) {}, beep(freq, dur, type) });
 *   mg.stop();     // take it down (also what you call when the round moves on without you)
 */
(function () {
  'use strict';

  const FLAVOR = {
    tomato: { emoji: '🍅', title: 'SPLAT! A TOMATO TO THE FACE', colors: ['#d62b1f', '#ff5a3c', '#8f1208'] },
    soda: { emoji: '🥤', title: 'SODA SHOWER FROM THE STANDS', colors: ['#6b3b14', '#a8641f', '#3b1d08'] },
    banana: { emoji: '🍌', title: 'BANANA SPLAT FROM THE STANDS', colors: ['#f3d54a', '#ffe97a', '#b9941a'] },
    boo: { emoji: '📣', title: 'THE STANDS ARE JEERING AT YOU', colors: ['#6c5a8f', '#a999cf', '#3a2d57'] },
  };
  const RACES = {
    dig: { emoji: '🥵', title: 'SANDSTORM!', sub: 'DIG YOURSELF OUT: MASH [SPACE] OR CLICK. FIRST OUT GETS THE TURN.', gain: 0.06, decay: 0.2, tone: '#e0b050' },
    shake: { emoji: '🥶', title: 'SNOWSTORM!', sub: 'SHAKE IT OFF: ALTERNATE [◀] AND [▶] (OR A / D). FIRST OUT GETS THE TURN.', gain: 0.05, decay: 0.12, tone: '#9fd8ff' },
  };
  const rand = (a, b) => a + Math.random() * (b - a);

  function start(kind, parent, opt) {
    opt = opt || {};
    const beep = opt.beep || (() => {});
    const root = document.createElement('div');
    root.className = 'bl-mg bl-mg-' + kind;
    parent.appendChild(root);
    const t0 = performance.now();
    let done = false, stopped = false, raf = 0, timer = 0, detach = [];

    function on(target, type, fn, capture) { target.addEventListener(type, fn, capture); detach.push(() => target.removeEventListener(type, fn, capture)); }
    function stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf); clearInterval(timer);
      detach.forEach((f) => f());
      root.remove();
    }
    function finish(after) {
      if (done || stopped) return;
      done = true;
      cancelAnimationFrame(raf); clearInterval(timer);
      const ms = performance.now() - t0;
      if (typeof opt.onDone === 'function') opt.onDone(ms);
      if (after) after(); else stop();
    }
    // while a minigame is up its keys are its own: Space must not lock in a plan behind it (F still toggles fullscreen)
    on(window, 'keydown', (e) => {
      if (e.code === 'KeyF' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (kind !== 'scrub' || ['Space', 'Enter'].includes(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
      if (kind !== 'scrub') key(e);
    }, true);

    let key = () => {};
    if (kind === 'scrub') scrub(); else mash(RACES[kind] || RACES.dig);

    // ---------------------------------------------------------------- rub the screen clean
    function scrub() {
      const fl = FLAVOR[opt.what] || FLAVOR.tomato;
      const w = Math.max(320, parent.clientWidth), h = Math.max(200, parent.clientHeight);
      root.innerHTML = `<canvas></canvas><div class="bl-mg-hud"><b>${fl.emoji} ${fl.title}</b><span>RUB THE SCREEN CLEAN WITH THE MOUSE (OR YOUR FINGER)</span><div class="bl-mg-bar"><i></i></div></div>`;
      const cv = root.querySelector('canvas'), bar = root.querySelector('.bl-mg-bar i'), hint = root.querySelector('.bl-mg-hud span');
      cv.width = w; cv.height = h;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.fillStyle = fl.colors[0]; c.globalAlpha = 0.5; c.fillRect(0, 0, w, h); c.globalAlpha = 1;       // the film over everything
      for (let i = 0; i < 30; i++) {                                                                       // blotches (clusters of overlapping blobs) and drips
        const x = rand(0, w), y = rand(0, h), r = rand(0.04, 0.1) * w;
        c.globalAlpha = 0.9;
        for (let k = 0; k < 7; k++) {
          const bx = x + rand(-r, r) * 0.9, by = y + rand(-r, r) * 0.9, br = r * rand(0.3, 0.7);
          const g = c.createRadialGradient(bx - br * 0.25, by - br * 0.25, br * 0.1, bx, by, br);
          g.addColorStop(0, fl.colors[1]); g.addColorStop(0.75, fl.colors[0]); g.addColorStop(1, fl.colors[2]);
          c.fillStyle = g; c.beginPath(); c.arc(bx, by, br, 0, 7); c.fill();
        }
        c.fillStyle = 'rgba(255,255,255,.22)'; c.beginPath(); c.ellipse(x - r * 0.3, y - r * 0.35, r * 0.25, r * 0.12, -0.6, 0, 7); c.fill();
        if (i % 2 === 0) { c.fillStyle = fl.colors[0]; const dl = rand(0.08, 0.28) * h; c.fillRect(x - r * 0.08, y, r * 0.16, dl); c.beginPath(); c.arc(x, y + dl, r * 0.12, 0, 7); c.fill(); }
      }
      c.globalAlpha = 1;
      const sm = document.createElement('canvas'); sm.width = 64; sm.height = 40;
      const sc = sm.getContext('2d', { willReadFrequently: true });
      const covered = () => {
        sc.clearRect(0, 0, 64, 40); sc.drawImage(cv, 0, 0, 64, 40);
        const px = sc.getImageData(0, 0, 64, 40).data;
        let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 40) n++;
        return n / 2560;
      };
      const full = Math.max(0.5, covered());
      let last = null, rubbed = 0;
      const wipe = (e) => {
        const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) * w / r.width, y = (e.clientY - r.top) * h / r.height;
        c.globalCompositeOperation = 'destination-out'; c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = Math.max(54, w * 0.07);
        c.beginPath(); c.moveTo(last ? last.x : x, last ? last.y : y); c.lineTo(x + 0.01, y); c.stroke();
        c.globalCompositeOperation = 'source-over';
        if (last && Math.hypot(x - last.x, y - last.y) > 3) { rubbed += Math.hypot(x - last.x, y - last.y); if (rubbed > 140) { rubbed = 0; beep(180 + Math.random() * 120, 0.03, 'triangle'); } }
        last = { x, y };
        hint.style.opacity = 0.4;
      };
      on(cv, 'pointermove', wipe);
      on(cv, 'pointerdown', (e) => { last = null; wipe(e); try { cv.setPointerCapture(e.pointerId); } catch (err) { /* fine */ } });
      on(cv, 'pointerleave', () => { last = null; });
      timer = setInterval(() => {
        const p = Math.max(0, Math.min(1, 1 - covered() / full));
        bar.style.width = (p * 100).toFixed(0) + '%';
        if (p >= 0.94) { beep(880, 0.12, 'square'); finish(() => { root.classList.add('bl-mg-clean'); setTimeout(stop, 500); }); }
      }, 100);
    }

    // ---------------------------------------------------------------- the two races
    function mash(cfg) {
      root.innerHTML = `<div class="bl-mg-card" style="--tone:${cfg.tone}">
        <b class="bl-mg-title">${cfg.title}</b><span class="bl-mg-sub">${cfg.sub}</span>
        <div class="bl-mg-pit"><span class="bl-mg-em">${cfg.emoji}</span><div class="bl-mg-heap"></div></div>
        <div class="bl-mg-bar"><i></i></div><span class="bl-mg-pct">0%</span>
        ${kind === 'shake' ? '<div class="bl-mg-keys"><button data-k="L">◀</button><button data-k="R">▶</button></div>' : ''}</div>`;
      const em = root.querySelector('.bl-mg-em'), heap = root.querySelector('.bl-mg-heap'), bar = root.querySelector('.bl-mg-bar i'), pct = root.querySelector('.bl-mg-pct');
      let p = 0, lastSide = '', started = false, prev = performance.now(), jolt = 0;
      const push = (side) => {
        started = true;
        if (kind === 'shake') {
          if (side === lastSide) { p = Math.max(0, p - 0.03); beep(120, 0.04, 'sawtooth'); return; }          // the same side twice does nothing good
          lastSide = side; jolt = side === 'L' ? -1 : 1;
        } else jolt = jolt > 0 ? -1 : 1;
        p = Math.min(1, p + cfg.gain);
        beep(240 + 500 * p, 0.03, 'square');
        if (p >= 1) win();                                                  // right now: the next frame's decay would drop it just under 1
      };
      const win = () => {
        if (done) return;
        p = 1; bar.style.width = '100%'; pct.textContent = '100%'; heap.style.height = '0%';
        beep(660, 0.1, 'square'); setTimeout(() => beep(990, 0.15, 'square'), 90);
        finish(() => { root.querySelector('.bl-mg-title').textContent = 'YOU\'RE OUT!'; root.querySelector('.bl-mg-sub').textContent = 'WAITING FOR THE OTHERS...'; });
      };
      key = (e) => {
        if (e.repeat) return;
        if (kind === 'dig') { if (['Space', 'Enter', 'KeyZ', 'KeyX'].includes(e.code)) push('x'); }
        else if (['ArrowLeft', 'KeyA'].includes(e.code)) push('L');
        else if (['ArrowRight', 'KeyD'].includes(e.code)) push('R');
      };
      on(root, 'pointerdown', (e) => {
        const b = e.target.closest && e.target.closest('button[data-k]');
        if (kind === 'shake') { if (b) push(b.dataset.k); } else push('x');
      });
      const tick = (now) => {
        raf = requestAnimationFrame(tick);
        const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
        if (started && !done) p = Math.max(0, p - cfg.decay * dt);
        jolt *= Math.pow(0.0005, dt);
        bar.style.width = (p * 100).toFixed(1) + '%'; pct.textContent = Math.round(p * 100) + '%';
        heap.style.height = ((1 - p) * 70).toFixed(1) + '%';
        em.style.transform = `translate(${(jolt * 10).toFixed(1)}px, ${(-p * 34).toFixed(1)}px) rotate(${(jolt * 12).toFixed(1)}deg)`;
      };
      raf = requestAnimationFrame(tick);
    }

    return { stop, isDone: () => done };
  }

  window.BobbleMini = { FLAVOR, start };
}());
