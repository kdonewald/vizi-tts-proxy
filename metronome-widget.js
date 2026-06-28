/**
 * Vizi Floating Metronome Widget
 * Include once per page. Injects a draggable pill into the DOM.
 * Pages can call window.viziMetro.setBpm(n) to suggest a tempo.
 * Position is saved in localStorage so it persists across pages.
 */
(function(){
  'use strict';

  // ── CSS ──────────────────────────────────────────────────────
  const css = `
#vizi-metro {
  position: fixed;
  z-index: 9999;
  bottom: 24px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 14px;
  background: #1a1a2e;
  border: 1.5px solid rgba(255,255,255,0.13);
  border-radius: 50px;
  padding: 12px 20px 12px 14px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04);
  user-select: none;
  touch-action: none;
  min-width: 360px;
  cursor: default;
  font-family: 'DM Sans', sans-serif;
  backdrop-filter: blur(8px);
  transition: box-shadow .2s;
}
#vizi-metro:hover {
  box-shadow: 0 10px 36px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.08);
}
#vm-handle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: grab;
  padding: 4px 6px 4px 2px;
  border-radius: 20px;
  flex-shrink: 0;
}
#vm-handle:active { cursor: grabbing; }
#vm-handle svg { display:block; opacity:.5; }
#vm-icon { font-size: 1rem; line-height:1; }

#vm-body { display:flex; align-items:center; gap:8px; flex:1; min-width:0; }

#vm-bpm-display {
  font-family: 'DM Mono', monospace;
  font-size: 1.5rem;
  font-weight: 700;
  color: #fff;
  min-width: 3.4rem;
  text-align: center;
  flex-shrink: 0;
}
#vm-bpm-label {
  font-family: 'DM Mono', monospace;
  font-size: .62rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: rgba(255,255,255,.38);
  flex-shrink: 0;
}

#vm-slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 3px;
  border-radius: 2px;
  background: rgba(255,255,255,.15);
  outline: none;
  cursor: pointer;
  min-width: 60px;
}
#vm-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px; height: 18px;
  border-radius: 50%;
  background: #4f8ef7;
  cursor: pointer;
  transition: transform .1s;
}
#vm-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
#vm-slider::-moz-range-thumb {
  width: 18px; height: 18px;
  border-radius: 50%;
  background: #4f8ef7;
  cursor: pointer;
  border: none;
}

#vm-tap {
  background: rgba(255,255,255,.08);
  border: 1.5px solid rgba(255,255,255,.12);
  border-radius: 50%;
  width: 42px; height: 42px;
  flex-shrink: 0;
  cursor: pointer;
  font-size: .85rem;
  color: rgba(255,255,255,.7);
  display: flex; align-items: center; justify-content: center;
  transition: all .07s;
}
#vm-tap:hover { background: rgba(255,255,255,.14); }
#vm-tap.pulse { background: #e8a020; border-color: #e8a020; color: #fff; transform: scale(.88); }

#vm-ts {
  font-family: 'DM Mono', monospace;
  font-size: .72rem;
  color: rgba(255,255,255,.5);
  background: rgba(255,255,255,.07);
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 6px;
  padding: 4px 9px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background .15s;
  white-space: nowrap;
}
#vm-ts:hover { background: rgba(255,255,255,.13); color: #fff; }

#vm-play {
  width: 46px; height: 46px;
  border-radius: 50%;
  border: none;
  background: #2e7d52;
  color: #fff;
  font-size: 1rem;
  flex-shrink: 0;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all .15s;
  box-shadow: 0 2px 8px rgba(46,125,82,.4);
}
#vm-play:hover { background: #3a9966; transform: scale(1.05); }
#vm-play.playing { background: #c93820; box-shadow: 0 2px 8px rgba(201,56,32,.4); }
#vm-play.playing:hover { background: #e04030; }

/* beat dots */
#vm-beats {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.vm-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: rgba(255,255,255,.15);
  transition: background .06s, box-shadow .06s;
}
.vm-dot.active { background: #4f8ef7; box-shadow: 0 0 6px rgba(79,142,247,.7); }
.vm-dot.accent { background: #e8a020; box-shadow: 0 0 6px rgba(232,160,32,.7); }
`;

  // ── HTML ─────────────────────────────────────────────────────
  const html = `
<div id="vizi-metro">
  <div id="vm-handle" title="Drag to move">
    <svg width="10" height="18" viewBox="0 0 10 18" fill="rgba(255,255,255,0.45)">
      <circle cx="3" cy="3" r="1.5"/><circle cx="7" cy="3" r="1.5"/>
      <circle cx="3" cy="9" r="1.5"/><circle cx="7" cy="9" r="1.5"/>
      <circle cx="3" cy="15" r="1.5"/><circle cx="7" cy="15" r="1.5"/>
    </svg>
    <span id="vm-icon">♩</span>
  </div>
  <div id="vm-body">
    <span id="vm-bpm-display">80</span>
    <span id="vm-bpm-label">BPM</span>
    <input id="vm-slider" type="range" min="40" max="220" value="80">
    <div id="vm-beats">
      <div class="vm-dot"></div><div class="vm-dot"></div>
      <div class="vm-dot"></div><div class="vm-dot"></div>
    </div>
    <div id="vm-tap" title="Tap tempo">TAP</div>
    <span id="vm-ts">4/4</span>
    <button id="vm-play" title="Start / Stop">▶</button>
  </div>
</div>`;

  // ── Inject ────────────────────────────────────────────────────
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper.firstElementChild);

  // ── State ────────────────────────────────────────────────────
  const TS_CYCLE = [2,3,4,6];
  let bpm = 80, beats = 4, beat = 0;
  let playing = false, audioCtx = null, timer = null;
  let tapTimes = [];

  // ── Elements ─────────────────────────────────────────────────
  const el = {
    root:    document.getElementById('vizi-metro'),
    handle:  document.getElementById('vm-handle'),
    bpmDisp: document.getElementById('vm-bpm-display'),
    slider:  document.getElementById('vm-slider'),
    tap:     document.getElementById('vm-tap'),
    ts:      document.getElementById('vm-ts'),
    play:    document.getElementById('vm-play'),
    dots:    document.querySelectorAll('.vm-dot'),
  };

  // ── Position restore ─────────────────────────────────────────
  try {
    const saved = JSON.parse(localStorage.getItem('viziMetroPos') || 'null');
    if (saved && typeof saved.right === 'number') {
      el.root.style.right  = saved.right  + 'px';
      el.root.style.bottom = saved.bottom + 'px';
      el.root.style.left   = '';
      el.root.style.top    = '';
    }
    const savedBpm = parseInt(localStorage.getItem('viziMetroBpm') || '80', 10);
    if (savedBpm >= 40 && savedBpm <= 220) { bpm = savedBpm; }
  } catch(e){}

  el.bpmDisp.textContent = bpm;
  el.slider.value = bpm;

  // ── Audio ─────────────────────────────────────────────────────
  function click(accent) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const t = audioCtx.currentTime;
    o.frequency.value = accent ? 1100 : 750;
    g.gain.setValueAtTime(accent ? 0.45 : 0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.09);
  }

  function flashDot(n, accent) {
    el.dots.forEach(d => d.classList.remove('active','accent'));
    if (el.dots[n]) el.dots[n].classList.add(accent ? 'accent' : 'active');
    el.tap.classList.add('pulse');
    setTimeout(() => el.tap.classList.remove('pulse'), 80);
  }

  function tick() {
    if (!playing) return;
    const accent = beat === 0;
    click(accent);
    flashDot(beat, accent);
    beat = (beat + 1) % beats;
    timer = setTimeout(tick, 60000 / bpm);
  }

  function start() {
    if (playing) return;
    playing = true; beat = 0;
    el.play.textContent = '■';
    el.play.classList.add('playing');
    tick();
  }

  function stop() {
    playing = false;
    clearTimeout(timer); timer = null;
    el.play.textContent = '▶';
    el.play.classList.remove('playing');
    el.dots.forEach(d => d.classList.remove('active','accent'));
  }

  function setBpm(v) {
    bpm = Math.max(40, Math.min(220, parseInt(v, 10) || 80));
    el.bpmDisp.textContent = bpm;
    el.slider.value = bpm;
    try { localStorage.setItem('viziMetroBpm', bpm); } catch(e){}
    if (playing) { stop(); start(); }
  }

  function setBeats(n) {
    beats = n;
    const tsStr = n === 6 ? '6/8' : n + '/4';
    el.ts.textContent = tsStr;
    // resize dots
    const container = document.getElementById('vm-beats');
    container.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'vm-dot';
      container.appendChild(d);
    }
    el.dots = container.querySelectorAll('.vm-dot');
    beat = 0;
    if (playing) { stop(); start(); }
  }

  // ── Event listeners ───────────────────────────────────────────
  el.play.addEventListener('click', () => playing ? stop() : start());

  el.slider.addEventListener('input', e => setBpm(e.target.value));

  el.ts.addEventListener('click', () => {
    const idx = TS_CYCLE.indexOf(beats);
    setBeats(TS_CYCLE[(idx + 1) % TS_CYCLE.length]);
  });

  el.tap.addEventListener('click', () => {
    const now = Date.now();
    tapTimes = tapTimes.filter(t => now - t < 3000);
    tapTimes.push(now);
    if (tapTimes.length >= 2) {
      const gaps = [];
      for (let i = 1; i < tapTimes.length; i++) gaps.push(tapTimes[i] - tapTimes[i-1]);
      const avg = gaps.reduce((a,b)=>a+b,0)/gaps.length;
      setBpm(Math.round(60000/avg));
    }
    el.tap.classList.add('pulse');
    setTimeout(()=>el.tap.classList.remove('pulse'),80);
    clearTimeout(el.tap._rt);
    el.tap._rt = setTimeout(()=>{ tapTimes=[]; }, 3000);
  });

  // ── Drag ─────────────────────────────────────────────────────
  let dragActive = false, startX, startY, startRight, startBottom;

  function onDragStart(e) {
    dragActive = true;
    const touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX; startY = touch.clientY;
    const rect = el.root.getBoundingClientRect();
    startRight  = window.innerWidth  - rect.right;
    startBottom = window.innerHeight - rect.bottom;
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!dragActive) return;
    const touch = e.touches ? e.touches[0] : e;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    const newRight  = Math.max(0, startRight  - dx);
    const newBottom = Math.max(0, startBottom - dy);
    el.root.style.right  = newRight  + 'px';
    el.root.style.bottom = newBottom + 'px';
    el.root.style.left   = '';
    el.root.style.top    = '';
    e.preventDefault();
  }

  function onDragEnd() {
    if (!dragActive) return;
    dragActive = false;
    try {
      localStorage.setItem('viziMetroPos', JSON.stringify({
        right:  parseFloat(el.root.style.right)  || 24,
        bottom: parseFloat(el.root.style.bottom) || 24,
      }));
    } catch(e){}
  }

  el.handle.addEventListener('mousedown', onDragStart);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  el.handle.addEventListener('touchstart', onDragStart, {passive:false});
  document.addEventListener('touchmove', onDragMove, {passive:false});
  document.addEventListener('touchend', onDragEnd);

  // ── Public API ────────────────────────────────────────────────
  window.viziMetro = { setBpm, start, stop, setBeats };

})();
