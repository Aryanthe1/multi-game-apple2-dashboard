/* Background music: one quiet looping track (assets/audio/alarm.mp3) that follows you from page to page.
   Drop the file in and it plays; with no file nothing happens.  Volume is the MUSIC slider in Settings > Audio (0 = off).
   Shared by every page, including the login, so it is self-contained: it reads the same localStorage prefs as core.js. */
(function () {
  'use strict';
  const SRC = 'assets/audio/alarm.mp3';
  const DEFAULT_VOL = 22;                          // percent: subtle, but enough to hear the tune
  const POS_KEY = 'g3.musicPos';
  let track = null, dead = false, armed = false;

  const prefs = () => { try { return JSON.parse(localStorage.getItem('g3.prefs') || '{}'); } catch (e) { return {}; } };
  const volume = () => { const m = prefs().music; return Math.max(0, Math.min(100, typeof m === 'number' ? m : DEFAULT_VOL)) / 100 * 0.8; };

  function load() {
    if (track || dead) return track;
    track = new Audio();
    track.loop = true;
    track.preload = 'auto';
    track.addEventListener('error', () => { dead = true; track = null; });          // no file: stay silent
    track.addEventListener('loadedmetadata', () => {
      try {
        const pos = parseFloat(sessionStorage.getItem(POS_KEY));
        if (pos > 0 && track.duration && pos < track.duration - 1) track.currentTime = pos;     // carry on where the last page left off
      } catch (e) { /* no storage */ }
    }, { once: true });
    track.addEventListener('timeupdate', save);
    track.src = SRC;
    return track;
  }
  function save() { try { if (track && !track.paused) sessionStorage.setItem(POS_KEY, String(track.currentTime)); } catch (e) { /* ignore */ } }

  function sync() {
    const v = volume();
    if (v <= 0) { if (track) track.pause(); return; }
    const t = load();
    if (!t) return;
    t.volume = v;
    const p = t.play();
    if (p && p.catch) p.catch(() => arm());                                         // autoplay blocked: wait for a click or key
  }
  function arm() {                                                                  // browsers only allow sound after a gesture
    if (armed) return;
    armed = true;
    const go = () => { armed = false; ['pointerdown', 'keydown'].forEach((e) => document.removeEventListener(e, go, true)); sync(); };
    ['pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, go, true));
  }

  window.addEventListener('pagehide', save);
  window.G3Music = { sync };
  sync();
}());
