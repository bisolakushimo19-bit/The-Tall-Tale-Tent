// End-to-end tests: real WebSocket clients against a time-scaled server. Run with `npm test` (Node 22+).
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const URL = `ws://localhost:${PORT}`;
const SCALE = 0.1;
const LABELS = ['A', 'B', 'C'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(label) { this.label = label; this.log = []; this.state = null; this.priv = null; this.acks = []; this.errors = []; this.waiters = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = reject;
      this.ws.onmessage = e => {
        const msg = JSON.parse(e.data); this.log.push({ raw: e.data, msg });
        if (msg.type === 'room:state') { this.state = msg.state; this.priv = msg; }
        if (msg.type === 'submission:ack') this.acks.push(msg);
        if (msg.type === 'error') this.errors.push(msg);
        this.waiters = this.waiters.filter(w => { if (w.fn(this, msg)) { w.resolve(msg); return false; } return true; });
      };
    });
  }
  send(type, data = {}) { this.ws.send(JSON.stringify({ type, ...data })); }
  until(fn, what = 'condition', ms = 8000) {
    if (fn(this, null)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: timed out waiting for ${what} (phase ${this.state?.phase})`)), ms);
      this.waiters.push({ fn, resolve: v => { clearTimeout(timer); resolve(v); } });
    });
  }
  phase(p, extra = () => true) { return this.until(c => c.state?.phase === p && extra(c), `phase ${p}`); }
  nextMessage(type) { return this.until((c, m) => m?.type === type, type); }
  close() { this.ws.close(); }
  get me() { return this.state.players.find(p => p.id === this.priv.selfId); }
}

async function tent(n, { mode = 'party', names } = {}) {
  const host = await new Client(names?.[0] || 'Host').open();
  host.send('room:create', { name: names?.[0] || 'Host', mode });
  await host.until(c => c.state, 'room');
  const players = [host];
  for (let i = 1; i < n; i++) {
    const c = await new Client(names?.[i] || `P${i}`).open();
    c.send('room:join', { code: host.state.code, name: names?.[i] || `Player${i}` });
    await c.until(x => x.state, 'join');
    players.push(c);
  }
  await host.until(c => c.state.players.length === n, `${n} players`);
  return players;
}
const talesFor = c => [`${c.label} once rode a camel`, `${c.label} can juggle four oranges`, `${c.label} has been to 31 countries`];
async function writeAll(players, lie = 2) {
  for (const c of players) c.send('submission:send', { statements: talesFor(c), lieIndex: lie });
  await Promise.all(players.map(c => c.nextMessage('submission:ack').catch(() => {})));
}
const closeAll = list => list.forEach(c => { try { c.close(); } catch {} });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('static files: only the page and its scripts are served; /healthz is ok', async () => {
  const base = `http://localhost:${PORT}`;
  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
  for (const p of ['/', '/client.js', '/fx.js', '/style.css']) assert.equal((await fetch(base + p)).status, 200, p);
  for (const p of ['/botsets.json', '/blocklist.json', '/server.js', '/package.json', '/../server.js']) assert.equal((await fetch(base + p)).status, 404, p);
});

test('lobby: wrong code, duplicate name, under-4 start, refresh keeps the seat', async () => {
  const [host, a, b] = await tent(3);
  const stray = await new Client('stray').open();
  stray.send('room:join', { code: 'ZZZZ', name: 'Nobody' });
  assert.equal((await stray.nextMessage('error')).code, 'no-room');
  stray.send('room:join', { code: host.state.code, name: 'player1' });
  assert.match((await stray.nextMessage('error')).message, /already has that name/);
  stray.send('room:join', { code: host.state.code, name: 'X' });
  assert.match((await stray.nextMessage('error')).message, /2–14/);
  host.send('game:start');
  assert.match((await host.nextMessage('error')).message, /at least 4/);
  // Refresh: a new socket with the private token lands in the same seat.
  const { token, selfId } = a.priv; a.close();
  const again = await new Client('a2').open();
  again.send('room:join', { code: host.state.code, token });
  await again.until(c => c.state);
  assert.equal(again.priv.selfId, selfId);
  // The token is private: nobody else's payload carries it.
  assert.ok(!host.log.some(l => l.raw.includes(token)));
  closeAll([host, b, stray, again]);
});

test('writing: tales and lie flags never reach other players', async () => {
  const players = await tent(4);
  const [host, b] = players;
  host.send('game:start'); await b.phase('writing');
  const from = b.log.length;
  host.send('submission:send', { statements: talesFor(host), lieIndex: 1 });
  assert.equal((await host.nextMessage('submission:ack')).ok, true);
  await b.until(c => c.state.players.find(p => p.id === host.priv.selfId).submitted, 'readiness update');
  const seen = b.log.slice(from).map(l => l.raw).join('\n');
  for (const t of talesFor(host)) assert.ok(!seen.includes(t), 'leaked tale');
  assert.ok(!seen.includes('lieIndex') || b.log.slice(from).every(l => !l.msg.mine), 'leaked lie index');
  assert.deepEqual(host.priv.mine.statements, talesFor(host));
  closeAll(players);
});

test('filter: profanity, phone numbers, emails and links are rejected; Classroom is stricter', async () => {
  const party = await tent(4);
  party[0].send('game:start'); await party[1].phase('writing');
  const tryTale = async (c, text, mode) => { c.send('submission:send', { statements: [text, 'I like tea', 'I own a kite'], lieIndex: 0 }); return c.nextMessage('submission:ack'); };
  for (const bad of ['This is sh1t', 'I said f u c k once', 'Call me on 07700 900123', 'Text 555-1234 now', 'Mail me at sam@example.com', 'Find me at www.sam.io', 'Follow @sam_rocks']) {
    const ack = await tryTale(party[1], bad);
    assert.equal(ack.ok, false, bad); assert.equal(ack.field, 0); assert.match(ack.message, /The Barker cannot read that out loud/);
  }
  for (const fine of ['I have been to 31 countries', 'I lived in Paris 1990-2001', 'I hate olives', 'Damn good pie']) assert.equal((await tryTale(party[2], fine)).ok, true, fine);
  const room = await tent(4, { mode: 'classroom', names: ['Ms Jones', 'Ava Smith', 'Ben', 'Cy'] });
  assert.deepEqual(room[0].state.players.map(p => p.name).sort(), ['Ava', 'Ben', 'Cy', 'Ms'], 'first names only');
  room[0].send('game:start'); await room[1].phase('writing');
  assert.equal((await tryTale(room[1], 'Damn good pie')).ok, false);
  assert.equal((await tryTale(room[1], 'I hate olives')).ok, true);
  // Classroom timers are 25% longer.
  const left = room[1].state.endsAt - room[1].state.serverNow;
  assert.ok(left > 90000 * SCALE * 1.2, `classroom writing ${left}ms`);
  closeAll([...party, ...room]);
});

test('full game: shuffled stubs, no lie before reveal, Go Double accounting, awards, Play again', async () => {
  const players = await tent(4);
  const [host] = players;
  const byId = Object.fromEntries(players.map(c => [c.priv.selfId, c]));
  host.send('game:start'); await host.phase('writing');
  await writeAll(players, 2);
  const expected = Object.fromEntries(players.map(c => [c.priv.selfId, 0]));
  const chips = Object.fromEntries(players.map(c => [c.priv.selfId, 1]));
  const positions = new Set();
  let spentRefused = 0;
  let checkedFrom = Object.fromEntries(players.map(c => [c.label, c.log.length]));
  for (let n = 0; n < 4; n++) {
    await host.phase('bet', c => c.state.spotlightIndex === n);
    const sl = host.state.spotlight, author = byId[sl.authorId];
    const lieLabel = sl.stubs.find(s => s.text === talesFor(author)[2]).label;
    positions.add(lieLabel);
    const guessers = players.filter(c => c !== author);
    // Nobody but the author learns where the lie landed before REVEAL.
    for (const g of guessers) {
      for (const l of g.log.slice(checkedFrom[g.label])) {
        if (l.msg.type !== 'room:state' || !['read', 'bet', 'call'].includes(l.msg.state.phase)) continue;
        assert.equal(l.msg.authorLie, null); assert.ok(!('liePos' in (l.msg.state.spotlight || {})));
        assert.equal(l.msg.state.spotlight?.reveal ?? null, null); assert.ok(!l.raw.includes('lieIndex'));
      }
    }
    assert.equal(author.priv.authorLie, LABELS.indexOf(lieLabel));
    const wrong = LABELS.find(l => l !== lieLabel);
    // Rotate roles: one right (doubled if they can), one wrong (doubled if they can), one picks but never locks.
    const plan = [{ c: guessers[0], choice: lieLabel }, { c: guessers[1], choice: wrong }, { c: guessers[2], choice: lieLabel, unlocked: true }];
    // A spent chip cannot be spent again.
    for (const g of guessers.filter(g => chips[g.priv.selfId] === 0)) {
      g.send('bet:place', { choice: lieLabel, double: true, lock: true });
      assert.match((await g.nextMessage('error')).message, /no Go Double chips/); spentRefused++;
    }
    let fooled = 0;
    for (const { c, choice, unlocked } of plan) {
      const id = c.priv.selfId, double = !unlocked && chips[id] > 0 && (n % 2 === 0 || choice !== lieLabel);
      c.send('bet:place', { choice, double, lock: false });
      if (!unlocked) c.send('bet:place', { choice, double, lock: true });
      if (unlocked) continue;
      if (double) chips[id]--;
      const right = choice === lieLabel;
      expected[id] += right ? (double ? 200 : 100) : (double ? -50 : 0);
      if (!right) fooled++;
    }
    expected[sl.authorId] += 50 * fooled;
    await host.until(c => c.state.spotlight?.lockedIds.length === 2, 'two locked bets');
    // Bet counts are public, choices are not.
    assert.ok(!JSON.stringify(host.state.spotlight).includes('"choice"'));
    await host.phase('reveal', c => c.state.spotlightIndex === n);
    for (const g of guessers) for (const l of g.log) {
      if (l.msg.type !== 'room:state' || l.msg.state.phase !== 'call' || l.msg.state.spotlightIndex !== n) continue;
      assert.equal(l.msg.authorLie, null); assert.equal(l.msg.state.spotlight.reveal, null); assert.ok(!l.raw.includes('lieIndex') && !l.raw.includes('liePos'));
    }
    const r = host.state.spotlight.reveal;
    assert.equal(LABELS[r.liePos], lieLabel); assert.equal(r.fooled, fooled); assert.equal(r.authorDelta, 50 * fooled);
    assert.equal(r.results.find(x => x.id === plan[2].c.priv.selfId).choice, null, 'unlocked bet counts as no bet');
    for (const c of players) assert.equal(host.state.players.find(p => p.id === c.priv.selfId).score, expected[c.priv.selfId], `score after spotlight ${n}`);
    for (const c of players) assert.equal(host.state.players.find(p => p.id === c.priv.selfId).chipsLeft, chips[c.priv.selfId], 'chips');
    checkedFrom = Object.fromEntries(players.map(c => [c.label, c.log.length]));
  }
  await host.phase('final');
  const f = host.state.final;
  assert.equal(f.leaderboard.length, 4);
  for (const row of f.leaderboard) assert.equal(row.score, expected[row.id]);
  const sharp = Math.max(...f.leaderboard.map(p => p.correct));
  assert.deepEqual(f.awards.find(a => a.title === 'Sharp Eye').winners.sort(), f.leaderboard.filter(p => p.correct === sharp).map(p => p.name).sort());
  assert.ok(f.awards.find(a => a.title === 'Best Poker Face').value >= 1);
  assert.ok(spentRefused > 0, 'a spent chip was tried again');
  // Play again: same tent, scores and chips reset, nothing from game one survives.
  host.send('game:again'); await players[1].phase('lobby');
  assert.ok(players[1].state.players.every(p => p.score === 0));
  const from = players[1].log.length;
  host.send('game:start'); await players[1].phase('writing');
  assert.equal(players[1].priv.mine, null);
  assert.equal(players[1].state.players[0].chipsLeft, 1);
  const after = players[1].log.slice(from).map(l => l.raw).join('\n');
  for (const c of players) for (const t of talesFor(c)) assert.ok(!after.includes(t), 'old tale survived Play again');
  assert.ok(players[1].state.players.every(p => !p.submitted));
  console.log(`    lie positions seen: ${[...positions].join(', ')}`);
  closeAll(players);
});

test('twists: work the spotlight once, tote board only at Last Call, long-shot bonus, switching at Last Call', async () => {
  const players = await tent(4);
  const [host] = players;
  host.send('game:start'); await host.phase('writing');
  await writeAll(players);
  await host.phase('read', c => c.state.spotlightIndex === 0);
  const sl0 = host.state.spotlight, author = players.find(c => c.priv.selfId === sl0.authorId);
  author.send('author:nudge', { choice: 'A' });
  assert.match((await author.nextMessage('error')).message, /during your own tales/, 'no swing while reading');
  await host.phase('bet');
  const sl = host.state.spotlight, lie = sl.stubs.find(s => s.text === talesFor(author)[2]).label, [wrongA] = LABELS.filter(l => l !== lie);
  assert.equal(sl.tote, null, 'tote hidden while betting');
  const [g1, g2, g3] = players.filter(c => c !== author);
  g1.send('author:nudge', { choice: 'A' });
  assert.match((await g1.nextMessage('error')).message, /during your own tales/);
  author.send('author:nudge', { choice: wrongA });
  await g1.until(c => c.state.spotlight.nudge === wrongA, 'everyone sees the spotlight');
  author.send('author:nudge', { choice: lie });
  assert.match((await author.nextMessage('error')).message, /already swung/);
  assert.equal(host.state.players.find(p => p.id === author.priv.selfId).nudgesLeft, 0);
  g1.send('bet:place', { choice: lie, double: false, lock: true });
  g2.send('bet:place', { choice: wrongA, double: false, lock: true });
  g3.send('bet:place', { choice: wrongA, double: false, lock: true });
  await g2.phase('call');
  assert.deepEqual({ ...g2.state.spotlight.tote }, { A: 0, B: 0, C: 0, [lie]: 1, [wrongA]: 2, total: 3 });
  g2.send('bet:place', { choice: lie, double: false, lock: true }); // switches at Last Call
  await host.until(c => c.state.phase === 'reveal', 'reveal');
  const r = host.state.spotlight.reveal, row = c => r.results.find(x => x.id === c.priv.selfId);
  assert.equal(row(g1).delta, 150); assert.equal(row(g1).longShot, true);
  assert.equal(row(g2).delta, 100); assert.equal(row(g2).longShot, false, 'a Last Call switch earns no long-shot bonus');
  assert.equal(row(g3).delta, 0);
  assert.equal(r.fooled, 1); assert.equal(r.authorDelta, 50); assert.equal(r.nudgeFooled, 1);
  closeAll(players);
});

test('gamified layer: distinct avatars, streaks build and break, reactions relay with a rate limit', async () => {
  const players = await tent(4);
  const [host] = players;
  const seats = host.state.players.map(p => p.avatar);
  assert.equal(new Set(seats).size, 4, 'every seat has its own avatar');
  host.send('game:start'); await host.phase('writing');
  await writeAll(players);
  const watcher = players[1];
  let spotter = null;
  for (let n = 0; n < 4; n++) {
    await host.phase('bet', c => c.state.spotlightIndex === n);
    const sl = host.state.spotlight, author = players.find(c => c.priv.selfId === sl.authorId);
    const lie = sl.stubs.find(x => x.text === talesFor(author)[2]).label, wrong = LABELS.find(l => l !== lie);
    // One fixed guesser spots every lie it can; the rest guess wrong.
    spotter ??= players.find(c => c !== author);
    for (const g of players.filter(c => c !== author)) g.send('bet:place', { choice: g === spotter ? lie : wrong, double: false, lock: true });
    await host.phase('reveal', c => c.state.spotlightIndex === n);
    const r = host.state.spotlight.reveal.results;
    for (const x of r) assert.equal(x.streak, x.correct ? x.prevStreak + 1 : 0);
    if (spotter !== author) assert.equal(host.state.players.find(p => p.id === spotter.priv.selfId).streak, r.find(x => x.id === spotter.priv.selfId).streak);
    if (n === 0) {
      const from = watcher.log.length;
      host.send('react', { e: 2 }); host.send('react', { e: 3 }); host.send('react', { e: 99 });
      await watcher.until(c => c.log.slice(from).some(l => l.msg.type === 'react'), 'reaction relayed');
      await sleep(200);
      const got = watcher.log.slice(from).filter(l => l.msg.type === 'react');
      assert.equal(got.length, 1, 'rate limit drops the burst'); assert.equal(got[0].msg.e, 2); assert.equal(got[0].msg.id, host.priv.selfId);
    }
  }
  closeAll(players);
});

test('author disconnects mid-spotlight: cancelled, no points, the game moves on', async () => {
  const players = await tent(4);
  const [host] = players;
  host.send('game:start'); await host.phase('writing');
  await writeAll(players);
  await host.phase('bet', c => c.state.spotlightIndex === 0);
  let author = players.find(c => c.priv.selfId === host.state.spotlight.authorId);
  if (author === host) { // Keep the Barker; restart the check on the next spotlight.
    await host.phase('bet', c => c.state.spotlightIndex === 1);
    author = players.find(c => c.priv.selfId === host.state.spotlight.authorId);
  }
  const watcher = players.find(c => c !== author && c !== host);
  watcher.send('bet:place', { choice: 'A', double: true, lock: true });
  await host.until(c => c.state.spotlight.lockedIds.length === 1);
  const before = host.state.players.map(p => p.score);
  author.close();
  await host.until(c => c.state.phase === 'reveal' && c.state.spotlight.cancelled === 'left', 'cancelled spotlight');
  assert.deepEqual(host.state.players.map(p => p.score), before, 'no points');
  assert.equal(host.state.players.find(p => p.id === watcher.priv.selfId).chipsLeft, 1, 'chip not spent');
  const idx = host.state.spotlightIndex;
  await host.until(c => c.state.spotlightIndex > idx || c.state.phase === 'final', 'next spotlight');
  closeAll(players);
});

test('guesser disconnects during bet: counts as no bet, scores stay right', async () => {
  const players = await tent(4);
  const [host] = players;
  host.send('game:start'); await host.phase('writing');
  await writeAll(players);
  await host.phase('bet', c => c.state.spotlightIndex === 0);
  const sl = host.state.spotlight, author = players.find(c => c.priv.selfId === sl.authorId);
  const lie = sl.stubs.find(s => s.text === talesFor(author)[2]).label, wrong = LABELS.find(l => l !== lie);
  const [g1, g2, g3] = players.filter(c => c !== author && c !== host).concat(author === host ? [] : [host]);
  g1.send('bet:place', { choice: wrong, double: false, lock: true });
  g2.send('bet:place', { choice: lie, double: false, lock: true });
  await host.until(c => c.state.spotlight.lockedIds.length === 2);
  const gone = g1.priv.selfId; g1.close();
  await host.phase('reveal');
  const r = host.state.spotlight.reveal;
  assert.ok(!r.results.some(x => x.id === gone), 'gone guesser is not scored');
  assert.equal(r.fooled, 0); assert.equal(r.authorDelta, 0);
  assert.equal(r.results.find(x => x.id === g2.priv.selfId).delta, 100);
  closeAll(players);
});

test('missed deadline: non-writers sit out; one tale ends the game early', async () => {
  const players = await tent(4);
  const [host, a, b, c] = players;
  host.send('game:start'); await host.phase('writing');
  await writeAll([host, a, b]);
  host.send('host:skip'); // Barker closes the booth early.
  await host.phase('read');
  assert.deepEqual(host.state.sitOut, [c.state.players.find(p => p.id === c.priv.selfId).name]);
  assert.equal(host.state.lineup.length, 3);
  assert.ok(!host.state.lineup.some(x => x.id === c.priv.selfId));
  closeAll(players);
  const solo = await tent(4);
  solo[0].send('game:start'); await solo[0].phase('writing');
  await writeAll([solo[1]]);
  solo[0].send('host:skip');
  await solo[0].phase('final');
  assert.match(solo[0].state.final.reason, /Only one tale/);
  closeAll(solo);
});

test('Barker tools: extend adds 15s, remove hides the tales and skips the spotlight, only the Barker may use them', async () => {
  const players = await tent(4);
  const [host, a] = players;
  host.send('game:start'); await host.phase('writing');
  const before = host.state.endsAt;
  host.send('host:extend'); await host.until(c => c.state.endsAt > before);
  assert.ok(Math.abs(host.state.endsAt - before - 15000 * SCALE) < 100);
  a.send('host:extend'); assert.match((await a.nextMessage('error')).message, /Only the Barker/);
  await writeAll(players);
  await host.phase('read');
  const n = host.state.spotlightIndex;
  host.send('host:remove');
  await host.until(c => c.state.spotlight?.cancelled === 'removed');
  assert.equal(host.state.spotlight.stubs, null);
  assert.ok(host.state.players.every(p => p.score === 0));
  await host.until(c => c.state.spotlightIndex > n || c.state.phase === 'final');
  assert.equal(host.state.lineup[n].status, 'skipped');
  closeAll(players);
});

test('late joiner watches but cannot bet; Barker passes on when the host leaves', async () => {
  const players = await tent(4);
  const [host, a] = players;
  host.send('game:start'); await host.phase('writing');
  const late = await new Client('late').open();
  late.send('room:join', { code: host.state.code, name: 'Latecomer' });
  await late.until(c => c.state);
  assert.equal(late.me.spectator, true);
  late.send('submission:send', { statements: ['a1', 'b2', 'c3'], lieIndex: 0 });
  assert.equal((await late.nextMessage('submission:ack')).ok, false);
  await writeAll(players);
  await late.phase('bet');
  late.send('bet:place', { choice: 'A', double: false, lock: true });
  assert.match((await late.nextMessage('error')).message, /Spectators/);
  host.send('room:leave');
  await a.until(c => c.state.hostId !== host.priv.selfId, 'new Barker');
  assert.equal(a.state.hostId, a.priv.selfId, 'longest-connected human becomes the Barker');
  closeAll([...players, late]);
});

test('10 players write together; games of 10+ deal two chips; capacity is 15', async () => {
  const players = await tent(10);
  players[0].send('game:start'); await players[0].phase('writing');
  assert.equal(players[0].state.chipsPerPlayer, 2);
  assert.ok(players[0].state.players.every(p => p.chipsLeft === 2));
  for (const c of players) c.send('submission:send', { statements: talesFor(c), lieIndex: 0 });
  await players[0].until(c => c.state.players.filter(p => p.submitted).length === 10, 'all ten ready');
  await players[0].phase('read');
  closeAll(players);
  const full = await tent(15);
  const extra = await new Client('16th').open();
  extra.send('room:join', { code: full[0].state.code, name: 'Sixteenth' });
  assert.match((await extra.nextMessage('error')).message, /full/);
  closeAll([...full, extra]);
});

test('practice: one human and three bots finish a whole game', async () => {
  const me = await new Client('solo').open();
  me.send('room:practice', { name: 'Solo' });
  await me.until(c => c.state);
  assert.equal(me.state.players.filter(p => p.isBot).length, 3);
  me.send('game:start'); await me.phase('writing');
  assert.ok(me.state.players.filter(p => p.isBot).every(p => p.submitted), 'bots hand in at once');
  me.send('submission:send', { statements: talesFor(me), lieIndex: 0 });
  let spotlights = 0;
  while (true) {
    await me.until(c => c.state.phase === 'bet' || c.state.phase === 'final', 'bet or final', 15000);
    if (me.state.phase === 'final') break;
    spotlights++;
    if (me.state.spotlight.authorId !== me.priv.selfId) me.send('bet:place', { choice: 'B', double: false, lock: true });
    else await me.until(c => c.state.spotlight.lockedIds.length === 3, 'bots lock in');
    await me.phase('reveal');
  }
  assert.equal(spotlights, 4);
  assert.equal(me.state.final.leaderboard.length, 4);
  me.close();
});

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, TIME_SCALE: SCALE }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => server.stdout.once('data', r));
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`  ✓ ${t.name}`); }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
  }
  console.log(`\n${passed} / ${tests.length} passed`);
  server.kill();
  process.exit(passed === tests.length ? 0 : 1);
})();
