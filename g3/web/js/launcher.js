/* Launcher: the 3D game cube, the active-cartridge readout and the live room roster. */
(function () {
  'use strict';
  const { $, $$, esc } = G3;

  // Which way the cube must turn to bring each game's face to the camera.
  // BoxGeometry face order is +x right, -x left, +y top, -y bottom, +z front, -z back.
  const FACE_ORDER = ['sketch_rumble', 'letter_league', 'liars_bar', 'whos_away', 'bobble_league', 'kart_odyssey'];
  const TURN = {
    bobble_league: [0, 0],                 // [rotX, rotY]
    sketch_rumble: [0, -Math.PI / 2],
    kart_odyssey: [0, Math.PI],
    letter_league: [0, Math.PI / 2],
    liars_bar: [Math.PI / 2, 0],           // top face tips toward the camera
    whos_away: [-Math.PI / 2, 0],          // bottom face
  };
  const TAU = Math.PI * 2;

  let current = 0, ready = false, cube = null, cubeApi = null;

  // ---------------------------------------------------------------- the cube
  function buildCube() {
    const container = $('#cube3dContainer');
    const w = container.clientWidth || 600, h = container.clientHeight || 450;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch (e) {
      return null;                            // no WebGL: the flat cover fallback takes over
    }
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.position.z = 4.2;
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const loader = new THREE.TextureLoader();
    const materials = FACE_ORDER.map((id) => {
      const tex = loader.load(`assets/covers/${id}.png`);
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      return new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff });
    });
    const size = 1.9;
    const geo = new THREE.BoxGeometry(size, size, size);
    const mesh = new THREE.Mesh(geo, materials);
    scene.add(mesh);

    // Apple II vector-green wireframe and corner nodes
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x33FF66, transparent: true, opacity: 0.95 })));
    const nodeGeo = new THREE.BoxGeometry(0.08, 0.08, 0.08), nodeMat = new THREE.MeshBasicMaterial({ color: 0x33FF66 });
    [-1, 1].forEach((x) => [-1, 1].forEach((y) => [-1, 1].forEach((z) => {
      const n = new THREE.Mesh(nodeGeo, nodeMat);
      n.position.set(size / 2 * x, size / 2 * y, size / 2 * z);
      mesh.add(n);
    })));

    const st = { dragging: false, prev: { x: 0, y: 0 }, auto: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                 snapping: false, target: { x: 0, y: 0, z: 0 }, vx: 0, vy: 0, vz: 0, resumeTimer: null };

    const readout = () => {};
    const resumeLater = () => {
      clearTimeout(st.resumeTimer);
      st.resumeTimer = setTimeout(() => { if (!st.dragging && !st.snapping) st.auto = true; setCubeStatus(); }, 3200);
    };
    const down = (x, y) => { st.dragging = true; st.auto = false; st.snapping = false; st.vx = st.vy = st.vz = 0; st.prev = { x, y }; setCubeStatus(); };
    const move = (x, y) => {
      if (!st.dragging) return;
      const dx = x - st.prev.x, dy = y - st.prev.y;
      mesh.rotation.y += dx * 0.009; mesh.rotation.x += dy * 0.009; mesh.rotation.z += dx * dy * 0.0001;
      st.vx = dy * 0.009; st.vy = dx * 0.009; st.vz = dx * dy * 0.0001;
      st.prev = { x, y };
      readout();
    };
    const up = () => { if (st.dragging) { st.dragging = false; G3.beep(440, 0.05); resumeLater(); } };
    container.addEventListener('mousedown', (e) => down(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', up);
    container.addEventListener('touchstart', (e) => { if (e.touches.length === 1) down(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    window.addEventListener('touchmove', (e) => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    window.addEventListener('touchend', up);

    window.addEventListener('resize', () => {
      const nw = container.clientWidth || 600, nh = container.clientHeight || 450;
      camera.aspect = nw / nh; camera.updateProjectionMatrix(); renderer.setSize(nw, nh);
    });

    const clock = new THREE.Clock();
    (function animate() {
      requestAnimationFrame(animate);
      const dt = clock.getDelta(), el = clock.getElapsedTime();
      if (st.auto && !st.dragging) {
        mesh.rotation.y += dt * 0.42;
        mesh.rotation.x += Math.sin(el * 0.65) * 0.006;
        mesh.rotation.z += Math.cos(el * 0.45) * 0.004;
        readout();
      } else if (st.snapping) {
        ['x', 'y', 'z'].forEach((a) => { mesh.rotation[a] += (st.target[a] - mesh.rotation[a]) * 0.12; });
        readout();
        if (['x', 'y', 'z'].every((a) => Math.abs(st.target[a] - mesh.rotation[a]) < 0.01)) {
          ['x', 'y', 'z'].forEach((a) => { mesh.rotation[a] = st.target[a]; });
          st.snapping = false; setCubeStatus();
        }
      } else if (!st.dragging) {
        mesh.rotation.x += st.vx; mesh.rotation.y += st.vy; mesh.rotation.z += st.vz;
        st.vx *= 0.95; st.vy *= 0.95; st.vz *= 0.95;
        readout();
      }
      renderer.render(scene, camera);
    }());

    function setCubeStatus() {}
    return {
      snapTo(id) {
        const [rx, ry] = TURN[id];
        // turn the short way round: bring the current angles within half a turn of the target
        const near = (cur, tgt) => tgt + Math.round((cur - tgt) / TAU) * TAU;
        st.target = { x: near(mesh.rotation.x, rx), y: near(mesh.rotation.y, ry), z: near(mesh.rotation.z, 0) };
        st.snapping = true; st.auto = false; clearTimeout(st.resumeTimer); setCubeStatus();
      },
    };
  }

  // ---------------------------------------------------------------- selecting a cartridge
  function selectFace(i, sfx = true) {
    const cat = G3.state.catalog;
    if (!cat.length) return;
    i = (i + cat.length) % cat.length;
    current = i;
    if (sfx) G3.beep(720, 0.09);
    const g = cat[i];
    if (cubeApi) cubeApi.snapTo(g.id);
    else {
      const holder = $('#cube3dContainer');
      let img = $('#flatCover');
      if (!img) { img = document.createElement('img'); img.id = 'flatCover'; img.className = 'w-full h-full object-contain'; holder.appendChild(img); }
      img.src = `assets/covers/${g.id}.png`; img.alt = g.name;
    }
    $$('[data-face]').forEach((el) => {
      el.classList.toggle('bg-[#33FF66]', +el.dataset.face === i);
      el.classList.toggle('text-[#050d06]', +el.dataset.face === i);
    });
    renderCard();
  }

  function renderCard() {
    const g = G3.state.catalog[current];
    if (!g) return;
    $('#gameExeTitle').textContent = g.exe;
    $('#gameMetaSub').textContent = `${g.genre} · ${g.min === g.max ? g.max : g.min + '-' + g.max} PLAYERS`;
  }

  function launch() {
    const g = G3.state.catalog[current];
    if (!g) return;
    G3.beep(980, 0.15, 'sawtooth');
    $('#launchBtn').classList.add('bg-[#33FF66]');
    const flash = document.createElement('div');
    flash.className = 'fixed inset-0 bg-[#33FF66]/30 z-50 pointer-events-none transition-opacity duration-300';
    document.body.appendChild(flash);
    setTimeout(() => { flash.style.opacity = '0'; }, 100);
    setTimeout(() => { location.href = `lobby.html?game=${encodeURIComponent(g.id)}`; }, 380);
  }

  // ---------------------------------------------------------------- roster
  function renderRoster() {
    const r = G3.state.room, list = $('#rosterList'), st = G3.state.status;
    if (!r) {
      const busy = st.state === 'connecting' || st.state === 'searching';
      $('#rosterBadge').textContent = '[EMPTY]';
      list.innerHTML = `<div class="border border-dashed border-[#156628] bg-[#020703] p-4 text-center text-[12px] text-[#22aa44]">
        ${st.state === 'error' ? `<span class="text-[#FF3366]">${esc(st.msg)}</span>` : busy ? esc(st.msg || 'CONNECTING...') : 'NO ROOM OPEN'}</div>`;
      return;
    }
    $('#rosterBadge').textContent = `[${r.slots.length} / ${r.max}]`;
    list.innerHTML = r.slots.map((m) => {
      const you = m.id === r.you, host = m.role === 'HOST';
      const [bg, fg] = G3.AV_COLORS[m.av % G3.AV_COLORS.length];
      return `<div class="border ${you ? 'border-[#33FF66] bg-[#0c2410]' : 'border-[#156628] bg-[#050d06]'} p-2 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="w-7 h-7 flex items-center justify-center text-sm" style="background:${bg};color:${fg}">${G3.AVATARS[m.av % G3.AVATARS.length]}</span>
          <div class="text-xs font-mono text-[#33FF66] font-bold">@${esc(m.n)}${you ? ' <span class="text-[8px] bg-[#33FF66] text-[#050d06] px-1">YOU</span>' : ''}${host ? ' <span class="text-[#FFB000]">♛</span>' : ''}</div>
        </div>
        <div class="flex items-center gap-3 font-mono text-[10px]">
          <span class="text-[#22aa44]">${m.ping == null ? '--' : m.ping + 'ms'}</span>
          <span class="${host || m.ready ? 'bg-[#33FF66] text-[#050d06]' : 'border border-[#FFB000] text-[#FFB000]'} px-1.5 py-0.5 font-bold">${host ? 'HOST' : m.ready ? 'READY' : 'WAITING'}</span>
        </div></div>`;
    }).join('');
  }

  // ---------------------------------------------------------------- wiring
  // ---------------------------------------------------------------- wiring
  function buildDock() {
    const cat = G3.state.catalog;
    $('#faceButtons').innerHTML = cat.map((g, i) => `<button class="px-2 py-1 text-[9px] font-pixel border border-[#156628] hover:border-[#33FF66] hover:bg-[#33FF66] hover:text-[#050d06] bg-[#050d06] text-[#33FF66] transition-colors" data-face="${i}" title="${esc(g.exe)}">F${i + 1}</button>`).join('');
    $$('[data-face]').forEach((b) => b.addEventListener('click', () => selectFace(+b.dataset.face)));
  }

  G3.on('init', (m) => {
    if (!ready) {
      ready = true;
      buildDock();
      const i = Math.max(0, m.catalog.findIndex((g) => g.id === m.settings.game));
      selectFace(i, false);
    }
    renderRoster(); renderCard();
  });
  ['room', 'status', 'closed', 'pong'].forEach((t) => G3.on(t, () => { if (ready) { renderRoster(); renderCard(); } }));

  document.addEventListener('DOMContentLoaded', () => {
    cubeApi = buildCube();
    $('#launchBtn').addEventListener('click', launch);
    window.addEventListener('keydown', (e) => {
      if (e.target.matches && e.target.matches('input,textarea,select')) return;
      if (e.ctrlKey || e.metaKey || e.altKey || !ready) return;
      const K = G3.prefs.keys;
      if (/^[1-9]$/.test(e.key) && +e.key <= G3.state.catalog.length) selectFace(+e.key - 1);
      else if (e.code === K.prev || ['KeyA', 'KeyW', 'ArrowUp'].includes(e.code)) { e.preventDefault(); selectFace(current - 1); }
      else if (e.code === K.next || ['KeyD', 'KeyS', 'ArrowDown'].includes(e.code)) { e.preventDefault(); selectFace(current + 1); }
      else if (e.code === K.exec || e.code === 'Space') { e.preventDefault(); launch(); }
    });
  });
}());
