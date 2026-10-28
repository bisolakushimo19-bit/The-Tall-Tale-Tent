const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3004;
const ROOT = __dirname;
const SCALE = Number(process.env.TIME_SCALE) || 1;
// Practice bots tell tales from a private list (never served to players).
const BOT_SETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'botsets.json'), 'utf8'));
const BOT_NAMES = ['Madame Zola', 'Barnaby Pike', 'Tilly Tumble', 'Professor Pip', 'Dot Dandy', 'Captain Quill'];

// Game rules (PRD section 3). Classroom mode stretches every timer by a quarter.
const WRITE_MS = 90000, READ_MS = 10000, BET_MS = 25000, CALL_MS = 6000, REVEAL_MS = 10000, CANCEL_MS = 4000, EXTEND_MS = 15000;
const ALL_IN_MS = 3000, ALL_WRITTEN_MS = 2000, MAX_EXTENDS = 3;
const MIN_PLAYERS = 4, MAX_PLAYERS = 15, MAX_CHARS = 100, BIG_GAME = 10;
const POINTS = { correct: 100, correctDouble: 200, wrong: 0, wrongDouble: -50, fooled: 50, longShot: 50 };
// Two twists on the PRD: each author may swing the spotlight onto one ticket once per game (an honest hint or a bluff),
// and Last Call opens the tote board. Backing the whopper before Last Call while most bets sat elsewhere pays a long-shot bonus.
const NUDGES_PER_GAME = 1;
const ROOM_IDLE_MS = 30 * 60 * 1000, HOST_GRACE_MS = 15000 * SCALE, AUTHOR_GRACE_MS = 5000 * SCALE;
const LABELS = ['A', 'B', 'C'];
// Every seat gets a carnival avatar; reactions are short-lived emoji relayed to the whole tent.
const AVATARS = 16, REACTIONS = 6, REACT_GAP_MS = 600;

// The Barker's blocklist lives in blocklist.json so it can be edited without touching code.
const lists = JSON.parse(fs.readFileSync(path.join(ROOT, 'blocklist.json'), 'utf8'));
const rot13 = w => w.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97));
const PARTY_WORDS = new Set([...lists.rot13.split(/\s+/).filter(Boolean).map(rot13), ...lists.party.map(w => w.toLowerCase())]);
const CLASS_WORDS = new Set([...PARTY_WORDS, ...lists.classroom.map(w => w.toLowerCase())]);
const ENDINGS = ['s', 'es', 'ed', 'ing', 'in', 'er', 'ers', 'y'];
const LEET = { '0':'o', '1':'i', '3':'e', '4':'a', '5':'s', '7':'t', '@':'a', '$':'s', '!':'i' };

const rooms = new Map();
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/fx.js': 'fx.js', '/style.css': 'style.css' };
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type':'text/plain' }); return res.end('ok'); }
  const file = PUBLIC_FILES[pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control':'no-store' });
  fs.createReadStream(path.join(ROOT, file)).pipe(res);
});
const sockets = new Set();

// Minimal RFC 6455 text socket support keeps this tiny game dependency-free.
function frame(opcode, payload=Buffer.alloc(0)) {
  payload=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
  let head;
  if(payload.length<126){head=Buffer.from([0x80|opcode,payload.length]);}
  else if(payload.length<65536){head=Buffer.alloc(4);head[0]=0x80|opcode;head[1]=126;head.writeUInt16BE(payload.length,2);}
  else {head=Buffer.alloc(10);head[0]=0x80|opcode;head[1]=127;head.writeBigUInt64BE(BigInt(payload.length),2);}
  return Buffer.concat([head,payload]);
}
class Peer {
  constructor(socket, initial=Buffer.alloc(0)) { this.socket=socket;this.buffer=initial;this.readyState=1;this.handlers={};this.recent=[];socket.on('data',b=>this.consume(b));socket.on('close',()=>this.closed());socket.on('error',()=>this.closed());if(initial.length)this.consume(initial); }
  on(name,fn){(this.handlers[name]??=[]).push(fn);return this;}
  emit(name,value){for(const fn of this.handlers[name]||[])fn(value);}
  send(data){if(this.readyState===1)this.socket.write(frame(1,data));}
  close(){if(this.readyState!==1)return;this.readyState=2;this.socket.end(frame(8));this.closed();}
  closed(){if(this.readyState===3)return;this.readyState=3;sockets.delete(this);this.emit('close');}
  consume(chunk){this.buffer=Buffer.concat([this.buffer,chunk]);while(this.buffer.length>=2){const b0=this.buffer[0],b1=this.buffer[1],opcode=b0&15,masked=!!(b1&128);let len=b1&127,offset=2;
      if(len===126){if(this.buffer.length<4)return;len=this.buffer.readUInt16BE(2);offset=4;}else if(len===127){if(this.buffer.length<10)return;const n=this.buffer.readBigUInt64BE(2);if(n>4096n)return this.close();len=Number(n);offset=10;}
      if(len>4096)return this.close();const maskBytes=masked?4:0;if(this.buffer.length<offset+maskBytes+len)return;let data=this.buffer.subarray(offset+maskBytes,offset+maskBytes+len);if(masked){data=Buffer.from(data);for(let i=0;i<data.length;i++)data[i]^=this.buffer[offset+(i%4)];}this.buffer=this.buffer.subarray(offset+maskBytes+len);
      if(opcode===8){this.socket.end(frame(8,data));this.closed();return;}if(opcode===9){this.socket.write(frame(10,data));continue;}if(opcode===1)this.emit('message',data);
    }}
}
server.on('upgrade',(req,socket)=>{const key=req.headers['sec-websocket-key'];if(!key||req.headers.upgrade?.toLowerCase()!=='websocket'){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const peer=new Peer(socket);sockets.add(peer);
  peer.on('message',buf=>{const now=Date.now();peer.recent=peer.recent.filter(t=>now-t<1000);if(peer.recent.length>=20)return;peer.recent.push(now);
    try{handle(peer,JSON.parse(buf.toString()));}catch(e){send(peer,'error',{message:'The Barker dropped that ticket. Try again.'});}});
  peer.on('close',()=>onDisconnect(peer));});

const id = () => crypto.randomBytes(12).toString('hex');
const code = () => { let s; do { s=''; for(let i=0;i<4;i++) s += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]; } while(rooms.has(s)); return s; };
const shuffle = list => { const a=[...list]; for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];} return a; };
const send = (ws, type, data={}) => { if(ws?.readyState===1) ws.send(JSON.stringify({type,...data})); };
const ms = (room, base) => Math.round(base * SCALE * (room.mode==='classroom' ? 1.25 : 1));
const connected = room => [...room.players.values()].filter(p=>p.connected);
const humans = room => connected(room).filter(p=>!p.isBot);
const inPlay = room => [...room.players.values()].filter(p=>!p.spectator);
const spotlit = room => ['read','bet','call','reveal'].includes(room.phase);
const betting = room => room.phase==='bet'||room.phase==='call';
// Everyone at the table except the author may bet, if they were dealt in and are still here.
const guessers = room => connected(room).filter(p=>!p.spectator&&p.id!==room.spotlight?.authorId);

// ---------- What each phase sends. The lie position and unshuffled order stay here until REVEAL. ----------
function publicRoom(room) {
  const sl=room.spotlight, author=sl&&room.players.get(sl.authorId), sub=sl&&room.submissions.get(sl.authorId);
  return { code:room.code, mode:room.mode, phase:room.phase, hostId:room.hostId, serverNow:Date.now(), endsAt:room.endsAt, practice:!!room.practice,
    minPlayers:MIN_PLAYERS, maxPlayers:MAX_PLAYERS, maxChars:MAX_CHARS, chipsPerPlayer:room.chipsPerPlayer, extendsLeft:MAX_EXTENDS-(room.extends||0),
    players:[...room.players.values()].filter(p=>p.connected||room.phase!=='lobby').map(p=>({ id:p.id, name:p.name, isBot:!!p.isBot, connected:p.connected,
      spectator:!!p.spectator, score:p.score, chipsLeft:p.chipsLeft, nudgesLeft:p.nudgesLeft??0, avatar:p.avatar??0, streak:p.streak||0, submitted:room.submissions.has(p.id) })),
    lineup:room.order.map((pid,i)=>({ id:pid, name:room.players.get(pid)?.name||'A guest', status:room.lineup[i] })), spotlightIndex:room.spotlightIndex,
    sitOut:room.sitOut,
    spotlight: sl ? {
      authorId:sl.authorId, authorName:author?.name||'A guest', number:room.spotlightIndex+1, total:room.order.length,
      removed:!!sub?.removed, cancelled:sl.cancelled,
      stubs: sub?.removed ? null : sl.perm.map((i,pos)=>({ label:LABELS[pos], text:sub.statements[i] })),
      lockedIds:[...sl.bets].filter(([,b])=>b.locked).map(([pid])=>pid), eligible:guessers(room).length,
      nudge:sl.nudge==null?null:LABELS[sl.nudge], tote:sl.tote,
      reveal: room.phase==='reveal'&&sl.results ? { liePos:sl.liePos, lieText:sub?.removed?null:sub.statements[sub.lieIndex], ...sl.results } : null,
    } : null,
    final:room.final };
}
// Private extras: each player's rejoin token, their own tales, their own bet, and (only as the author) where their lie landed.
function privateFor(room, p) {
  const sl=room.spotlight, sub=room.submissions.get(p.id), bet=sl?.bets.get(p.id);
  return { selfId:p.id, token:p.token,
    mine: room.phase==='writing'&&sub ? { statements:sub.statements, lieIndex:sub.lieIndex } : null,
    myBet: bet ? { choice:bet.choice, double:bet.double, locked:bet.locked } : null,
    authorLie: sl&&sl.authorId===p.id&&spotlit(room) ? sl.liePos : null };
}
function broadcast(room) { const state=publicRoom(room); for(const p of room.players.values()) if(p.connected&&!p.isBot) send(p.ws,'room:state',{state,...privateFor(room,p)}); }
function roomFor(ws) { return ws.player && rooms.get(ws.player.room); }

// ---------- Content filter ----------
function filterTale(text, mode) {
  if(/[a-z0-9._%+-]+\s*(@|\(at\)|\[at\])\s*[a-z0-9-]+\s*(\.|\(dot\)|\[dot\])\s*[a-z]{2,}/i.test(text)) return 'contact';
  if(/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|uk|me|app|ly|gg|tv)\b/i.test(text)||/(^|\s)@[a-z0-9_.]{3,}/i.test(text)) return 'contact';
  // A phone number: ten or more digits in one run, or a seven-digit local number like 555-1234.
  if((text.match(/\+?\d[\d\s().-]{8,}\d/g)||[]).some(run=>run.replace(/\D/g,'').length>=10)||/\b\d{3}[\s.-]\d{4}\b/.test(text)) return 'contact';
  const words=text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[013457@$!]/g,c=>LEET[c]).split(/[^a-z]+/).filter(Boolean);
  const set=mode==='classroom'?CLASS_WORDS:PARTY_WORDS;
  const blocked=w=>set.has(w)||ENDINGS.some(end=>w.endsWith(end)&&set.has(w.slice(0,-end.length)));
  if(words.some(blocked)) return 'word';
  // Spaced-out letters ("f u c k") are joined and checked once more.
  const spaced=(text.toLowerCase().match(/\b(?:[a-z][\s.*_-]+){2,}[a-z]\b/g)||[]).map(run=>run.replace(/[^a-z]/g,''));
  if(spaced.some(blocked)) return 'word';
  return null;
}
const FILTER_MESSAGE = { word:'The Barker cannot read that out loud. Try a cleaner tale.', contact:'The Barker cannot read that out loud. Keep phone numbers, emails and links out of the tent.' };

// ---------- Flow ----------
function startGame(room) {
  for(const p of [...room.players.values()]) if(!p.connected) room.players.delete(p.id);
  const table=connected(room);
  room.chipsPerPlayer=table.length>=BIG_GAME?2:1;
  for(const p of table){ p.spectator=false; p.score=0; p.chipsLeft=room.chipsPerPlayer; p.nudgesLeft=NUDGES_PER_GAME; p.streak=0; p.stats={fooled:0,correct:0,doubleWins:0,bets:0,longShots:0,nudgeFooled:0}; }
  room.submissions=new Map(); room.order=[]; room.lineup=[]; room.spotlightIndex=-1; room.sitOut=[]; room.final=null; room.spotlight=null; room.history=[];
  // Each bot draws a different set of tales.
  const sets=shuffle(BOT_SETS);
  table.filter(p=>p.isBot).forEach((bot,i)=>{ const set=sets[i%sets.length]; room.submissions.set(bot.id,{statements:[...set.tales],lieIndex:set.lie,removed:false}); });
  room.phase='writing'; room.extends=0; room.endsAt=Date.now()+ms(room,WRITE_MS);
  broadcast(room);
}
function endWriting(room) {
  const table=inPlay(room);
  room.sitOut=table.filter(p=>!room.submissions.has(p.id)).map(p=>p.name);
  for(const pid of [...room.submissions.keys()]) if(!room.players.get(pid)||room.players.get(pid).spectator) room.submissions.delete(pid);
  if(room.submissions.size<2) return finishGame(room,'Only one tale reached the Barker, so the tent closes early. Write three tales next time!');
  room.order=shuffle([...room.submissions.keys()]); room.lineup=room.order.map(()=>'waiting'); room.spotlightIndex=-1;
  nextSpotlight(room);
}
function nextSpotlight(room) {
  const now=Date.now();
  while(++room.spotlightIndex<room.order.length){
    const author=room.players.get(room.order[room.spotlightIndex]), sub=author&&room.submissions.get(author.id);
    // An author who left before their turn (or whose tales were removed) is skipped without penalty.
    if(!author||!sub||sub.removed||(!author.connected&&now-author.leftAt>AUTHOR_GRACE_MS)){ room.lineup[room.spotlightIndex]='skipped'; continue; }
    const perm=shuffle([0,1,2]);
    room.spotlight={ authorId:author.id, perm, liePos:perm.indexOf(sub.lieIndex), bets:new Map(), cancelled:null, results:null, bots:null, nudge:null, tote:null };
    room.lineup[room.spotlightIndex]='now';
    room.phase='read'; room.extends=0; room.endsAt=now+ms(room,READ_MS);
    broadcast(room); return;
  }
  finishGame(room,null);
}
function beginBet(room) {
  const now=Date.now(), sl=room.spotlight, window=ms(room,BET_MS);
  room.phase='bet'; room.extends=0; room.endsAt=now+window;
  // Bots pick at random, leaning a little toward the real whopper, and lock in at a random moment.
  sl.bots=guessers(room).filter(p=>p.isBot).map(bot=>{
    const right=crypto.randomInt(100)<45, wrong=[0,1,2].filter(i=>i!==sl.liePos);
    return { id:bot.id, choice:right?sl.liePos:wrong[crypto.randomInt(2)], double:bot.chipsLeft>0&&crypto.randomInt(100)<30, at:now+Math.round(window*(0.12+Math.random()*0.4)) };
  });
  // A bot author swings the spotlight half the time, and points it at a truth more often than at the lie.
  const author=room.players.get(sl.authorId);
  if(author?.isBot&&author.nudgesLeft>0&&crypto.randomInt(2)===0) sl.botNudge={ at:now+Math.round(window*0.2), choice:crypto.randomInt(100)<35?sl.liePos:[0,1,2].filter(i=>i!==sl.liePos)[crypto.randomInt(2)] };
  broadcast(room);
}
// Last Call: the tote board shows how the locked bets are split. Bets stay changeable for a few more seconds.
function lastCall(room) {
  const sl=room.spotlight, tote={ A:0, B:0, C:0, total:0 };
  for(const b of sl.bets.values()) if(b.locked){ tote[LABELS[b.choice]]++; tote.total++; }
  sl.tote=tote; sl.early=new Map([...sl.bets].filter(([,b])=>b.locked).map(([pid,b])=>[pid,b.choice]));
  room.phase='call'; room.endsAt=Date.now()+ms(room,CALL_MS);
  broadcast(room);
}
function nudge(room, author, choice) {
  const sl=room.spotlight;
  if(sl.nudge!=null||author.nudgesLeft<1) return false;
  author.nudgesLeft--; sl.nudge=choice; return true;
}
function checkAllIn(room) {
  const sl=room.spotlight, all=guessers(room);
  if(room.phase==='bet'&&all.length&&all.every(p=>sl.bets.get(p.id)?.locked)) room.endsAt=Math.min(room.endsAt,Date.now()+ALL_IN_MS*SCALE);
}
// PRD 6.4: only locked bets count. Correct +100 (+200 doubled); wrong 0 (-50 doubled); the author earns +50 per wrong guess.
function reveal(room) {
  const sl=room.spotlight, author=room.players.get(sl.authorId), results=[];
  for(const p of guessers(room)){
    const bet=sl.bets.get(p.id);
    // A streak counts whoppers spotted in a row; a wrong bet or no bet breaks it. It earns status, not points.
    if(!bet?.locked){ results.push({ id:p.id, name:p.name, choice:null, double:false, correct:false, delta:0, prevStreak:p.streak||0, streak:0 }); p.streak=0; continue; }
    const double=bet.double&&p.chipsLeft>0, correct=bet.choice===sl.liePos;
    // A long shot: on the whopper before Last Call, while it held under half of the tote.
    const longShot=correct&&sl.early?.get(p.id)===sl.liePos&&sl.tote.total>0&&sl.tote[LABELS[sl.liePos]]*2<sl.tote.total;
    const delta=(correct?(double?POINTS.correctDouble:POINTS.correct):(double?POINTS.wrongDouble:POINTS.wrong))+(longShot?POINTS.longShot:0);
    if(double) p.chipsLeft--;
    p.score+=delta; p.stats.bets++; if(correct) p.stats.correct++; if(correct&&double) p.stats.doubleWins++; if(longShot) p.stats.longShots++;
    const prevStreak=p.streak||0; p.streak=correct?prevStreak+1:0;
    results.push({ id:p.id, name:p.name, choice:LABELS[bet.choice], double, correct, longShot, delta, prevStreak, streak:p.streak });
  }
  const fooled=results.filter(r=>r.choice&&!r.correct).length, authorDelta=fooled*POINTS.fooled;
  // A bluffed spotlight that someone followed onto a true ticket counts toward Smoke and Mirrors.
  const nudgeFooled=sl.nudge!=null&&sl.nudge!==sl.liePos ? results.filter(r=>r.choice===LABELS[sl.nudge]).length : 0;
  if(author){ author.score+=authorDelta; author.stats.fooled+=fooled; author.stats.nudgeFooled+=nudgeFooled; }
  sl.results={ results, fooled, authorDelta, nudgeFooled, everyone:fooled>0&&fooled===results.length };
  const sub=room.submissions.get(sl.authorId);
  room.history.push({ authorId:sl.authorId, name:author?.name, lie:sub.statements[sub.lieIndex], fooled, of:results.filter(r=>r.choice).length });
  room.lineup[room.spotlightIndex]='done';
  room.phase='reveal'; room.endsAt=Date.now()+ms(room,REVEAL_MS);
  // Bots in the crowd react to the reveal now and then.
  room.botReacts=connected(room).filter(p=>p.isBot&&crypto.randomInt(100)<45).map(b=>({ id:b.id, e:crypto.randomInt(REACTIONS), at:Date.now()+Math.round((2500+crypto.randomInt(3500))*SCALE) }));
  broadcast(room);
}
function relayReaction(room, player, e) {
  for(const p of room.players.values()) if(p.connected&&!p.isBot) send(p.ws,'react',{ id:player.id, e });
}
// Cancelling a spotlight awards nothing; a reveal that was already scored is rolled back.
function cancelSpotlight(room, reason) {
  const sl=room.spotlight; if(!sl||sl.cancelled) return;
  if(sl.results){
    for(const r of sl.results.results){ const p=room.players.get(r.id); if(p) p.streak=r.prevStreak; if(!p||!r.choice) continue; p.score-=r.delta; p.stats.bets--; if(r.double) p.chipsLeft++; if(r.correct) p.stats.correct--; if(r.correct&&r.double) p.stats.doubleWins--; if(r.longShot) p.stats.longShots--; }
    const author=room.players.get(sl.authorId); if(author){ author.score-=sl.results.authorDelta; author.stats.fooled-=sl.results.fooled; author.stats.nudgeFooled-=sl.results.nudgeFooled; }
    room.history=room.history.filter(h=>h.authorId!==sl.authorId);
  }
  if(sl.nudge!=null){ const a=room.players.get(sl.authorId); if(a) a.nudgesLeft++; }
  sl.cancelled=reason; sl.results=null; room.lineup[room.spotlightIndex]='skipped';
  room.phase='reveal'; room.endsAt=Date.now()+CANCEL_MS*SCALE;
  broadcast(room);
}
function finishGame(room, reason) {
  const table=inPlay(room);
  const award=(stat,title,blurb)=>{ const best=Math.max(0,...table.map(p=>p.stats?.[stat]||0)); return { title, blurb, stat, value:best, winners:best?table.filter(p=>p.stats[stat]===best).map(p=>p.name):[] }; };
  const whopper=[...room.history].sort((a,b)=>b.fooled-a.fooled)[0];
  room.final={ reason,
    leaderboard:[...table].sort((a,b)=>b.score-a.score).map(p=>({ id:p.id, name:p.name, isBot:!!p.isBot, score:p.score, ...p.stats })),
    awards:[ award('fooled','Best Poker Face','most people fooled'), award('correct','Sharp Eye','most whoppers spotted'), award('doubleWins','Boldest Bet','most Go Doubles won'), award('longShots','Long Shot','most long-shot bonuses'), award('nudgeFooled','Smoke and Mirrors','most fooled by a bluffed spotlight') ],
    whopper: whopper&&whopper.fooled ? whopper : null, tales:room.history.length };
  room.phase='final'; room.spotlight=null; room.endsAt=null;
  broadcast(room);
}
function playAgain(room) {
  for(const p of [...room.players.values()]){ if(!p.connected){ room.players.delete(p.id); continue; } p.spectator=false; p.score=0; p.chipsLeft=0; p.streak=0; p.stats={fooled:0,correct:0,doubleWins:0,bets:0,longShots:0,nudgeFooled:0}; }
  room.submissions=new Map(); room.history=[]; room.order=[]; room.lineup=[]; room.spotlightIndex=-1; room.sitOut=[]; room.spotlight=null; room.final=null;
  room.phase='lobby'; room.endsAt=null;
  broadcast(room);
}

// ---------- Players ----------
function cleanName(value, mode) {
  let s=String(value||'').replace(/[<>\u0000-\u001f]/g,'').trim().replace(/\s+/g,' ');
  if(mode==='classroom') s=s.split(' ')[0];
  return s.length>=2&&s.length<=14?s:'';
}
function seat(room, p) {
  const taken=new Set([...room.players.values()].filter(x=>x!==p).map(x=>x.avatar));
  p.avatar=[...Array(AVATARS).keys()].find(i=>!taken.has(i))??crypto.randomInt(AVATARS);
  return p;
}
function newPlayer(name, ws, extra={}) { return { id:id(), token:id(), name, ws, connected:true, connectedSince:Date.now(), leftAt:0, score:0, chipsLeft:0, spectator:false, stats:{fooled:0,correct:0,doubleWins:0,bets:0,longShots:0,nudgeFooled:0}, ...extra }; }
function addBot(room) {
  const used=new Set([...room.players.values()].map(p=>p.name));
  const name=BOT_NAMES.find(n=>!used.has(n)); if(!name||connected(room).length>=MAX_PLAYERS) return;
  const bot=newPlayer(name,null,{ token:null, isBot:true }); room.players.set(bot.id,bot); seat(room,bot);
}
function createRoom(ws, name, mode, practice) {
  const room={ code:code(), mode, practice:!!practice, hostId:null, players:new Map(), phase:'lobby', submissions:new Map(), order:[], lineup:[], spotlightIndex:-1,
    sitOut:[], spotlight:null, history:[], final:null, endsAt:null, chipsPerPlayer:1, extends:0, emptySince:null };
  const host=newPlayer(name,ws); room.players.set(host.id,host); seat(room,host); room.hostId=host.id; rooms.set(room.code,room); ws.player={room:room.code,id:host.id};
  if(practice) for(let i=0;i<3;i++) addBot(room);
  broadcast(room);
}
function passBarker(room) { const next=humans(room).sort((a,b)=>a.connectedSince-b.connectedSince)[0]; if(next) room.hostId=next.id; }

function handle(ws, msg) {
  const room=roomFor(ws), player=room?.players.get(ws.player.id), t=msg.type;
  if(t==='room:create'||t==='room:practice') {
    const mode=t==='room:create'&&msg.mode==='classroom'?'classroom':'party', name=cleanName(msg.name,mode);
    if(!name) return send(ws,'error',{message:mode==='classroom'?'Use a first name of 2–14 letters.':'Name must be 2–14 characters.'});
    return createRoom(ws,name,mode,t==='room:practice');
  }
  if(t==='room:join') {
    const c=String(msg.code||'').toUpperCase(), r=rooms.get(c);
    if(!r) return send(ws,'error',{message:'No tent by that code.',code:'no-room'});
    const returning=msg.token&&[...r.players.values()].find(x=>x.token===msg.token);
    if(returning){ const p=returning; if(p.connected&&p.ws!==ws) send(p.ws,'error',{message:'You opened this tent in another tab.',code:'replaced'});
      if(!p.connected) p.connectedSince=Date.now(); p.ws=ws; p.connected=true; ws.player={room:c,id:p.id}; broadcast(r); return; }
    const name=cleanName(msg.name,r.mode);
    if(!name) return send(ws,'error',{message:r.mode==='classroom'?'Use a first name of 2–14 letters.':'Name must be 2–14 characters.'});
    if(connected(r).length>=MAX_PLAYERS) return send(ws,'error',{message:'This tent is full. Fifteen at most.'});
    if([...r.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase()&&(p.connected||r.phase!=='lobby'))) return send(ws,'error',{message:'Someone in this tent already has that name.'});
    // Late arrivals watch from the back row until the next game.
    const p=newPlayer(name,ws,{ spectator:r.phase!=='lobby'&&r.phase!=='final' }); r.players.set(p.id,p); seat(r,p); ws.player={room:c,id:p.id};
    broadcast(r); return;
  }
  if(!room||!player) return send(ws,'error',{message:'Step into a tent first.'});
  const host=player.id===room.hostId;
  if(t==='room:leave') {
    ws.player=null;
    if(room.phase==='lobby') room.players.delete(player.id); else { player.connected=false; player.leftAt=-Infinity; }
    if(host) passBarker(room);
    afterDeparture(room,player); return;
  }
  if(t==='game:start') {
    if(!host) return send(ws,'error',{message:'Only the Barker can raise the curtain.'});
    if(room.phase!=='lobby') return;
    if(connected(room).length<MIN_PLAYERS) return send(ws,'error',{message:`The tent needs at least ${MIN_PLAYERS} players.`});
    return startGame(room);
  }
  if(t==='submission:send') {
    if(room.phase!=='writing') return send(ws,'submission:ack',{ok:false,message:'The writing booth is closed.'});
    if(player.spectator) return send(ws,'submission:ack',{ok:false,message:'You join in at the next game.'});
    const list=Array.isArray(msg.statements)?msg.statements.slice(0,3).map(s=>String(s??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()):[];
    if(list.length!==3||list.some(s=>!s)) return send(ws,'submission:ack',{ok:false,message:'Fill in all three tales.',field:list.findIndex(s=>!s)});
    const long=list.findIndex(s=>[...s].length>MAX_CHARS); if(long>=0) return send(ws,'submission:ack',{ok:false,message:`Keep each tale to ${MAX_CHARS} characters.`,field:long});
    if(new Set(list.map(s=>s.toLowerCase())).size<3) return send(ws,'submission:ack',{ok:false,message:'Each tale must be different.'});
    const lie=Number(msg.lieIndex); if(![0,1,2].includes(lie)) return send(ws,'submission:ack',{ok:false,message:'Mark exactly one tale as your lie.'});
    for(let i=0;i<3;i++){ const why=filterTale(list[i],room.mode); if(why) return send(ws,'submission:ack',{ok:false,message:FILTER_MESSAGE[why],field:i,filtered:true}); }
    room.submissions.set(player.id,{statements:list,lieIndex:lie,removed:false});
    send(ws,'submission:ack',{ok:true});
    if(inPlay(room).filter(p=>p.connected).every(p=>room.submissions.has(p.id))) room.endsAt=Math.min(room.endsAt,Date.now()+ALL_WRITTEN_MS*SCALE);
    broadcast(room); return;
  }
  if(t==='bet:place') {
    const sl=room.spotlight;
    if(!betting(room)) return send(ws,'error',{message:'Bets are not open right now.'});
    if(player.spectator) return send(ws,'error',{message:'Spectators watch this game and bet in the next one.'});
    if(player.id===sl.authorId) return send(ws,'error',{message:'Keep a straight face. You cannot bet on your own tales.'});
    const choice=LABELS.indexOf(String(msg.choice)); if(choice<0) return send(ws,'error',{message:'Pick A, B or C.'});
    const double=!!msg.double; if(double&&player.chipsLeft<1) return send(ws,'error',{message:'You have no Go Double chips left.'});
    sl.bets.set(player.id,{choice,double,locked:!!msg.lock});
    checkAllIn(room); broadcast(room); return;
  }
  if(t==='react') {
    const e=Number(msg.e), now=Date.now();
    if(!Number.isInteger(e)||e<0||e>=REACTIONS||player.spectator&&room.phase==='lobby') return;
    if(now-(player.reactedAt||0)<REACT_GAP_MS) return;
    player.reactedAt=now; return relayReaction(room,player,e);
  }
  if(t==='author:nudge') {
    const sl=room.spotlight, choice=LABELS.indexOf(String(msg.choice));
    if(!betting(room)||sl.authorId!==player.id) return send(ws,'error',{message:'You can only work the spotlight during your own tales.'});
    if(choice<0) return send(ws,'error',{message:'Pick A, B or C.'});
    if(!nudge(room,player,choice)) return send(ws,'error',{message:'You have already swung the spotlight this game.'});
    return broadcast(room);
  }
  if(t==='bot:add'&&host&&room.phase==='lobby') { addBot(room); return broadcast(room); }
  if(t==='bot:remove'&&host&&room.phase==='lobby') { const b=room.players.get(msg.id); if(b?.isBot){ room.players.delete(b.id); broadcast(room); } return; }
  if(t.startsWith('host:')&&!host) return send(ws,'error',{message:'Only the Barker can do that.'});
  if(t==='host:extend') {
    if(!['writing','read','bet'].includes(room.phase)) return;
    if((room.extends||0)>=MAX_EXTENDS) return send(ws,'error',{message:'The clock has been stretched as far as it goes.'});
    room.extends=(room.extends||0)+1; room.endsAt=Math.max(room.endsAt,Date.now())+EXTEND_MS*SCALE; broadcast(room); return;
  }
  if(t==='host:skip') {
    if(room.phase==='read'||betting(room)) return cancelSpotlight(room,'skipped');
    if(room.phase==='reveal'){ room.endsAt=Date.now(); return; }
    if(room.phase==='writing'){ room.endsAt=Date.now(); return; }
    return;
  }
  if(t==='host:remove') {
    if(!spotlit(room)||room.spotlight.cancelled) return;
    const sub=room.submissions.get(room.spotlight.authorId); if(sub) sub.removed=true;
    return cancelSpotlight(room,'removed');
  }
  if(t==='game:again'&&host&&room.phase==='final') return playAgain(room);
}
function afterDeparture(room, player) {
  if(player.id===room.hostId&&player.leftAt!==-Infinity) room.hostGraceUntil=Date.now()+HOST_GRACE_MS;
  if(room.phase==='writing'&&inPlay(room).filter(p=>p.connected).every(p=>room.submissions.has(p.id))&&room.submissions.size) room.endsAt=Math.min(room.endsAt,Date.now()+ALL_WRITTEN_MS*SCALE);
  checkAllIn(room);
  broadcast(room);
}
function onDisconnect(ws){const room=roomFor(ws);if(!room)return;const player=room.players.get(ws.player.id);if(!player||player.ws!==ws)return;player.connected=false;player.leftAt=Date.now();afterDeparture(room,player);}

// One clock drives every room, so phase changes are ordered by the server alone.
setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    // Statements live only in memory and vanish with the room.
    if(!humans(room).length){room.emptySince??=now;if(now-room.emptySince>ROOM_IDLE_MS){room.submissions.clear();rooms.delete(room.code);}continue;}
    room.emptySince=null;
    if(!room.players.get(room.hostId)?.connected&&now>=(room.hostGraceUntil||0)){passBarker(room);broadcast(room);}
    const sl=room.spotlight;
    // An author who stays gone mid-spotlight cancels it; a quick refresh does not.
    if((room.phase==='read'||betting(room))&&sl&&!sl.cancelled){const a=room.players.get(sl.authorId);if(!a?.connected&&now-(a?.leftAt??0)>AUTHOR_GRACE_MS){cancelSpotlight(room,'left');continue;}}
    if(room.phase==='bet'&&sl.bots){let moved=false;for(const b of sl.bots){if(!b.done&&now>=b.at){b.done=true;const bot=room.players.get(b.id);if(bot){sl.bets.set(b.id,{choice:b.choice,double:b.double&&bot.chipsLeft>0,locked:true});moved=true;}}}if(moved){checkAllIn(room);broadcast(room);}}
    if(room.botReacts?.length){for(const b of room.botReacts.filter(b=>now>=b.at)){const bot=room.players.get(b.id);if(bot)relayReaction(room,bot,b.e);}room.botReacts=room.botReacts.filter(b=>now<b.at);}
    if(room.phase==='bet'&&sl.botNudge&&now>=sl.botNudge.at){const a=room.players.get(sl.authorId);if(a&&nudge(room,a,sl.botNudge.choice))broadcast(room);sl.botNudge=null;}
    if(!room.endsAt||now<room.endsAt)continue;
    if(room.phase==='writing')endWriting(room);
    else if(room.phase==='read')beginBet(room);
    else if(room.phase==='bet')lastCall(room);
    else if(room.phase==='call')reveal(room);
    else if(room.phase==='reveal')nextSpotlight(room);
  }
},SCALE<1?25:200).unref();
server.listen(PORT,()=>console.log(`The Tall Tale Tent is running at http://localhost:${PORT}`));
