require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || ''; // e.g. https://your-service.onrender.com
const AUTO_DRAW_INTERVAL = Number(process.env.AUTO_DRAW_INTERVAL || 5000);

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// ---------------- helpers ----------------
function generateCard() {
  const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
  const cols = ranges.map(([min,max])=>{
    const arr=[];
    while(arr.length<5){
      const n = Math.floor(Math.random()*(max-min+1))+min;
      if(!arr.includes(n)) arr.push(n);
    }
    return arr;
  });
  const flat=[];
  for(let r=0;r<5;r++){
    for(let c=0;c<5;c++){
      flat.push(cols[c][r]);
    }
  }
  flat[12] = 'FREE';
  return flat;
}

function checkBingo(cardFlat, drawnNumbers) {
  const called = new Set(drawnNumbers);
  const grid = [];
  for (let r=0;r<5;r++){
    grid[r]=[];
    for(let c=0;c<5;c++){
      const idx=r*5+c;
      const v=cardFlat[idx];
      grid[r][c] = (v==='FREE') || called.has(v);
    }
  }
  // rows
  for(let r=0;r<5;r++){
    if(grid[r].every(Boolean)) return true;
  }
  // columns
  for(let c=0;c<5;c++){
    let ok=true;
    for(let r=0;r<5;r++) if(!grid[r][c]) ok=false;
    if(ok) return true;
  }
  // diagonals
  if([0,1,2,3,4].every(i=>grid[i][i])) return true;
  if([0,1,2,3,4].every(i=>grid[i][4-i])) return true;
  return false;
}

// ---------------- auto-draw timers ----------------
const activeTimers = {};

function performAutoDraw(gameId){
  const rows = db.prepare('SELECT number FROM draws WHERE game_id = ?').all(gameId);
  const used = rows.map(r=>r.number);
  if(used.length >= 75){
    stopAutoDraw(gameId);
    return;
  }
  const all = Array.from({length:75},(_,i)=>i+1);
  const remaining = all.filter(n=>!used.includes(n));
  const num = remaining[Math.floor(Math.random()*remaining.length)];
  db.prepare('INSERT INTO draws (game_id, number) VALUES (?, ?)').run(gameId, num);
  console.log('Auto-draw', gameId, num);
}

function startAutoDraw(gameId){
  if(activeTimers[gameId]) return false;
  activeTimers[gameId] = setInterval(()=>performAutoDraw(gameId), AUTO_DRAW_INTERVAL);
  db.prepare('UPDATE games SET auto_draw = 1, status = ? WHERE id = ?').run('running', gameId);
  console.log('Started auto-draw', gameId);
  return true;
}
function stopAutoDraw(gameId){
  const t = activeTimers[gameId];
  if(!t) return false;
  clearInterval(t);
  delete activeTimers[gameId];
  db.prepare('UPDATE games SET auto_draw = 0, status = ? WHERE id = ?').run('finished', gameId);
  console.log('Stopped auto-draw', gameId);
  return true;
}

// ---------------- API endpoints ----------------

app.get('/_health', (req,res)=>res.json({ok:true}));

// create game
app.post('/api/game/create', (req,res)=>{
  try{
    const { user_id, bet } = req.body;
    const id = uuidv4();
    db.prepare('INSERT INTO games (id, host_id, bet) VALUES (?, ?, ?)').run(id, user_id||null, bet||10);
    return res.json({ game_id: id });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// join game -> returns card
app.post('/api/game/join', (req,res)=>{
  try{
    const { user_id, username, full_name, game_id } = req.body;
    const g = db.prepare('SELECT id FROM games WHERE id = ?').get(game_id);
    if(!g) return res.status(404).json({ error: 'game not found' });
    const card = generateCard();
    db.prepare('INSERT INTO players (game_id, user_id, username, full_name, card_json) VALUES (?, ?, ?, ?, ?)').run(game_id, user_id, username||null, full_name||null, JSON.stringify(card));
    return res.json({ card });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// list players
app.get('/api/game/players/:gameId', (req,res)=>{
  const gameId = req.params.gameId;
  const rows = db.prepare('SELECT user_id, username, full_name FROM players WHERE game_id = ?').all(gameId);
  res.json({ players: rows });
});

// manual draw (host)
app.post('/api/game/draw', (req,res)=>{
  try{
    const { game_id } = req.body;
    const rows = db.prepare('SELECT number FROM draws WHERE game_id = ?').all(game_id);
    const used = rows.map(r=>r.number);
    if(used.length >= 75) return res.json({ error: 'No more numbers' });
    const all = Array.from({length:75},(_,i)=>i+1);
    const remaining = all.filter(n=>!used.includes(n));
    const num = remaining[Math.floor(Math.random()*remaining.length)];
    db.prepare('INSERT INTO draws (game_id, number) VALUES (?, ?)').run(game_id, num);
    return res.json({ number: num });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// get draw history
app.get('/api/game/draws/:gameId', (req,res)=>{
  const gameId = req.params.gameId;
  const rows = db.prepare('SELECT number FROM draws WHERE game_id = ? ORDER BY id ASC').all(gameId);
  res.json({ drawn: rows.map(r=>r.number) });
});

// start/stop auto
app.post('/api/game/start', (req,res)=>{
  const { game_id } = req.body;
  const ok = startAutoDraw(game_id);
  res.json({ status: ok ? 'started' : 'already_running' });
});
app.post('/api/game/stop', (req,res)=>{
  const { game_id } = req.body;
  const ok = stopAutoDraw(game_id);
  res.json({ status: ok ? 'stopped' : 'not_running' });
});

// check bingo (player claim)
app.post('/api/game/check-bingo', (req,res)=>{
  try{
    const { game_id, user_id, marked } = req.body;
    if(!Array.isArray(marked)) return res.status(400).json({ error: 'marked must be array' });
    const playerRow = db.prepare('SELECT id, card_json FROM players WHERE game_id = ? AND user_id = ?').get(game_id, user_id);
    if(!playerRow) return res.status(404).json({ error: 'player not found' });
    const card = JSON.parse(playerRow.card_json);
    const rows = db.prepare('SELECT number FROM draws WHERE game_id = ?').all(game_id);
    const drawn = rows.map(r=>r.number);
    // validate that marked numbers are on card and drawn
    for(const m of marked){
      if(m !== 'FREE' && !card.includes(m)){
        db.prepare('INSERT INTO claims (game_id, player_id, marked_json, valid) VALUES (?, ?, ?, ?)').run(game_id, playerRow.id, JSON.stringify(marked), 0);
        return res.json({ win: false, reason: 'Marked number not on card' });
      }
      if(m !== 'FREE' && !drawn.includes(m)){
        db.prepare('INSERT INTO claims (game_id, player_id, marked_json, valid) VALUES (?, ?, ?, ?)').run(game_id, playerRow.id, JSON.stringify(marked), 0);
        return res.json({ win: false, reason: 'Marked number not drawn yet' });
      }
    }
    const isWinner = checkBingo(card, drawn);
    db.prepare('INSERT INTO claims (game_id, player_id, marked_json, valid) VALUES (?, ?, ?, ?)').run(game_id, playerRow.id, JSON.stringify(marked), isWinner ? 1 : 0);
    if(isWinner){
      db.prepare('UPDATE games SET status = ? WHERE id = ?').run('finished', game_id);
    }
    return res.json({ win: isWinner });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// payments (Telebirr stubs)
app.post('/api/payments/create', (req,res)=>{
  const { user_id, amount } = req.body;
  if(!user_id || !amount) return res.status(400).json({ error: 'user_id and amount required' });
  const result = db.prepare('INSERT INTO transactions (user_id, tx_type, amount, provider, status) VALUES (?, ?, ?, ?, ?)').run(user_id, 'topup', amount, 'telebirr', 'pending');
  const txId = result.lastInsertRowid;
  const fakePayUrl = (HOST ? HOST : '') + '/public/pay-simulate.html?tx=' + txId;
  res.json({ provider: 'telebirr', pay_url: fakePayUrl, tx_id: txId });
});

app.post('/api/payments/webhook', (req,res)=>{
  const body = req.body;
  console.log('Payment webhook:', body);
  const txId = body.tx_id || null;
  if(txId){
    db.prepare('UPDATE transactions SET status = ?, provider_ref = ? WHERE id = ?').run(body.status || 'success', body.provider_ref || '', txId);
    if((body.status || 'success') === 'success'){
      const tx = db.prepare('SELECT user_id, amount FROM transactions WHERE id = ?').get(txId);
      if(tx){
        const w = db.prepare('SELECT id, balance FROM wallets WHERE user_id = ?').get(tx.user_id);
        if(w){
          db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(tx.amount, tx.user_id);
        } else {
          db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, ?)').run(tx.user_id, tx.amount);
        }
      }
    }
    return res.json({ ok:true });
  }
  return res.status(400).json({ error:'tx_id required' });
});

// Telegram webhook receiver
app.post('/api/webhook', (req,res)=>{
  const update = req.body;
  try{
    if(update.message){
      if(update.message.web_app_data){
        console.log('web_app_data:', update.message.web_app_data.data);
      }
    }
  }catch(e){
    console.error('webhook error', e);
  }
  res.sendStatus(200);
});

// migrate-only
if(process.argv.includes('--migrate-only')){
  console.log('Migrate-only: schema applied by db.js (if present). Exiting.');
  process.exit(0);
}

app.listen(PORT, ()=> {
  console.log('Bingo API listening on port', PORT);
  console.log('HOST:', HOST || '(not set)');
});
