(() => {
  // Example name in the name box: a random common British or US first name.
  const EXAMPLE_NAMES = ['Oliver', 'Amelia', 'Harry', 'Isla', 'George', 'Poppy', 'Alfie', 'Freya', 'Jack', 'Ella', 'Ethan', 'Madison', 'Tyler', 'Hannah', 'Logan', 'Avery', 'Mason', 'Chloe', 'Carter', 'Brooke'];
  document.getElementById('player-name').placeholder = `e.g. ${EXAMPLE_NAMES[Math.floor(Math.random() * EXAMPLE_NAMES.length)]}`;
  // Example room code under the code box, using the same letters real codes use.
  const EXAMPLE_CODE = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
  document.getElementById('room-code').placeholder = EXAMPLE_CODE;
  document.querySelectorAll('[data-example-code]').forEach(el => { el.textContent = EXAMPLE_CODE; });
  const $ = (selector, root = document) => root.querySelector(selector);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const landing = $('#landing'), game = $('#game'), toastEl = $('#toast'), announcer = $('#announcer');
  const LABELS = ['A', 'B', 'C'];
  const PROMPTS = [
    ['A place I have been', 'I have been to '], ['Something I ate once', 'I once ate '], ['A job I have had', 'I once worked as '],
    ['A thing I can do', 'I can '], ['Someone I have met', 'I once met '], ['A record I hold', 'I hold the record for '],
    ['A pet or animal story', 'I once had a pet '], ['Something I own', 'I own '], ['A school memory', 'At school, I '],
    ['A trip that went wrong', 'On a trip to '], ['A food I refuse to eat', 'I refuse to eat '], ['A skill I learned as a kid', 'As a kid I learned to '],
  ];

  // Carnival avatars (server assigns each seat a distinct index) and the six crowd reactions.
  const AVATAR_ICONS = ['🎩', '🎪', '🎠', '🎡', '🦁', '🐘', '🤡', '🎭', '🍿', '🎈', '🎯', '🃏', '🔮', '🎺', '🦜', '🐻'];
  const AVATAR_COLORS = ['#C23B2E', '#1B2A49', '#D9A21B', '#2F6B5E', '#8A4F7D', '#B86B2C', '#4A6FA5', '#6B7F3A'];
  const REACTIONS = ['😂', '😱', '🤥', '👏', '🔥', '🤔'];
  let socket = null, state = null, selfId = null, priv = {}, clockOffset = 0;
  let view = null, spotView = {}, timers = [], hudHold = false, hudShown = null, tickFn = null, tickFns = [], pick = { choice: null, double: false }, lastAnnounced = null, confirmRemove = 0;
  let retries = 0, retryTimer = null, leaving = false, silentJoin = false;

  const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const readDraft = () => { try { return JSON.parse(sessionStorage.getItem(`tent-draft-${state.code}`)); } catch { return null; } };
  const writeDraft = value => { try { sessionStorage.setItem(`tent-draft-${state.code}`, JSON.stringify(value)); } catch {} };
  let saved = read('tent-player') || {};

  const now = () => Date.now() + clockOffset;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fmt = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const secondsLeft = () => state?.endsAt ? Math.max(0, Math.ceil((state.endsAt - now()) / 1000)) : 0;
  const me = () => state?.players.find(p => p.id === selfId);
  const isHost = () => state?.hostId === selfId;
  const nameOf = id => state?.players.find(p => p.id === id)?.name || 'A guest';
  const hostName = () => nameOf(state.hostId);
  const isAuthor = () => state?.spotlight?.authorId === selfId;
  const canBet = () => (state?.phase === 'bet' || state?.phase === 'call') && !isAuthor() && me() && !me().spectator;
  const list = names => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const later = (ms, fn) => { timers.push(setTimeout(fn, ms)); };
  function avatar(id, size = 'sm') {
    const p = state?.players.find(x => x.id === id), i = p?.avatar ?? 0;
    return `<span class="av ${size}" style="--av:${AVATAR_COLORS[i % AVATAR_COLORS.length]}" aria-hidden="true">${AVATAR_ICONS[i % AVATAR_ICONS.length]}${p?.isBot ? '<i class="av-bot">BOT</i>' : ''}</span>`;
  }
  const buzz = pattern => { try { navigator.vibrate?.(pattern); } catch {} };

  // ---------- Sound: every effect is synthesised, so there are no audio files to load ----------
  const sound = (() => {
    const button = $('#sound-toggle');
    let ctx = null, on = read('tent-sound') !== false;
    const paint = () => { button.setAttribute('aria-pressed', on); button.setAttribute('aria-label', on ? 'Sound on' : 'Sound off'); button.classList.toggle('muted', !on); };
    const unlock = () => {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
      if (ctx?.state === 'suspended') ctx.resume();
    };
    const envelope = (node, t, peak, dur) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      node.connect(g); g.connect(ctx.destination);
    };
    const osc = (type, from, to, t, dur, peak) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(from, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      envelope(o, t, peak, dur); o.start(t); o.stop(t + dur + 0.02);
    };
    const noise = (t, dur, peak, cutoff) => {
      const length = Math.floor(ctx.sampleRate * dur), buffer = ctx.createBuffer(1, length, ctx.sampleRate), data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter();
      src.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = cutoff; src.connect(filter);
      envelope(filter, t, peak, dur); src.start(t);
    };
    const effects = {
      stamp: t => { noise(t, 0.08, 0.5, 1200); osc('sine', 140, 50, t, 0.16, 0.6); },
      tap: t => { noise(t, 0.03, 0.12, 2400); osc('triangle', 520, 0, t, 0.05, 0.06); },
      chip: t => { osc('sine', 2093, 0, t, 0.25, 0.1); osc('sine', 2637, 0, t + 0.05, 0.3, 0.08); },
      lock: t => { effects.tap(t); osc('square', 660, 990, t + 0.03, 0.08, 0.05); },
      tick: t => osc('square', 1400, 0, t, 0.025, 0.035),
      drum: t => { for (let i = 0; i < 14; i++) noise(t + i * 0.045, 0.04, 0.12 + i * 0.012, 900); },
      bell: t => [880, 1320, 1760].forEach((f, i) => osc('sine', f, 0, t + i * 0.004, 1.1 - i * 0.3, 0.15 / (i + 1))),
      fail: t => { osc('sawtooth', 420, 150, t, 0.5, 0.06); },
      win: t => [523, 659, 784, 1047].forEach((f, i) => osc('triangle', f, 0, t + i * 0.12, 0.35, 0.12)),
      badge: t => { effects.stamp(t); [1047, 1568].forEach((f, i) => osc('sine', f, 0, t + 0.12 + i * 0.1, 0.6, 0.08)); },
      levelup: t => { effects.win(t); effects.bell(t + 0.5); },
    };
    paint();
    button.addEventListener('click', () => { on = !on; write('tent-sound', on); paint(); if (on) play('tap'); });
    addEventListener('pointerdown', unlock, { once: true });
    addEventListener('keydown', unlock, { once: true });
    function play(name) { if (!on) return; unlock(); if (!ctx) return; try { effects[name](ctx.currentTime + 0.01); } catch {} }
    return { play };
  })();

  // ---------- Midway rank, badges and share card (fx.js) ----------
  const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  FX.setup({
    key: 'tall-tale-tent', sound: name => sound.play(name), cardTitle: 'MIDWAY RANK', levelKicker: 'TOP OF THE BILL', badgeKicker: 'RIBBON WON', badgeShelf: 'RIBBONS',
    ranks: ['Rube', 'Townie', 'Ticket Taker', 'Roustabout', 'Shill', 'Talker', 'Showman', 'Ringmaster', 'Legend of the Midway'],
    statLabels: { games: 'Shows', wins: 'Top bill', spotted: 'Spotted', fooled: 'Fooled' },
    particles: ['<i class="pt-ticket"></i>', '<i class="pt-ticket red"></i>', '<i class="pt-pop"></i>', '<i class="pt-star">★</i>', '<i class="pt-ticket blue"></i>'],
    badges: {
      mirrors: { name: 'Smoke and Mirrors', desc: 'Lure someone onto a true ticket with a bluffed spotlight.', icon: icon('M12 2a3 3 0 0 1 3 3v2h-6V5a3 3 0 0 1 3-3zM5 9h14l-3 13H8z'), xp: 50 },
      spotted: { name: 'Eagle Eye', desc: 'Spot a whopper.', icon: icon('M12 5c5 0 9 5 10 7-1 2-5 7-10 7S3 14 2 12c1-2 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'), xp: 30 },
      double: { name: 'Brass Nerve', desc: 'Win a Go Double bet.', icon: icon('M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-3 6l-1 1 3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3z'), xp: 40 },
      poker: { name: 'Poker Face', desc: 'Fool three or more people with one set of tales.', icon: icon('M5 4h14v16H5zm3 4v2h2V8zm6 0v2h2V8zm-6 6v2h8v-2z'), xp: 50 },
      sweep: { name: 'Clean Sweep', desc: 'Fool every single guesser in the tent.', icon: icon('M3 21l8-8 2 2-8 8zM14 3l7 7-5 5-7-7z'), xp: 60 },
      hound: { name: 'Truth Hound', desc: 'Spot every whopper in a game (three or more).', icon: icon('M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z'), xp: 70 },
      top: { name: 'Top Billing', desc: 'Finish a game in first place.', icon: icon('M2 7l5 4 5-7 5 7 5-4-2 12H4z'), xp: 60 },
      longshot: { name: 'Long Shot', desc: 'Back the whopper while the crowd bet elsewhere.', icon: icon('M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'), xp: 50 },
    },
  });
  FX.card($('#rank-card'));
  const processed = new Set();
  let gameLog = { guesses: 0, spotted: 0 };
  // XP and ribbons are earned once per reveal and once per final, on this device only.
  function processReveal() {
    const s = state, sl = s.spotlight, r = sl?.reveal, key = `${s.code}:${sl?.number}:${sl?.authorId}`;
    if (!r || processed.has(key)) return;
    processed.add(key);
    const mine = r.results.find(x => x.id === selfId);
    if (mine?.choice) {
      gameLog.guesses++;
      if (mine.correct) { gameLog.spotted++; FX.bump('spotted'); FX.unlock('spotted'); if (mine.double) FX.unlock('double'); if (mine.longShot) FX.unlock('longshot'); }
      setTimeout(() => FX.addXP(mine.correct ? (mine.double ? 30 : 15) : 5, $('.my-result')), 1200);
    }
    if (sl.authorId === selfId && r.fooled) {
      FX.bump('fooled', r.fooled);
      if (r.fooled >= 3) FX.unlock('poker');
      if (r.everyone && r.results.length >= 2) FX.unlock('sweep');
      if (r.nudgeFooled) FX.unlock('mirrors');
      setTimeout(() => FX.addXP(r.fooled * 10, $('.my-result')), 1200);
    }
  }
  function processFinal() {
    const s = state, f = s.final, key = `${s.code}:final:${f?.leaderboard.map(p => p.score).join(',')}`;
    if (!f || processed.has(key) || !f.leaderboard.some(p => p.id === selfId)) return;
    processed.add(key);
    const top = f.leaderboard[0], won = top && top.id === selfId && top.score > 0;
    FX.recordGame(won);
    if (won) FX.unlock('top');
    if (gameLog.guesses >= 3 && gameLog.spotted === gameLog.guesses) FX.unlock('hound');
    setTimeout(() => FX.addXP(20 + (won ? 60 : 0), $('.final-head')), 1800);
  }
  function shareText() {
    const s = state, f = s.final, place = f.leaderboard.findIndex(p => p.id === selfId), p = f.leaderboard[place];
    const tickets = s.lineup.map(x => x.status === 'skipped' ? '⬜' : x.id === selfId ? '🎪' : '🎟️').join('');
    return `The Tall Tale Tent · tent ${s.code}\n${tickets}\n${p ? `${p.name}: ${p.score} pts, ${ordinal(place + 1)} of ${f.leaderboard.length}\n🔍 ${p.correct} spotted · 🎭 ${p.fooled} fooled · 🪙 ${p.doubleWins} Go Double${p.doubleWins === 1 ? '' : 's'} won` : ''}\nMidway rank: ${FX.level().name}`;
  }
  const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;

  function toast(message) {
    toastEl.textContent = message; toastEl.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  function announce(message) { announcer.textContent = ''; setTimeout(() => { announcer.textContent = message; }, 60); }
  setInterval(() => tickFn?.(), 200);

  // ---------- Landing ----------
  const params = new URLSearchParams(location.search);
  const linkCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const nameInput = $('#player-name'), codeInput = $('#room-code'), landingError = $('#landing-error');
  nameInput.value = saved.name || '';
  codeInput.value = linkCode;
  $('#ticket-no').textContent = String(1000 + Math.floor(Math.random() * 9000));
  if (linkCode) landing.classList.add('invited');
  const paradeYou = $('.parade .you');
  const paintYou = () => { const n = nameInput.value.trim(); paradeYou.querySelector('.av').textContent = n ? n[0].toUpperCase() : '?'; paradeYou.querySelector('small').textContent = n || 'You'; };
  nameInput.addEventListener('input', paintYou); paintYou();

  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  $('#landing-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = checkName(); if (!name) return;
    const code = codeInput.value;
    if (code.length !== 4) { landingError.textContent = 'Enter the four-letter tent code.'; codeInput.focus(); return; }
    connect({ type: 'room:join', name, code, token: saved.code === code ? saved.token : undefined });
  });
  $('#host-button').addEventListener('click', () => { const name = checkName(); if (name) connect({ type: 'room:create', name, mode: $('input[name="mode"]:checked').value }); });
  $('#practice-button').addEventListener('click', () => { const name = checkName(); if (name) connect({ type: 'room:practice', name }); });
  function checkName() {
    const name = nameInput.value.trim();
    if (name.length >= 2 && name.length <= 14) return name;
    landingError.textContent = 'Choose a name between 2 and 14 characters.'; nameInput.focus(); return null;
  }
  function setBusy(busy) { landing.querySelectorAll('button').forEach(b => { b.disabled = busy; }); }

  // How-to-play: three cards, shown once on the first visit.
  const howto = $('#howto'), cards = [...howto.querySelectorAll('.how-card')];
  let card = 0;
  function showCard(n) {
    card = Math.max(0, Math.min(cards.length - 1, n));
    cards.forEach((c, i) => { c.hidden = i !== card; });
    [...$('#how-dots').children].forEach((d, i) => d.classList.toggle('on', i === card));
    $('#how-back').disabled = card === 0;
    $('#how-next').textContent = card === cards.length - 1 ? 'Step right up!' : 'Next →';
  }
  $('#how-back').addEventListener('click', () => showCard(card - 1));
  $('#how-next').addEventListener('click', () => { if (card === cards.length - 1) howto.close(); else showCard(card + 1); });
  $('#help-open').addEventListener('click', () => { showCard(0); howto.showModal(); });
  $('#help-close').addEventListener('click', () => howto.close());
  if (!read('tent-howto')) { setTimeout(() => { if (!howto.open) { showCard(0); howto.showModal(); } }, 600); write('tent-howto', true); }

  // ---------- Connection ----------
  function connect(hello) {
    landingError.textContent = ''; leaving = false; clearTimeout(retryTimer);
    if (socket) { socket.onclose = null; socket.close(); }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
    socket = ws; if (!state) setBusy(true);
    ws.onopen = () => { retries = 0; document.body.classList.remove('offline'); ws.send(JSON.stringify(hello)); };
    ws.onmessage = event => onMessage(JSON.parse(event.data));
    ws.onclose = () => {
      if (ws !== socket) return;
      setBusy(false);
      if (leaving || !state) { if (!state && !leaving && !silentJoin) landingError.textContent = 'Could not reach the tent. Try again.'; silentJoin = false; return; }
      document.body.classList.add('offline');
      retryTimer = setTimeout(() => connect({ type: 'room:join', code: state.code, token: saved.token }), Math.min(8000, 600 * 2 ** retries++));
    };
  }
  const send = (type, data = {}) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...data })); };

  function onMessage(msg) {
    if (msg.type === 'room:state') {
      const previous = state;
      state = msg.state; selfId = msg.selfId; priv = msg; clockOffset = state.serverNow - Date.now();
      saved = { name: me()?.name || saved.name, code: state.code, token: msg.token }; write('tent-player', saved);
      if (!previous) history.replaceState(null, '', `/?room=${state.code}`);
      silentJoin = false; setBusy(false); render(previous); return;
    }
    if (msg.type === 'submission:ack') return onAck(msg);
    if (msg.type === 'react') return showReaction(msg);
    if (msg.type === 'error') {
      if (msg.code === 'no-room') {
        const hadTent = !!state; forget(); showLanding();
        if (hadTent) landingError.textContent = 'That tent has packed up. Raise a new one.';
        else if (!silentJoin) landingError.textContent = 'No tent by that code. Check it with your Barker.';
        silentJoin = false;
        return;
      }
      if (msg.code === 'replaced') { leaving = true; toast(msg.message); return; }
      if (state) toast(msg.message); else { landingError.textContent = msg.message; setBusy(false); }
    }
  }
  function forget() { saved = { name: saved.name }; write('tent-player', saved); history.replaceState(null, '', '/'); }
  function showLanding() {
    state = null; view = null; tickFn = null;
    game.classList.add('hidden'); game.innerHTML = ''; landing.classList.remove('hidden', 'invited');
    FX.card($('#rank-card'));
    timers.forEach(clearTimeout); timers = []; paintHud();
    document.body.classList.remove('offline'); setBusy(false);
  }
  // A refresh drops straight back into the same tent and seat.
  if (saved.token && saved.code && (!linkCode || linkCode === saved.code)) { silentJoin = true; connect({ type: 'room:join', code: saved.code, token: saved.token }); }

  // ---------- Rendering ----------
  function render(previous) {
    landing.classList.add('hidden'); game.classList.remove('hidden');
    const key = `${state.phase === 'call' ? 'bet' : state.phase}:${state.spotlightIndex}:${state.spotlight?.cancelled || ''}`, fresh = key !== view;
    view = key;
    if (fresh) {
      tickFn = null; lastAnnounced = null; confirmRemove = 0; window.scrollTo({ top: 0 });
      timers.forEach(clearTimeout); timers = [];
      // The HUD keeps the old numbers until the stamp lands, so it can't spoil the reveal.
      hudHold = state.phase === 'reveal' && !!state.spotlight?.reveal && !state.spotlight.cancelled;
    }
    if (state.phase === 'lobby') renderLobby();
    else if (state.phase === 'writing') { if (fresh) buildWriting(); updateWriting(); }
    else if (state.phase === 'read' || state.phase === 'bet' || state.phase === 'call') { if (fresh) buildSpotlight(previous); updateSpotlight(); }
    else if (state.phase === 'reveal') { if (fresh) buildReveal(); paintChrome(); }
    else if (state.phase === 'final') { if (fresh) buildFinal(); paintChrome(); }
    paintHud();
  }
  // ---------- HUD: always-on score, rank, chips, spotlight swing and streak ----------
  function paintHud(pop) {
    const el = $('#hud'), self = me();
    if (!state || state.phase === 'lobby' || !self) { el.classList.add('hidden'); document.body.classList.remove('has-hud'); hudShown = null; return; }
    el.classList.remove('hidden'); document.body.classList.add('has-hud');
    const table = state.players.filter(p => !p.spectator);
    const live = { score: self.score, chips: self.chipsLeft, streak: self.streak, nudges: self.nudgesLeft, rank: [...table].sort((a, b) => b.score - a.score).findIndex(p => p.id === selfId) + 1 };
    const show = hudHold && hudShown ? hudShown : live;
    const ranked = state.spotlightIndex > 0 || state.phase === 'reveal' || state.phase === 'final';
    const html = self.spectator ? `<div class="hud-me">${avatar(selfId, 'md')}<div><b>${esc(self.name)}</b><small>Watching from the back row</small></div></div>`
      : `<div class="hud-me">${avatar(selfId, 'md')}<div><b>${esc(self.name)}</b><small>${ranked && table.length > 1 ? `#${show.rank} of ${table.length}` : 'Ready for the show'}</small></div></div>
        <div class="hud-score"><b id="hud-score">${hudShown ? hudShown.score : show.score}</b><small>POINTS</small></div>
        <div class="hud-kit" aria-label="${show.chips} Go Double ${show.chips === 1 ? 'chip' : 'chips'}${show.nudges ? ', spotlight swing ready' : ''}${show.streak >= 2 ? `, streak ${show.streak}` : ''}">
          ${Array.from({ length: Math.max(state.chipsPerPlayer || 1, show.chips) }, (_, i) => `<span class="hud-chip ${i < show.chips ? '' : 'spent'}" title="Go Double chip">×2</span>`).join('')}
          <span class="hud-swing ${show.nudges ? '' : 'spent'}" title="Spotlight swing">☼</span>
          ${show.streak >= 2 ? `<span class="hud-streak" title="Streak">🔥${show.streak}</span>` : ''}
        </div>`;
    if (el.__html !== html || (hudShown && hudShown.score !== show.score)) {
      const from = hudShown?.score ?? show.score;
      el.innerHTML = html; el.__html = html;
      if (from !== show.score) { FX.countUp($('#hud-score'), show.score, { from }); if (pop) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); } }
    }
    hudShown = show;
  }
  // ---------- Crowd reactions ----------
  function reactBar() {
    return `<div class="react-bar" role="group" aria-label="React to the tale">${REACTIONS.map((e, i) => `<button type="button" class="react" data-action="react" data-e="${i}" aria-label="React ${e}">${e}</button>`).join('')}</div>`;
  }
  function showReaction(msg) {
    const layer = $('#react-layer'); if (!layer || layer.children.length > 24) return;
    const b = document.createElement('span');
    b.className = 'bubble'; b.style.left = `${8 + Math.random() * 80}%`; b.style.setProperty('--drift', `${(Math.random() - 0.5) * 80}px`);
    b.innerHTML = `${REACTIONS[msg.e] || '👏'}${avatar(msg.id, 'xs')}`;
    layer.append(b); setTimeout(() => b.remove(), FX.reduce ? 1200 : 2800);
  }
  // The tent header, "your move" bar and Barker tools are repainted on every update.
  function paintChrome() {
    const head = $('#tent-head'); if (head) { const html = tentHead(); if (head.__html !== html) { head.innerHTML = html; head.__html = html; } }
    const tools = $('#barker'); if (tools) { const html = barkerTools(); if (tools.__html !== html) { tools.innerHTML = html; tools.__html = html; } }
    if (state.phase === 'final') paintFinalFoot();
  }
  function tentHead() {
    const c = coach();
    return `<div class="tenthead">
      <button class="tent-code" data-action="invite" aria-label="Tent code ${state.code}. Copy invite link" title="Copy invite link">${[...state.code].map(ch => `<span class="code-ticket">${ch}</span>`).join('')}</button>
      <div class="tent-meta"><span class="kicker">TENT CODE · ${state.mode === 'classroom' ? 'CLASSROOM RULES' : 'PARTY RULES'}${state.practice ? ' · PRACTICE' : ''}</span><button class="link-button" data-action="invite">Copy invite link</button></div>
      <div class="tent-right">${isHost() ? '<span class="barker-sign small">You are the Barker</span>' : `<span class="kicker">BARKER · ${esc(hostName())}</span>`}<button class="link-button" data-action="leave">Leave tent</button></div>
    </div>${c ? `<div class="coach" role="note"><span class="coach-tag">YOUR MOVE</span><div class="coach-text"><b>${c[0]}</b>${c[1] ? `<span>${c[1]}</span>` : ''}</div></div>` : ''}`;
  }
  // One plain instruction for what to do right now, by phase and role.
  function coach() {
    const p = state.phase, host = isHost(), self = me(), spectator = self?.spectator, sl = state.spotlight;
    const need = state.minPlayers - state.players.length;
    if (p === 'lobby') return host ? [need > 0 ? `Wait for ${need} more ${need === 1 ? 'player' : 'players'}, then press RAISE THE CURTAIN.` : 'Everyone in? Press RAISE THE CURTAIN.', 'The tent needs 4 to 15 players. Short of people? Tap + Add a sideshow bot.'] : [`Wait for ${esc(hostName())} to raise the curtain.`, 'Have three short facts about yourself in mind: two true, one made up.'];
    if (spectator) return ['You are watching from the back row.', 'You can watch every spotlight, and you will be dealt in at the next game.'];
    if (p === 'writing') return self?.submitted ? ['Tales handed in. Now wait for the others.', 'You can still edit and hand them in again until the clock runs out.'] : ['Write two true tales and one lie about yourself, then mark the lie.', 'Keep each under 100 characters. Stuck? Tap a prompt chip below for a starter.'];
    if (p === 'read') return isAuthor() ? ['Keep a straight face! Everyone is reading your tales.', 'You cannot bet this round. You score +50 for every person you fool.'] : [`Read ${esc(sl.authorName)}'s three tales. Which one sounds made up?`, 'Betting opens in a few seconds.'];
    if (p === 'call') {
      if (isAuthor()) return ['Last Call! Keep that straight face.', 'The crowd can see how the bets are split. Every wrong guess is +50 for you.'];
      return ['LAST CALL! The tote board shows how the crowd bet.', `Hold firm or switch, then make sure you're locked in. If the whopper held under half of the bets and you were already on it, you get a long-shot bonus of +50.`];
    }
    if (p === 'bet') {
      if (isAuthor()) return sl.nudge ? [`You swung the spotlight onto ${sl.nudge}. Keep a straight face!`, 'Everyone can see it. Only you know whether it was a hint or a bluff.'] : self?.nudgesLeft > 0 ? ['Keep a straight face, and work the spotlight if you dare.', 'Once per game, you can swing the spotlight onto one ticket. Point it at the truth to bluff, or at the lie to double-bluff.'] : ['Keep a straight face. No hints!', 'You score +50 for every wrong guess.'];
      if (priv.myBet?.locked) return [`You're locked in on ${LABELS[priv.myBet.choice]}${priv.myBet.double ? ' with Go Double' : ''}.`, 'Changed your mind? Tap another ticket, then LOCK IT IN again before time runs out.'];
      if (sl.nudge) return [`${esc(sl.authorName)} swung the spotlight onto ${sl.nudge}. Hint or bluff?`, 'Tap the ticket you think is the whopper and LOCK IT IN. At Last Call you will see how the crowd bet.'];
      return ['Tap the ticket you think is the whopper, then press LOCK IT IN.', `Sure of it? Turn on Go Double first (right +200, wrong −50). You have ${self?.chipsLeft ?? 0} ${self?.chipsLeft === 1 ? 'chip' : 'chips'}. Bets that aren't locked in don't count.`];
    }
    if (p === 'reveal') return sl?.cancelled ? ['This tale is off. On to the next one.', ''] : ['See who spotted the whopper.', 'The next player steps into the spotlight in a moment.'];
    if (p === 'final') return host ? ['The show is over. Press PLAY AGAIN to keep the tent and start fresh.', 'Everyone writes new tales; scores and chips reset.'] : ['The show is over. Share your result, or wait for the Barker to play again.', ''];
    return null;
  }
  function barkerTools() {
    if (!isHost()) return '';
    const p = state.phase, timed = ['writing', 'read', 'bet'].includes(p), left = state.extendsLeft;
    const buttons = [];
    if (timed) buttons.push(`<button class="button ghost small" data-action="extend" ${left > 0 ? '' : 'disabled'}>+15s <small>${left} left</small></button>`);
    if (p === 'writing') buttons.push('<button class="button ghost small" data-action="skip">Close the booth now</button>');
    if (p === 'read' || p === 'bet' || p === 'call') buttons.push('<button class="button ghost small" data-action="skip">Skip this player</button>');
    if ((p === 'read' || p === 'bet' || p === 'call' || p === 'reveal') && !state.spotlight?.cancelled) buttons.push(`<button class="button ghost small danger" data-action="remove">${confirmRemove > Date.now() ? 'Tap again to remove' : 'Remove these tales'}</button>`);
    if (p === 'reveal') buttons.push('<button class="button ghost small" data-action="skip">Next tale now →</button>');
    if (!buttons.length) return '';
    return `<div class="barker-tools"><span class="barker-sign">The Barker's tools</span><div class="tool-row">${buttons.join('')}</div></div>`;
  }
  function timerMarkup(label) {
    return `<div class="timer" role="timer" aria-label="${label}"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="t-track" cx="20" cy="20" r="17"/><circle class="t-fill" id="t-fill" cx="20" cy="20" r="17"/></svg><b id="clock">0:00</b></div>`;
  }
  // Every screen with a clock shares this tick: the digits, the ring, last-seconds ticks and a spoken update every 10 seconds.
  function startClock(total) {
    let last = null;
    tickFn = () => {
      const left = secondsLeft(); if (left === last) return; last = left;
      const clock = $('#clock'), fill = $('#t-fill');
      if (clock) clock.textContent = fmt(left);
      if (fill) fill.style.strokeDashoffset = String(107 * (1 - Math.min(1, left / Math.max(1, total()))));
      $('.timer')?.classList.toggle('urgent', left <= 5 && left > 0);
      if (left > 0 && left <= 3) sound.play('tick');
      if (left > 0 && left % 10 === 0 && left !== lastAnnounced) { lastAnnounced = left; announce(`${left} seconds left`); }
      tickFns.forEach(fn => fn(left));
    };
    tickFn();
  }

  // ---------- Lobby ----------
  function renderLobby() {
    const players = state.players, host = isHost(), ready = players.length >= state.minPlayers, need = state.minPlayers - players.length;
    tickFn = null; tickFns = [];
    game.innerHTML = `<div id="tent-head">${tentHead()}</div>
    <div class="lobby">
      <div class="section-title"><span class="kicker">THE BIG TOP · ${players.length} OF ${state.maxPlayers}</span><h2>Who's in the tent?</h2><p>${ready ? 'Enough for a show. More can join until the curtain rises.' : `Waiting for ${need} more ${need === 1 ? 'player' : 'players'}. Four makes a show.`}</p></div>
      <ul class="crowd">${players.map(p => `<li class="${p.id === selfId ? 'self' : ''}">${avatar(p.id, 'md')}<span class="crowd-name">${esc(p.name)}</span>${p.id === state.hostId ? '<span class="barker-sign tiny">Barker</span>' : ''}${p.id === selfId ? '<small class="tag">YOU</small>' : ''}${p.isBot ? `<small class="tag bot">BOT</small>${host ? `<button class="bot-x" data-action="removeBot" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>` : ''}` : ''}</li>`).join('')}
        ${host && players.length < state.maxPlayers ? '<li class="add"><button class="link-button" data-action="addBot">+ Add a sideshow bot</button></li>' : ''}</ul>
      <div class="invite-strip"><span class="kicker">CALL IN THE CROWD</span><code>${esc(location.host)}/?room=${state.code}</code><button class="button ghost small" data-action="invite">Copy link</button></div>
      <div class="lobby-foot">${host
        ? `<button class="button red big" data-action="start" ${ready ? '' : 'disabled'}>Raise the curtain <span aria-hidden="true">→</span></button><p class="hint">${ready ? `About a minute per player · ${players.length >= 10 ? 'two Go Double chips each' : 'one Go Double chip each'}` : `Needs ${need} more to start.`}</p>`
        : `<p class="waiting">Waiting for ${esc(hostName())} to raise the curtain<span class="dots" aria-hidden="true"></span></p>`}</div>
      ${state.mode === 'classroom' ? '<p class="notice">Classroom rules: first names only, a stricter word filter and 25% longer timers.</p>' : ''}
    </div>`;
  }

  // ---------- Writing ----------
  function buildWriting() {
    const self = me(), spectator = self?.spectator;
    tickFns = [];
    if (state.spotlightIndex < 0) gameLog = { guesses: 0, spotted: 0 };
    const draft = priv.mine || readDraft() || { statements: ['', '', ''], lieIndex: null };
    game.innerHTML = `<div id="tent-head">${tentHead()}</div>
    <div class="booth">
      <div class="screen-title"><div><span class="kicker">THE WRITING BOOTH</span><h2>Write your tales</h2></div>${timerMarkup('Writing time left')}</div>
      <div id="barker"></div>
      ${spectator ? '<p class="spectating">You arrived after the curtain went up. Watch this game from the back row; you will be dealt in at the next one.</p>' : `
      <form class="tales" id="tales" autocomplete="off" novalidate>
        <p class="tales-help">Two true, one tall. Tap <b>Lie</b> beside the made-up one.</p>
        ${[0, 1, 2].map(i => `<div class="tale-row" data-row="${i}">
          <label class="lie-pick"><input type="radio" name="lie" value="${i}" ${draft.lieIndex === i ? 'checked' : ''}><span aria-hidden="true"></span><b>Lie</b><span class="sr-only">Mark tale ${i + 1} as my lie</span></label>
          <div class="tale-field"><label class="sr-only" for="tale-${i}">Tale ${i + 1}</label><span class="tale-no" aria-hidden="true">${i + 1}</span>
            <textarea id="tale-${i}" rows="2" maxlength="${state.maxChars}" placeholder="${['I once met a mayor…', 'I can juggle four…', 'I have been to 31…'][i]}" enterkeyhint="next" spellcheck="true">${esc(draft.statements[i] || '')}</textarea>
            <span class="counter" id="count-${i}">0/${state.maxChars}</span></div>
          <p class="field-error" id="err-${i}" role="alert"></p>
        </div>`).join('')}
        <div class="chips"><span class="kicker">STUCK? TAP A STARTER</span><div class="chip-row">${PROMPTS.map(([label], i) => `<button type="button" class="prompt-chip" data-prompt="${i}">${label}</button>`).join('')}</div></div>
        <p class="form-error" id="tales-error" role="alert"></p>
        <button class="button red big" id="hand-in" type="submit">Hand to the Barker <span aria-hidden="true">→</span></button>
        <p class="hand-status" id="hand-status" aria-live="polite"></p>
      </form>`}
      <div class="readiness" id="readiness"></div>
    </div>`;
    const form = $('#tales');
    if (form) {
      let lastFocus = 0;
      const inputs = [0, 1, 2].map(i => $(`#tale-${i}`));
      const sync = () => {
        const statements = inputs.map(x => x.value), lie = form.querySelector('input[name="lie"]:checked');
        writeDraft({ statements, lieIndex: lie ? Number(lie.value) : null });
        inputs.forEach((x, i) => { const n = [...x.value].length, el = $(`#count-${i}`); el.textContent = `${n}/${state.maxChars}`; el.classList.toggle('near', n > state.maxChars - 15); });
        const done = statements.every(s => s.trim()) && !!lie;
        $('#hand-in').disabled = !done;
        $('#tales-error').textContent = done ? '' : !statements.every(s => s.trim()) ? '' : 'Tap Lie beside the made-up tale.';
        form.querySelectorAll('.tale-row').forEach((row, i) => row.classList.toggle('is-lie', lie && Number(lie.value) === i));
        form.dataset.dirty = '1';
        paintHandStatus();
      };
      inputs.forEach((x, i) => { x.addEventListener('input', () => { $(`#err-${i}`).textContent = ''; x.removeAttribute('aria-invalid'); sync(); }); x.addEventListener('focus', () => { lastFocus = i; }); });
      inputs.forEach((x, i) => x.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (i < 2) inputs[i + 1].focus(); else form.requestSubmit(); } }));
      form.addEventListener('change', sync);
      form.addEventListener('click', e => {
        const chip = e.target.closest('[data-prompt]'); if (!chip) return;
        const starter = PROMPTS[Number(chip.dataset.prompt)][1];
        const target = !inputs[lastFocus].value.trim() ? inputs[lastFocus] : inputs.find(x => !x.value.trim()) || inputs[lastFocus];
        target.value = starter; target.focus(); target.setSelectionRange(starter.length, starter.length);
        sound.play('tap'); sync();
      });
      form.addEventListener('submit', e => {
        e.preventDefault();
        const lie = form.querySelector('input[name="lie"]:checked');
        if (!lie || inputs.some(x => !x.value.trim())) return;
        send('submission:send', { statements: inputs.map(x => x.value), lieIndex: Number(lie.value) });
        $('#hand-in').disabled = true; $('#hand-status').textContent = 'Handing over…';
      });
      sync(); delete form.dataset.dirty; paintHandStatus();
    }
    startClock(() => 90 * (state.mode === 'classroom' ? 1.25 : 1));
    announce('Writing time. Write two truths and one lie.');
    sound.play('bell');
  }
  function paintHandStatus() {
    const el = $('#hand-status'), form = $('#tales'); if (!el || !form) return;
    const submitted = me()?.submitted;
    $('#hand-in').firstChild.textContent = submitted ? 'Update my tales ' : 'Hand to the Barker ';
    el.textContent = submitted ? (form.dataset.dirty ? 'You have unsaved changes. Hand them in again.' : '✓ Your tales are with the Barker. You can still edit them until time runs out.') : '';
    el.classList.toggle('done', !!submitted && !form.dataset.dirty);
  }
  function onAck(msg) {
    const form = $('#tales'); if (!form) return;
    if (msg.ok) {
      delete form.dataset.dirty; sound.play('stamp'); buzz(30);
      FX.float($('#hand-in'), 'HANDED IN!');
    } else {
      sound.play('fail');
      if (msg.field >= 0) { const err = $(`#err-${msg.field}`), input = $(`#tale-${msg.field}`); if (err) err.textContent = msg.message; input?.setAttribute('aria-invalid', 'true'); input?.focus(); FX.shake(input?.closest('.tale-field')); }
      else $('#tales-error').textContent = msg.message;
      $('#hand-in').disabled = false;
    }
    paintHandStatus();
  }
  function updateWriting() {
    paintChrome(); paintHandStatus();
    const table = state.players.filter(p => !p.spectator), ready = table.filter(p => p.submitted), waiting = table.filter(p => !p.submitted);
    $('#readiness').innerHTML = `<div><span class="kicker">READY · ${ready.length}</span><p>${ready.map(p => `<span class="pill done">✓ ${esc(p.name)}</span>`).join('') || '<span class="muted">Nobody yet</span>'}</p></div>
      <div><span class="kicker">STILL WRITING · ${waiting.length}</span><p>${waiting.map(p => `<span class="pill ${p.connected ? '' : 'gone'}">${esc(p.name)}${p.connected ? '' : ' (away)'}</span>`).join('') || '<span class="muted">Everyone is in. Curtain up in a moment!</span>'}</p></div>`;
  }

  // ---------- Spotlight: READ and BET ----------
  function lineup() {
    return `<ol class="lineup" aria-label="Spotlight order">${state.lineup.map((x, i) => `<li class="${x.status}" title="${esc(x.name)}${x.status === 'skipped' ? ' (skipped)' : ''}"><span>${i + 1}</span>${esc(x.name)}</li>`).join('')}${state.sitOut.map(n => `<li class="sat-out" title="${esc(n)} sat this one out">?</li>`).join('')}</ol>`;
  }
  function stubMarkup(stub, i, interactive) {
    const mineLie = isAuthor() && priv.authorLie === i;
    const inner = `<span class="stub-label">${stub.label}</span><span class="stub-text">${esc(stub.text)}</span><span class="stub-check" aria-hidden="true">✓</span>${mineLie ? '<span class="stub-note">your whopper</span>' : ''}`;
    return interactive
      ? `<button type="button" class="stub" data-label="${stub.label}" data-action="pick" data-choice="${stub.label}" aria-pressed="false" aria-label="Ticket ${stub.label}: ${esc(stub.text)}">${inner}</button>`
      : `<div class="stub ${mineLie ? 'own-lie' : ''}" data-label="${stub.label}" role="listitem" aria-label="Ticket ${stub.label}: ${esc(stub.text)}">${inner}</div>`;
  }
  function buildSpotlight(previous) {
    const sl = state.spotlight, betting = canBet(), self = me();
    tickFns = [];
    if (state.phase === 'read') pick = { choice: null, double: false };
    else if (priv.myBet) pick = { choice: LABELS[priv.myBet.choice], double: priv.myBet.double };
    const first = sl.number === 1 && state.phase === 'read';
    game.innerHTML = `<div id="tent-head">${tentHead()}</div>
    <div class="spotlight ${state.phase}">
      ${lineup()}
      <div class="screen-title"><div><span class="kicker" id="sl-kicker">TALE ${sl.number} OF ${sl.total} · ${state.phase === 'read' ? 'READ CAREFULLY' : 'PLACE YOUR BETS'}</span><h2>In the spotlight: <em>${esc(sl.authorName)}</em></h2></div>${timerMarkup(state.phase === 'read' ? 'Reading time left' : 'Betting time left')}</div>
      ${first && state.sitOut.length ? `<p class="notice">The Mystery Guest sat this one out: ${esc(list(state.sitOut))} didn't hand in tales in time.</p>` : ''}
      <div id="barker"></div>
      ${isAuthor() ? '<p class="straight-face">Keep a straight face!</p>' : ''}
      <p class="barker-line" id="barker-line">${state.phase === 'read' ? 'Step right up! One of these is a whopper.' : 'Which is the whopper?'}</p>
      <div id="spot-panel"></div>
      <div id="tote"></div>
      <div class="stubs" id="stubs" role="${betting ? 'group' : 'list'}" aria-label="${esc(sl.authorName)}'s tales">${sl.stubs.map((s, i) => stubMarkup(s, i, betting)).join('')}</div>
      ${betting ? `<div class="bet-bar">
        <button type="button" class="token" id="double" data-action="double" aria-pressed="false" ${self.chipsLeft > 0 ? '' : 'disabled'}><span class="token-coin" aria-hidden="true">×2</span><span><b>GO DOUBLE</b><small id="chips-left"></small></span><span class="token-check" aria-hidden="true">✓</span></button>
        <button type="button" class="button red big" id="lock" data-action="lock">Lock it in</button>
      </div>` : state.phase === 'read' && !isAuthor() && !self?.spectator ? '<p class="bet-soon">Betting opens when the timer runs out.</p>' : self?.spectator ? '<p class="spectating">You are watching from the back row. You can bet in the next game.</p>' : ''}
      <div class="rail-wrap" id="rail-wrap" hidden><span class="kicker" id="rail-label" aria-live="polite"></span><div class="rail" id="rail"></div></div>
      ${reactBar()}
    </div>`;
    spotView = { phase: state.phase, nudge: sl.nudge };
    startClock(() => ({ read: 10, bet: 25, call: 6 }[state.phase] || 10) * (state.mode === 'classroom' ? 1.25 : 1));
    if (state.phase === 'read') { FX.splash({ kicker: `TALE ${sl.number} OF ${sl.total} · STEP RIGHT UP`, title: `${avatar(sl.authorId, 'lg')}<em class="tc-name">${esc(sl.authorName)}</em>`, sub: isAuthor() ? "That's you! Keep a straight face." : 'steps into the spotlight', ms: 1400, cls: 'title-card' }); announce(`${sl.authorName} is in the spotlight. Ticket A: ${sl.stubs[0].text}. Ticket B: ${sl.stubs[1].text}. Ticket C: ${sl.stubs[2].text}.`); sound.play('bell'); if (!FX.reduce) dealStubs(); }
    else { announce(betting ? 'Bets are open. Pick A, B or C and lock it in.' : 'Bets are open.'); sound.play('tap'); }
  }
  // Who has locked in: an avatar per guesser, stamped IN when their bet is locked. Choices stay hidden.
  function paintRail(open) {
    const wrap = $('#rail-wrap'), rail = $('#rail'), sl = state.spotlight; if (!wrap) return;
    wrap.hidden = !open; if (!open) return;
    const crowd = state.players.filter(p => p.connected && !p.spectator && p.id !== sl.authorId), ids = crowd.map(p => p.id).join();
    if (rail.dataset.ids !== ids) { rail.dataset.ids = ids; rail.innerHTML = crowd.map(p => `<span class="rail-seat" data-id="${p.id}">${avatar(p.id, 'md')}<small>${esc(p.name)}</small><i class="rail-in">IN</i></span>`).join(''); }
    for (const seat of rail.children) {
      const was = seat.classList.contains('locked'), now = sl.lockedIds.includes(seat.dataset.id);
      seat.classList.toggle('locked', now);
      if (now && !was && seat.dataset.id !== selfId) sound.play('tap');
    }
    $('#rail-label').textContent = `${sl.lockedIds.length} of ${crowd.length} locked in`;
  }
  function paintSpotPanel() {
    const el = $('#spot-panel'), sl = state.spotlight; if (!el) return;
    let html = '';
    if (sl.nudge) html = `<p class="spot-banner"><span class="spot-icon" aria-hidden="true">☼</span>${isAuthor() ? `You swung the spotlight onto <b>${sl.nudge}</b>. Nobody else knows if it's honest.` : `<b>${esc(sl.authorName)}</b> swung the spotlight onto <b>${sl.nudge}</b>. Honest hint, or a bluff?`}</p>`;
    else if (isAuthor() && state.phase === 'bet' && me()?.nudgesLeft > 0) html = `<div class="spot-tools"><span class="kicker">WORK THE SPOTLIGHT · ONCE PER GAME</span><p>Swing the spotlight onto one ticket. Everyone sees it, but only you know whether it's a hint or a bluff.</p><div class="tool-row">${LABELS.map(l => `<button class="button ghost small" data-action="nudge" data-choice="${l}">☼ Onto ${l}</button>`).join('')}</div></div>`;
    if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
  }
  function paintTote() {
    const el = $('#tote'), t = state.spotlight.tote; if (!el) return;
    const html = t ? `<div class="tote-board" role="img" aria-label="Tote board: A ${t.A}, B ${t.B}, C ${t.C} of ${t.total} bets"><div class="tote-head"><span>THE TOTE BOARD</span><small>${t.total} ${t.total === 1 ? 'bet' : 'bets'} at last call</small></div><div class="tote-cols">${LABELS.map(l => `<div class="tote-col"><b>${t[l]}</b><i style="--h:${t.total ? t[l] / t.total : 0}"></i><span>${l}</span></div>`).join('')}</div><p class="tote-note">Long shot: were you already on the whopper while it held under half the bets? +50.</p></div>` : '';
    if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
  }
  function dealStubs() { [...$('#stubs').children].forEach((n, i) => n.animate([{ transform: 'translateY(30px) rotate(-3deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, delay: i * 140, easing: 'cubic-bezier(.2,.9,.3,1.2)', fill: 'backwards' })); }
  function updateSpotlight() {
    paintChrome();
    const sl = state.spotlight, call = state.phase === 'call';
    // Last Call flips the tote board in place, so a half-typed choice survives.
    if (call && spotView.phase !== 'call') {
      $('.spotlight').classList.add('last-call');
      $('#sl-kicker').textContent = `TALE ${sl.number} OF ${sl.total} · LAST CALL`;
      $('#barker-line').textContent = 'Last call! Hold firm or switch?';
      sound.play('bell'); buzz([30, 30, 30]);
      announce(`Last call. Tote board: A ${sl.tote.A}, B ${sl.tote.B}, C ${sl.tote.C}.`);
    }
    if (sl.nudge && spotView.nudge !== sl.nudge) {
      sound.play('chip');
      announce(isAuthor() ? `You swung the spotlight onto ticket ${sl.nudge}.` : `${sl.authorName} swung the spotlight onto ticket ${sl.nudge}.`);
      const lit = game.querySelector(`.stub[data-label="${sl.nudge}"]`); if (lit && !FX.reduce) lit.animate([{ transform: 'scale(1.04)' }, { transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2,1.4,.4,1)' });
    }
    spotView = { phase: state.phase, nudge: sl.nudge };
    game.querySelectorAll('.stubs .stub').forEach(n => n.classList.toggle('spotlit', n.dataset.label === sl.nudge));
    paintSpotPanel(); paintTote();
    paintRail(state.phase === 'bet' || call);
    if (!canBet()) return;
    const bet = priv.myBet, isLocked = !!bet?.locked && LABELS[bet.choice] === pick.choice && bet.double === pick.double;
    for (const btn of game.querySelectorAll('.stub[data-choice]')) {
      const on = btn.dataset.choice === pick.choice;
      btn.classList.toggle('picked', on); btn.classList.toggle('locked', on && isLocked); btn.setAttribute('aria-pressed', on);
    }
    const chips = me().chipsLeft, dbl = $('#double');
    dbl.setAttribute('aria-pressed', pick.double); dbl.classList.toggle('on', pick.double); dbl.disabled = chips < 1;
    $('#chips-left').textContent = `${chips} ${chips === 1 ? 'chip' : 'chips'} left · right +200, wrong −50`;
    const lock = $('#lock');
    lock.disabled = !pick.choice;
    lock.classList.toggle('done', isLocked);
    lock.innerHTML = isLocked ? `Locked in: ${pick.choice}${pick.double ? ' ×2' : ''} ✓` : pick.choice ? `Lock it in: ${pick.choice}${pick.double ? ' ×2' : ''}` : 'Pick a ticket first';
  }

  // ---------- Reveal: a staged show. Bets land, the truths flip one by one, a drum roll, then the stamp. ----------
  function buildReveal() {
    const sl = state.spotlight, r = sl.reveal;
    tickFns = [];
    if (sl.cancelled || !r) {
      const why = { left: `${esc(sl.authorName)} stepped out of the tent.`, skipped: `The Barker skipped ${esc(sl.authorName)}'s turn.`, removed: `The Barker removed ${esc(sl.authorName)}'s tales.` }[sl.cancelled] || 'This tale was called off.';
      game.innerHTML = `<div id="tent-head">${tentHead()}</div><div class="reveal cancelled">${lineup()}<div class="called-off"><span class="kicker">TALE ${sl.number} OF ${sl.total}</span><h2>${why}</h2><p>No points for this tale. On with the show!</p></div><div id="barker"></div><p class="next-line">Next up in <b id="next-in"></b></p></div>`;
      tickFns.push(left => { const n = $('#next-in'); if (n) n.textContent = `${left}s`; });
      startClock(() => 4);
      hudHold = false; paintHud();
      sound.play('fail'); announce(`${sl.authorName}'s turn is off. No points.`);
      return;
    }
    const byChoice = Object.fromEntries(LABELS.map(l => [l, r.results.filter(x => x.choice === l)]));
    const fooled = r.results.filter(x => x.choice && !x.correct), spotted = r.results.filter(x => x.correct), noBet = r.results.filter(x => !x.choice);
    const mine = r.results.find(x => x.id === selfId), author = sl.authorId === selfId;
    const myDelta = author ? r.authorDelta : mine?.delta;
    const headline = r.everyone ? 'Clean sweep!' : spotted.length && !fooled.length ? 'Nobody was fooled!' : 'The tent has spoken!';
    game.innerHTML = `<div id="tent-head">${tentHead()}</div>
    <div class="reveal staged">
      ${lineup()}
      <div class="screen-title"><div><span class="kicker">TALE ${sl.number} OF ${sl.total} · THE REVEAL</span><h2 id="reveal-head">And the whopper is…</h2></div></div>
      <div class="stubs revealed" role="list">${sl.stubs.map((s, i) => `<div class="stub pending ${s.label === sl.nudge ? 'spotlit' : ''}" data-pos="${i}" role="listitem" aria-label="Ticket ${s.label}: ${esc(s.text)}. ${i === r.liePos ? 'The whopper' : 'True'}.">
        <span class="stub-label">${s.label}</span><span class="stub-text">${esc(s.text)}</span>
        ${i === r.liePos ? '<span class="stamp" aria-hidden="true">WHOPPER!</span>' : '<span class="stamp true" aria-hidden="true">TRUE</span>'}
        <span class="votes">${byChoice[s.label].length ? byChoice[s.label].map(x => `<span class="vote ${x.double ? 'dbl' : ''} ${x.longShot ? 'long' : ''}" data-id="${x.id}">${avatar(x.id, 'xs')}<span>${esc(x.name)}${x.double ? ' ×2' : ''}${x.longShot ? ' 🎯' : ''}</span></span>`).join('') : '<span class="vote none">no bets</span>'}</span>
      </div>`).join('')}</div>
      <div class="after-reveal" id="after-reveal">
        <div class="verdict">
          <p class="whopper-line"><b>${esc(sl.authorName)}</b>'s whopper: <q>${esc(r.lieText)}</q></p>
          <p><span class="kicker">FOOLED</span> ${fooled.length ? `${esc(list(fooled.map(x => x.name + (x.double ? ' (−50, doubled)' : ''))))} <b class="plus">+${r.authorDelta} ${esc(sl.authorName)}</b>` : `Nobody. ${esc(sl.authorName)} scores 0.`}</p>
          <p><span class="kicker">SPOTTED IT</span> ${spotted.length ? spotted.map(x => `${esc(x.name)} <b class="plus">+${x.delta}${x.double ? ' (Double!)' : ''}${x.longShot ? ' 🎯 long shot' : ''}</b>${x.streak >= 2 ? ` <span class="streak-tag">🔥${x.streak}</span>` : ''}`).join(', ') : 'Nobody!'}</p>
          ${sl.nudge ? `<p><span class="kicker">SPOTLIGHT</span> ${LABELS.indexOf(sl.nudge) === r.liePos ? `Swung onto ${sl.nudge}, the whopper itself. A double bluff!` : `Swung onto ${sl.nudge}: a bluff!${r.nudgeFooled ? ` ${r.nudgeFooled} followed it.` : ' Nobody fell for it.'}`}</p>` : ''}
          ${noBet.length ? `<p class="muted">No bet locked in: ${esc(list(noBet.map(x => x.name)))}</p>` : ''}
        </div>
        ${myDelta != null ? `<div class="my-result ${myDelta > 0 ? 'up' : myDelta < 0 ? 'down' : ''}"><span class="kicker">${author ? 'YOUR TALES' : mine?.choice ? (mine.correct ? (mine.longShot ? 'LONG SHOT!' : 'YOU SPOTTED IT') : 'FOOLED YOU') : 'NO BET'}</span><b id="my-delta">0</b><small>points${mine?.streak >= 2 ? ` · 🔥 ${mine.streak} in a row` : ''}</small></div>` : ''}
        ${standings(r)}
      </div>
      ${reactBar()}
      <div id="barker"></div>
      <p class="next-line">${sl.number < sl.total ? 'Next tale in' : 'Final curtain in'} <b id="next-in"></b></p>
    </div>`;
    tickFns.push(left => { const n = $('#next-in'); if (n) n.textContent = `${left}s`; });
    startClock(() => 10 * (state.mode === 'classroom' ? 1.25 : 1));
    const stubs = [...game.querySelectorAll('.stubs.revealed .stub')], lie = stubs[r.liePos], truths = stubs.filter(n => n !== lie);
    const fast = FX.reduce, at = ms => fast ? 0 : ms;
    // Beat 1: every bet drops onto its ticket.
    game.querySelectorAll('.vote').forEach((v, i) => { v.style.animationDelay = `${fast ? 0 : 200 + i * 110}ms`; });
    later(at(250), () => sound.play('tap'));
    // Beat 2: the truths flip one by one.
    truths.forEach((n, i) => later(at(1300 + i * 650), () => { n.classList.remove('pending'); n.classList.add('truth', 'flipped'); sound.play('lock'); }));
    // Beat 3: drum roll, then the stamp.
    later(at(2400), () => { sound.play('drum'); lie.classList.add('suspense'); });
    later(at(3150), () => {
      lie.classList.remove('pending', 'suspense'); lie.classList.add('lie', 'stamped'); sound.play('stamp'); buzz([20, 40, 60]);
      $('#reveal-head').textContent = headline;
      game.querySelector('.after-reveal').classList.add('in');
      if (myDelta > 0) { FX.burst(lie, { count: 30 }); sound.play('win'); } else if (myDelta < 0 || (mine?.choice && !mine.correct)) { sound.play('fail'); FX.shake($('.my-result')); }
      FX.countUp($('#my-delta'), myDelta ?? 0, { prefix: myDelta > 0 ? '+' : '' });
      for (const x of r.results.filter(x => x.delta)) { const v = game.querySelector(`.vote[data-id="${x.id}"]`); if (v) FX.float(v, `${x.delta > 0 ? '+' : ''}${x.delta}`, x.delta < 0 ? 'fx-bad' : ''); }
      if (r.authorDelta) FX.float($('#reveal-head'), `+${r.authorDelta} ${sl.authorName}`);
      hudHold = false; paintHud(true);
      if (mine?.streak >= 2) FX.toast(`<div class="fx-medal">🔥</div><div class="fx-badge-text"><small>HOT STREAK</small><b>${mine.streak} in a row!</b><span>Spot the next one to keep it burning.</span></div>`, 'fx-badge', 3000);
      else if (mine?.prevStreak >= 2 && !mine.streak) FX.toast(`<div class="fx-medal">💨</div><div class="fx-badge-text"><small>STREAK BROKEN</small><b>${mine.prevStreak} in a row</b><span>That's a fine run. Start a new one.</span></div>`, 'fx-badge', 2600);
      announce(`The whopper was ticket ${LABELS[r.liePos]}: ${r.lieText}. ${fooled.length} fooled, ${spotted.length} spotted it.`);
      processReveal();
    });
    // Beat 4: the standings reshuffle.
    later(at(4300), () => { const settle = FX.flip($('#standings')); const list = $('#standings ol'); if (!list) return; [...list.children].sort((a, b) => a.dataset.now - b.dataset.now).forEach(li => list.append(li)); list.classList.add('settled'); settle(); });
  }
  // Standings between tales: drawn in the old order, then reshuffled to the new one with arrows for who moved.
  function standings(r) {
    const table = state.players.filter(p => !p.spectator);
    if (table.length < 2) return '';
    const delta = id => (r.results.find(x => x.id === id)?.delta || 0) + (id === state.spotlight.authorId ? r.authorDelta : 0);
    const rank = (list, score) => Object.fromEntries([...list].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name)).map((p, i) => [p.id, i]));
    const before = rank(table, p => p.score - delta(p.id)), after = rank(table, p => p.score);
    const shown = [...table].sort((a, b) => after[a.id] - after[b.id]).filter((p, i) => i < 5 || p.id === selfId);
    return `<div class="standings" id="standings"><span class="kicker">STANDINGS</span><ol>${[...shown].sort((a, b) => before[a.id] - before[b.id]).map(p => {
      const move = before[p.id] - after[p.id], d = delta(p.id);
      return `<li class="${p.id === selfId ? 'self' : ''}" data-flip="${p.id}" data-now="${after[p.id]}"><span class="place">${after[p.id] + 1}</span>${avatar(p.id, 'sm')}<span class="s-name">${esc(p.name)}</span>${p.streak >= 2 ? `<span class="streak-tag">🔥${p.streak}</span>` : ''}<span class="move ${move > 0 ? 'up' : move < 0 ? 'down' : ''}">${move > 0 ? `▲${move}` : move < 0 ? `▼${-move}` : '–'}</span><span class="s-delta">${d ? `${d > 0 ? '+' : ''}${d}` : ''}</span><b class="s-score">${p.score}</b></li>`;
    }).join('')}</ol></div>`;
  }

  // ---------- Final: podium, then the rest of the bill, then the ribbons one at a time ----------
  function buildFinal() {
    const f = state.final, board = f.leaderboard;
    tickFns = []; tickFn = null; hudHold = false;
    const podium = [board[1], board[0], board[2]].map((p, i) => p ? { p, place: [2, 1, 3][i] } : null).filter(Boolean);
    game.innerHTML = `<div id="tent-head">${tentHead()}</div>
    <div class="final">
      <div class="final-head"><span class="kicker">FINAL CURTAIN · ${f.tales} ${f.tales === 1 ? 'TALE' : 'TALES'} TOLD</span><h2>The tent has spoken!</h2></div>
      ${f.reason ? `<p class="notice">${esc(f.reason)}</p>` : ''}
      ${board.length ? `<div class="podium" aria-label="Top three">${podium.map(({ p, place }) => `<div class="step p${place} ${p.id === selfId ? 'self' : ''}" style="--d:${{ 3: 0, 2: 1, 1: 2 }[place]}"><div class="step-who">${place === 1 ? '<span class="crown" aria-hidden="true">👑</span>' : ''}${avatar(p.id, 'lg')}<b>${esc(p.name)}</b><span class="step-score" data-score="${p.score}">0</span></div><div class="step-block"><span>${place}</span></div></div>`).join('')}</div>` : ''}
      ${board.length > 3 ? `<ol class="board" start="4">${board.slice(3).map((p, i) => `<li class="${p.id === selfId ? 'self' : ''}"><span class="place">${i + 4}</span><span class="b-name">${avatar(p.id, 'sm')}${esc(p.name)}${p.isBot ? ' <small class="tag bot">BOT</small>' : ''}</span><b class="b-score">${p.score}</b></li>`).join('')}</ol>` : ''}
      <div class="stat-strip">${board.map(p => `<span class="${p.id === selfId ? 'self' : ''}">${avatar(p.id, 'xs')}${esc(p.name)} · 🔍${p.correct} 🎭${p.fooled} 🪙${p.doubleWins} 🎯${p.longShots}</span>`).join('')}</div>
      <div class="awards">${f.awards.map((a, i) => `<article class="ribbon ${a.winners.some(n => n === me()?.name) ? 'mine' : ''}" style="--d:${i}"><span class="rosette" aria-hidden="true"></span><h3>${a.title}</h3><p>${a.winners.length ? `<b>${esc(list(a.winners))}</b>` : '<b>Nobody this time</b>'}</p><small>${a.blurb}${a.value ? ` · ${a.value}` : ''}</small></article>`).join('')}</div>
      ${f.whopper ? `<div class="best-whopper"><span class="kicker">WHOPPER OF THE NIGHT</span><q>${esc(f.whopper.lie)}</q><p>${esc(f.whopper.name)} fooled ${f.whopper.fooled} of ${f.whopper.of}</p></div>` : ''}
      ${board.some(p => p.id === selfId) ? `<div class="share-box"><span class="kicker">YOUR TICKET STUB</span><pre id="share-text">${esc(shareText())}</pre><button class="button ghost small" data-action="share">Share result</button></div>` : ''}
      ${reactBar()}
      <div id="barker"></div>
      <div class="final-foot" id="final-foot"></div>
    </div>`;
    const fast = FX.reduce;
    game.querySelectorAll('.step').forEach(step => later(fast ? 0 : 400 + Number(step.style.getPropertyValue('--d')) * 650, () => {
      step.classList.add('up'); FX.countUp(step.querySelector('.step-score'), Number(step.querySelector('.step-score').dataset.score));
      sound.play(step.classList.contains('p1') ? 'win' : 'stamp');
      if (step.classList.contains('p1')) { FX.burst(step, { count: 40 }); buzz([30, 30, 80]); }
    }));
    paintFinalFoot(); paintHud(true);
    announce(`Final scores. ${board.slice(0, 3).map(p => `${p.name} ${p.score}`).join(', ')}.`);
    // Ribbons and rank-ups wait until the podium has risen.
    later(fast ? 0 : 3200, processFinal);
  }
  function paintFinalFoot() {
    const foot = $('#final-foot'); if (!foot) return;
    foot.innerHTML = isHost() ? '<button class="button red big" data-action="again">Play again <span aria-hidden="true">↻</span></button><p class="hint">Keeps the tent and the crowd. Everyone writes new tales.</p>' : `<p class="waiting">Waiting for ${esc(hostName())} to play again<span class="dots" aria-hidden="true"></span></p>`;
  }

  // ---------- Actions ----------
  game.addEventListener('click', async event => {
    const target = event.target.closest('[data-action]'); if (!target) return;
    const action = target.dataset.action;
    if (action === 'invite') {
      const link = `${location.origin}/?room=${state.code}`;
      try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); } catch { toast(link); }
    }
    if (action === 'leave') { leaving = true; send('room:leave'); socket?.close(); forget(); showLanding(); }
    if (action === 'start') send('game:start');
    if (action === 'addBot') send('bot:add');
    if (action === 'removeBot') send('bot:remove', { id: target.dataset.id });
    if (action === 'extend') send('host:extend');
    if (action === 'skip') send('host:skip');
    if (action === 'remove') {
      if (confirmRemove > Date.now()) { confirmRemove = 0; send('host:remove'); }
      else { confirmRemove = Date.now() + 4000; paintChrome(); setTimeout(() => { if (confirmRemove && confirmRemove <= Date.now()) { confirmRemove = 0; paintChrome(); } }, 4100); }
    }
    if (action === 'again') send('game:again');
    if (action === 'react') {
      if (target.disabled) return;
      send('react', { e: Number(target.dataset.e) }); buzz(8);
      game.querySelectorAll('.react').forEach(b => { b.disabled = true; }); setTimeout(() => game.querySelectorAll('.react').forEach(b => { b.disabled = false; }), 650);
    }
    if (action === 'nudge') { send('author:nudge', { choice: target.dataset.choice }); buzz(20); }
    if (action === 'share') { const message = await FX.share(shareText(), 'The Tall Tale Tent'); if (message) toast(message); }
    if (action === 'pick' && canBet()) {
      pick.choice = target.dataset.choice; sound.play('tap'); buzz(10);
      send('bet:place', { choice: pick.choice, double: pick.double, lock: false }); updateSpotlight();
    }
    if (action === 'double' && canBet()) {
      if (me().chipsLeft < 1) return;
      pick.double = !pick.double; sound.play('chip');
      if (pick.choice) send('bet:place', { choice: pick.choice, double: pick.double, lock: false });
      updateSpotlight();
    }
    if (action === 'lock' && canBet() && pick.choice) {
      send('bet:place', { choice: pick.choice, double: pick.double, lock: true }); sound.play('lock'); buzz(25);
      FX.float(target, pick.double ? 'DOUBLE DOWN!' : 'LOCKED!');
    }
  });
})();
