// Game-feel layer: ranks and XP kept on this device, badges, splashes, particles, count-ups and share cards.
// Each game calls FX.setup() with its own theme words, badges and particle shapes.
window.FX = (() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LEVELS = [0, 120, 300, 550, 900, 1350, 1900, 2600, 3500];
  const cfg = { key: 'game', ranks: ['Novice'], badges: {}, particles: ['<i class="fx-dot"></i>'], sound: () => {}, levelKicker: 'PROMOTED', badgeKicker: 'BADGE EARNED', statLabels: {} };
  let prof = null;
  const layer = el('div', 'fx-layer'), toasts = el('div', 'fx-toasts');
  document.body.append(layer, toasts);
  layer.setAttribute('aria-hidden', 'true');
  toasts.setAttribute('role', 'status');

  function el(tag, cls, html = '') { const n = document.createElement(tag); n.className = cls; n.innerHTML = html; return n; }
  function setup(options) { Object.assign(cfg, options); paintChips(); }

  // ---------- Profile, XP and rank (stored only in this browser) ----------
  function profile() {
    if (!prof) {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(`${cfg.key}-profile`)); } catch {}
      prof = { xp: 0, games: 0, wins: 0, badges: {}, stats: {}, ...(stored || {}) };
    }
    return prof;
  }
  function save() { try { localStorage.setItem(`${cfg.key}-profile`, JSON.stringify(prof)); } catch {} }
  function level(xp = profile().xp) {
    let i = 0;
    while (i < LEVELS.length - 1 && xp >= LEVELS[i + 1]) i++;
    const lo = LEVELS[i], hi = LEVELS[i + 1] ?? null;
    return { index: i, number: i + 1, name: cfg.ranks[Math.min(i, cfg.ranks.length - 1)], lo, hi, frac: hi ? (xp - lo) / (hi - lo) : 1, xp };
  }
  function addXP(amount, anchor) {
    if (!amount) return;
    const p = profile(), before = level(p.xp);
    p.xp += amount; save();
    if (anchor) float(anchor, `+${amount} XP`, 'fx-xp');
    const after = level(p.xp);
    if (after.index > before.index) {
      setTimeout(() => { splash({ kicker: cfg.levelKicker, title: after.name, sub: `Rank ${after.number} · ${p.xp} XP`, cls: 'fx-levelup' }); cfg.sound('levelup'); }, 900);
    }
    paintChips();
  }
  function bump(stat, n = 1) { const p = profile(); p.stats[stat] = (p.stats[stat] || 0) + n; save(); return p.stats[stat]; }
  function stat(name) { return profile().stats[name] || 0; }
  function has(id) { return !!profile().badges[id]; }
  function unlock(id) {
    const badge = cfg.badges[id], p = profile();
    if (!badge || p.badges[id]) return false;
    p.badges[id] = Date.now(); save();
    toast(`<div class="fx-medal">${badge.icon || '★'}</div><div class="fx-badge-text"><small>${cfg.badgeKicker}</small><b>${badge.name}</b><span>${badge.desc}</span></div>`, 'fx-badge', 4600);
    cfg.sound('badge');
    addXP(badge.xp ?? 40);
    return true;
  }
  function recordGame(won) { const p = profile(); p.games++; if (won) p.wins++; save(); paintChips(); }
  // Small rank chips anywhere the page puts [data-fx-chip].
  function paintChips() {
    const l = level();
    for (const chip of document.querySelectorAll('[data-fx-chip]')) {
      chip.innerHTML = `<b>${l.number}</b><span>${l.name}</span><i style="--f:${l.frac.toFixed(3)}"></i>`;
      chip.title = `${l.xp} XP${l.hi ? ` · ${l.hi - l.xp} to the next rank` : ''}`;
    }
  }

  // ---------- Passport / guild card for the landing page ----------
  function card(target) {
    if (!target) return;
    const p = profile(), l = level();
    const ids = Object.keys(cfg.badges);
    const stats = Object.entries(cfg.statLabels).map(([k, label]) => `<div><b>${k === 'games' ? p.games : k === 'wins' ? p.wins : p.stats[k] || 0}</b><small>${label}</small></div>`).join('');
    target.innerHTML = `
      <div class="fx-card-top"><div class="fx-card-rank"><small>${cfg.cardTitle || 'YOUR RANK'}</small><b>${l.name}</b></div><div class="fx-card-level"><small>RANK</small><b>${l.number}</b></div></div>
      <div class="fx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(l.frac * 100)}" aria-label="Progress to next rank"><i style="width:${(l.frac * 100).toFixed(1)}%"></i></div>
      <div class="fx-card-xp">${p.xp} XP${l.hi ? ` · ${l.hi - p.xp} to ${cfg.ranks[Math.min(l.index + 1, cfg.ranks.length - 1)]}` : ' · top rank'}</div>
      <div class="fx-card-stats">${stats}</div>
      <div class="fx-card-sub">${cfg.badgeShelf || 'BADGES'} · ${ids.filter(has).length} of ${ids.length}</div>
      <div class="fx-shelf">${ids.map(id => { const b = cfg.badges[id], got = has(id); return `<div class="fx-slot ${got ? 'got' : ''}" title="${got ? `${b.name}: ${b.desc}` : `Locked: ${b.desc}`}"><span>${got ? b.icon || '★' : '?'}</span><small>${got ? b.name : '???'}</small></div>`; }).join('')}</div>`;
  }

  // ---------- Toasts, splashes and floating text ----------
  function toast(html, cls = '', ms = 3200) {
    const t = el('div', `fx-toast ${cls}`, html);
    toasts.append(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 400); }, ms);
  }
  function splash({ kicker = '', title = '', sub = '', ms = 1700, cls = '' }) {
    const s = el('div', `fx-splash ${cls}`, `<div class="fx-splash-card"><small>${kicker}</small><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>`);
    document.body.append(s);
    requestAnimationFrame(() => s.classList.add('in'));
    return new Promise(done => setTimeout(() => { s.classList.add('out'); setTimeout(() => { s.remove(); done(); }, 380); }, reduce ? Math.min(ms, 1200) : ms));
  }
  function float(target, text, cls = '') {
    const r = rect(target); if (!r) return;
    const f = el('span', `fx-float ${cls}`, text);
    f.style.left = `${r.x + r.w / 2}px`; f.style.top = `${r.y + r.h / 3}px`;
    layer.append(f);
    setTimeout(() => f.remove(), 1300);
  }
  function rect(target) {
    if (!target) return null;
    if (target.getBoundingClientRect) { const b = target.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }
    return { x: target.x, y: target.y, w: 0, h: 0 };
  }

  // ---------- Particles ----------
  function burst(target, { count = 22, spread = 1, up = 1 } = {}) {
    if (reduce) return;
    const r = rect(target); if (!r) return;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    for (let i = 0; i < count; i++) {
      const p = el('span', 'fx-particle', cfg.particles[i % cfg.particles.length]);
      p.style.left = `${cx}px`; p.style.top = `${cy}px`;
      layer.append(p);
      const angle = Math.random() * Math.PI * 2, speed = (80 + Math.random() * 180) * spread;
      const dx = Math.cos(angle) * speed, dy = Math.sin(angle) * speed * 0.7 - 120 * up, rot = (Math.random() - 0.5) * 720;
      p.animate([
        { transform: 'translate(-50%,-50%) rotate(0deg) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.6}px), calc(-50% + ${dy * 0.6}px)) rotate(${rot * 0.6}deg) scale(1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 220}px)) rotate(${rot}deg) scale(.7)`, opacity: 0 },
      ], { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.4,1)' }).onfinish = () => p.remove();
    }
  }

  // ---------- Numbers, lists and text ----------
  function countUp(node, to, { from = 0, ms = 900, prefix = '', suffix = '' } = {}) {
    if (!node) return;
    if (reduce || from === to) { node.textContent = `${prefix}${to}${suffix}`; return; }
    const start = performance.now();
    const step = t => {
      const k = Math.min(1, (t - start) / ms), eased = 1 - Math.pow(1 - k, 3);
      node.textContent = `${prefix}${Math.round(from + (to - from) * eased)}${suffix}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // FLIP: call before re-rendering a list, then call the returned function afterwards.
  function flip(container, selector = '[data-flip]') {
    if (!container || reduce) return () => {};
    const before = new Map([...container.querySelectorAll(selector)].map(n => [n.dataset.flip, n.getBoundingClientRect().top]));
    return () => {
      for (const n of container.querySelectorAll(selector)) {
        const was = before.get(n.dataset.flip); if (was == null) continue;
        const dy = was - n.getBoundingClientRect().top;
        if (Math.abs(dy) > 2) n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 650, easing: 'cubic-bezier(.2,.8,.3,1)' });
      }
    };
  }
  function typewriter(node, text, speed = 38) {
    if (!node) return;
    if (reduce) { node.textContent = text; return; }
    node.textContent = ''; node.classList.add('fx-typing');
    let i = 0;
    const next = () => { node.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(next, speed); else node.classList.remove('fx-typing'); };
    next();
  }
  function shake(node, strength = 1) {
    if (!node || reduce) return;
    node.animate([0, -8, 7, -5, 4, -2, 0].map(x => ({ transform: `translateX(${x * strength}px)` })), { duration: 420 });
  }
  async function share(text, title) {
    if (navigator.share && matchMedia('(pointer:coarse)').matches) { try { await navigator.share({ title, text }); return 'Shared.'; } catch { return ''; } }
    try { await navigator.clipboard.writeText(text); return 'Result copied. Paste it anywhere.'; } catch { return 'Copy failed. Select the text and copy it.'; }
  }

  return { setup, profile, level, addXP, bump, stat, has, unlock, recordGame, paintChips, card, toast, splash, float, burst, countUp, flip, typewriter, shake, share, reduce };
})();
