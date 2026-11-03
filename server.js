// Sock Off – provider backend. Zero dependencies, Node 18+.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const RTP = 0.97;
const MODES = { 2: ['white', 'black'], 3: ['white', 'black', 'red'], 4: ['white', 'black', 'red', 'pink'] };
const MIN_BET = 10, MAX_BET = 100000000;            // in minor units (cents)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'; // set to your game domain in production

// Operators you sell to. Each gets its own secret and wallet URL.
const OPERATORS = {
  demo: {
    secret: process.env.DEMO_SECRET || 'change-me',
    wallet: process.env.OPERATOR_WALLET_URL || `http://localhost:${PORT}/mock-operator`,
  },
};

const sessions = new Map(); // token -> {operator, player_id, currency, exp}

// ---------- helpers ----------
const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-headers': 'content-type,x-operator,x-signature', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
  req.on('end', () => ok(d)); req.on('error', no);
});
// Unbiased uniform int in [0,n) from the OS CSPRNG
const rngInt = (n) => crypto.randomInt(0, n);
const logRound = (r) => fs.appendFileSync('rounds.jsonl', JSON.stringify(r) + '\n');

async function wallet(op, path, payload) {
  const body = JSON.stringify(payload);
  const r = await fetch(op.wallet + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sign(op.secret, body) }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'wallet_error'), { code: j.error || 'wallet_error' });
  return j;
}
async function retry(fn, n = 3) {
  for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { if (i === n - 1) throw e; await new Promise(r => setTimeout(r, 300 * (i + 1))); } }
}

// ---------- routes ----------
const routes = {
  // Operator server -> provider: open a game session for a player. Signed with operator secret.
  'POST /api/session': async (req, res, raw) => {
    const op = OPERATORS[req.headers['x-operator']];
    if (!op || sign(op.secret, raw) !== req.headers['x-signature']) return send(res, 401, { error: 'bad_signature' });
    const { player_id, currency } = JSON.parse(raw);
    if (!player_id || !currency) return send(res, 400, { error: 'bad_request' });
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { operator: req.headers['x-operator'], player_id, currency, exp: Date.now() + 3600e3 });
    send(res, 200, { token });
  },

  // Game config for the frontend
  'GET /api/config': async (req, res) => send(res, 200, {
    rtp: RTP, minBet: MIN_BET, maxBet: MAX_BET,
    modes: Object.fromEntries(Object.entries(MODES).map(([n, c]) => [n, { colors: c, payout: +(RTP * n).toFixed(2) }])),
  }),

  // DEMO ONLY: lets the bundled game page start a play-money session. Delete before going live.
  'POST /api/demo-session': async (req, res) => {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { operator: 'demo', player_id: 'demo-' + token.slice(0, 8), currency: 'EUR', exp: Date.now() + 3600e3 });
    send(res, 200, { token });
  },

  // Player browser -> provider: current balance from the operator wallet
  'POST /api/balance': async (req, res, raw) => {
    const s = sessions.get(JSON.parse(raw).token);
    if (!s || s.exp < Date.now()) return send(res, 401, { error: 'invalid_session' });
    try { send(res, 200, await wallet(OPERATORS[s.operator], '/balance', { player_id: s.player_id, currency: s.currency })); }
    catch (e) { send(res, 502, { error: e.code }); }
  },

  // Player browser -> provider: play one round
  'POST /api/play': async (req, res, raw) => {
    const { token, mode, pick, bet } = JSON.parse(raw);
    const s = sessions.get(token);
    if (!s || s.exp < Date.now()) return send(res, 401, { error: 'invalid_session' });
    const colors = MODES[mode];
    if (!colors || !colors.includes(pick)) return send(res, 400, { error: 'invalid_pick' });
    if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET) return send(res, 400, { error: 'invalid_bet' });

    const op = OPERATORS[s.operator];
    const round_id = crypto.randomUUID();
    const base = { round_id, player_id: s.player_id, currency: s.currency };

    // 1) debit the bet at the operator's wallet
    let bal;
    try { bal = (await wallet(op, '/bet', { ...base, amount: bet })).balance; }
    catch (e) { return send(res, 402, { error: e.code }); }

    // 2) draw on the server, 3) credit win
    try {
      const result = colors[rngInt(colors.length)];
      const win = result === pick ? Math.floor(bet * 97 * mode / 100) : 0; // integer math, floor to whole cents
      if (win > 0) bal = (await retry(() => wallet(op, '/win', { ...base, amount: win }))).balance;
      logRound({ ts: new Date().toISOString(), operator: s.operator, ...base, mode, pick, result, bet, win });
      send(res, 200, { round_id, result, win, balance: bal });
    } catch (e) {
      // something failed after the debit -> refund the bet
      try { await retry(() => wallet(op, '/rollback', { ...base, amount: bet })); } catch (_) { logRound({ ts: new Date().toISOString(), ...base, status: 'ROLLBACK_FAILED_RECONCILE', bet }); }
      send(res, 500, { error: 'round_failed_refunded' });
    }
  },

  // ---------- mock operator wallet (for local testing only; remove in production) ----------
  'POST /mock-operator/bet': async (req, res, raw) => {
    const j = JSON.parse(raw); const b = mockBal.get(j.player_id) ?? 100000;
    if (b < j.amount) return send(res, 402, { error: 'insufficient_funds' });
    mockBal.set(j.player_id, b - j.amount); send(res, 200, { balance: b - j.amount });
  },
  'POST /mock-operator/win': async (req, res, raw) => {
    const j = JSON.parse(raw); const b = (mockBal.get(j.player_id) ?? 100000) + j.amount;
    mockBal.set(j.player_id, b); send(res, 200, { balance: b });
  },
  'POST /mock-operator/balance': async (req, res, raw) => {
    const j = JSON.parse(raw); send(res, 200, { balance: mockBal.get(j.player_id) ?? 100000 });
  },
  'POST /mock-operator/rollback': async (req, res, raw) => {
    const j = JSON.parse(raw); const b = (mockBal.get(j.player_id) ?? 100000) + j.amount;
    mockBal.set(j.player_id, b); send(res, 200, { balance: b });
  },
};
const mockBal = new Map();

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    try { const html = fs.readFileSync(__dirname + '/index.html'); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
    catch (_) { return send(res, 404, { error: 'index_html_missing' }); }
  }
  const h = routes[`${req.method} ${req.url.split('?')[0]}`];
  if (!h) return send(res, 404, { error: 'not_found' });
  try { await h(req, res, await readBody(req)); }
  catch (e) { console.error(e); send(res, 500, { error: 'server_error' }); }
}).listen(PORT, () => console.log(`Sock Off server on :${PORT}`));
