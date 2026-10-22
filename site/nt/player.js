/* NomadaToast tape player: opening a tape plays its video on the CRT screen.
   Added on top of the mirrored runtime. The home chunk dispatches `nt:play` with the
   tape slug where it used to navigate to /work/<slug> (patches/p6_player.py), and
   clicks on /work/<slug> links are caught here before the layout's link handler. */
(() => {
  let tapes = null;
  const load = () => tapes || (tapes = fetch('/nt/tapes.json').then(r => r.json()));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  load();

  let ui = null;
  let state = 'closed'; // closed | loading | open | closing
  let returnFocus = null;
  let modeTimer = 0;

  const pad = n => String(n).padStart(2, '0');
  const clock = t => {
    t = Math.max(0, Math.floor(t || 0));
    return `${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
  };

  function build(tape) {
    const root = document.createElement('div');
    root.className = 'nt-vcr';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `Playing ${tape.title}`);
    root.innerHTML = `
      <div class="nt-vcr-bg" style="background-image:url('${tape.poster}')"></div>
      <video class="nt-vcr-video" playsinline preload="auto" poster="${tape.poster}" src="${tape.video}"></video>
      <div class="nt-vcr-lines"></div>
      <div class="nt-vcr-track"></div>
      <div class="nt-vcr-osd">
        <span class="nt-osd-mode">▶ PLAY</span>
        <span class="nt-osd-count">SP 0:00:00</span>
        <span class="nt-osd-title"><b>${tape.title}</b><i>+toast home video</i></span>
        <button type="button" class="nt-osd-eject">⏏ Eject</button>
        <span class="nt-osd-hint">Space pause · ←→ seek · M mute · Esc eject</span>
      </div>`;
    const q = s => root.querySelector(s);
    return { root, video: q('video'), mode: q('.nt-osd-mode'), count: q('.nt-osd-count'),
             eject: q('.nt-osd-eject'), track: q('.nt-vcr-track') };
  }

  function setMode(text, hold) {
    ui.mode.textContent = text;
    clearTimeout(modeTimer);
    if (hold) modeTimer = setTimeout(() => ui && setMode(ui.video.paused ? '❚❚ PAUSE' : '▶ PLAY'), hold);
  }

  function tracking() {
    ui.track.classList.remove('is-on');
    void ui.track.offsetWidth;
    ui.track.classList.add('is-on');
  }

  async function open(slug) {
    if (state !== 'closed') return;
    state = 'loading'; // swallow the rest of the opening click while the map loads
    const tape = await load().then(all => all[slug], () => null);
    const screen = document.querySelector('main.vhs');
    if (!tape || !screen) { state = 'closed'; return; }
    state = 'open';
    returnFocus = document.activeElement;
    ui = build(tape);
    screen.appendChild(ui.root);
    const { video } = ui;
    video.addEventListener('timeupdate', () => { ui.count.textContent = `SP ${clock(video.currentTime)}`; });
    video.addEventListener('waiting', () => setMode('TRACKING'));
    video.addEventListener('playing', () => setMode('▶ PLAY'));
    video.addEventListener('ended', () => { setMode('■ STOP'); setTimeout(close, 1200); });
    video.addEventListener('error', () => { setMode('NO SIGNAL'); setTimeout(close, 1800); });
    requestAnimationFrame(() => ui.root.classList.add('is-on'));
    tracking();
    ui.eject.focus({ preventScroll: true });
    try {
      await video.play();
    } catch {
      video.muted = true; // autoplay with sound refused: play muted, M unmutes
      ui.root.classList.add('is-muted');
      video.play().catch(() => {});
    }
  }

  function close() {
    if (state !== 'open') return;
    state = 'closing';
    const { root, video } = ui;
    video.pause();
    root.classList.add('is-off');
    const done = () => {
      root.remove();
      ui = null;
      state = 'closed';
      if (returnFocus && returnFocus.focus) returnFocus.focus({ preventScroll: true });
    };
    reduced ? done() : setTimeout(done, 380);
  }

  function toggle() {
    const { video } = ui;
    if (video.paused) { video.play().catch(() => {}); setMode('▶ PLAY'); }
    else { video.pause(); setMode('❚❚ PAUSE'); }
  }

  function seek(delta) {
    const { video } = ui;
    video.currentTime = Math.max(0, Math.min((video.duration || 0) - 0.1, video.currentTime + delta));
    setMode(delta > 0 ? '▶▶ FF' : '◀◀ REW', 700);
    tracking();
  }

  function mute() {
    const { video } = ui;
    video.muted = !video.muted;
    ui.root.classList.toggle('is-muted', video.muted);
  }

  window.addEventListener('nt:play', e => open(e.detail));

  // Clicks: /work/<slug> links open the tape; while playing, the screen takes every click.
  window.addEventListener('click', e => {
    if (state === 'closed') {
      const a = e.target.closest && e.target.closest('a[href^="/work/"]');
      if (!a) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      open(decodeURIComponent(a.getAttribute('href').slice(6).split(/[?#]/)[0]));
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (state !== 'open') return;
    if (e.target.closest('.nt-osd-eject')) close();
    else if (ui.root.contains(e.target)) toggle();
  }, true);

  // Keys and scrolling stay with the tape while it plays (the carousel underneath stays put).
  window.addEventListener('keydown', e => {
    if (state === 'closed') return;
    e.stopImmediatePropagation();
    if (state !== 'open' || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') close();
    else if (k === ' ' || k === 'k' || k === 'K' || (k === 'Enter' && e.target !== ui.eject)) toggle();
    else if (k === 'Enter') close();
    else if (k === 'ArrowRight' || k === 'l' || k === 'L') seek(5);
    else if (k === 'ArrowLeft' || k === 'j' || k === 'J') seek(-5);
    else if (k === 'm' || k === 'M') mute();
    else if (k === 'Tab') { e.preventDefault(); ui.eject.focus(); return; }
    else return;
    e.preventDefault();
  }, true);
  for (const type of ['wheel', 'pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove']) {
    window.addEventListener(type, e => {
      if (state === 'closed') return;
      e.stopImmediatePropagation();
      if (type === 'wheel' || type === 'touchmove') e.preventDefault();
    }, { capture: true, passive: false });
  }
})();
