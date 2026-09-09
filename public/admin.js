/* Altcoin Faucet admin panel script (no framework). */

const $ = (id) => document.getElementById(id);

const state = { authed: false, coin: null };

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const S = { satPerCoin: 1e8, decimals: 8, ticker: 'coin' };

function setCoin(c) {
  if (!c) return;
  state.coin = c;
  S.satPerCoin = c.satPerCoin || 1e8;
  S.decimals = c.decimals ?? 8;
  S.ticker = c.ticker || c.name || 'coin';
  const badge = $('brand-coin');
  if (badge) badge.textContent = S.ticker;
}

/** Format a sat amount with the coin's decimals + ticker. */
function fmtCoin(sat) {
  if (sat === null || sat === undefined || !Number.isFinite(Number(sat))) return '–';
  const coin = Number(sat) / S.satPerCoin;
  return coin.toLocaleString(undefined, { maximumFractionDigits: S.decimals }) + ' ' + S.ticker;
}

function showAlert(kind, text, target) {
  const box = target || $('admin-alert');
  box.className = 'alert ' + kind;
  box.textContent = text;
  box.classList.remove('hidden');
  if (kind === 'ok') setTimeout(() => box.classList.add('hidden'), 5000);
}

function setViews() {
  $('login-view').classList.toggle('hidden', state.authed);
  $('panel-view').classList.toggle('hidden', !state.authed);
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, message: 'unexpected server response' };
  }
  if (!res.ok && data.ok === undefined) data.ok = false;
  return { status: res.status, data };
}

async function apiGet(url) {
  const res = await fetch(url);
  return { status: res.status, data: await res.json() };
}

/* ---------- session / login ---------- */

async function boot() {
  const { data } = await apiGet('/api/admin/session');
  state.authed = data.authed === true;
  setViews();
  if (state.authed) {
    $('panel-title').textContent = 'Admin panel — signed in as ' + esc(data.username || '');
    await loadStats();
  }
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { status, data } = await postJSON('/api/admin/login', {
    username: $('user').value,
    password: $('pass').value,
  });
  if (status === 200 && data.ok) {
    state.authed = true;
    $('pass').value = '';
    setViews();
    $('panel-title').textContent = 'Admin panel — signed in as ' + esc(data.username || '');
    await loadStats();
  } else {
    showAlert('err', data.message || 'Login failed.', $('login-feedback'));
    $('login-feedback').classList.remove('hidden');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await postJSON('/api/admin/logout', {});
  state.authed = false;
  setViews();
});

/* ---------- data ---------- */

async function loadStats() {
  const { status, data } = await apiGet('/api/admin/stats');
  if (status === 401) {
    state.authed = false;
    setViews();
    return;
  }
  if (!data.ok) return;
  renderSummary(data);
  renderClaims(data.claims);
  renderSettled(data.settledRounds);
  renderTx(data.recentTransactions);
}

function renderSummary(s) {
  if (s.coin) setCoin(s.coin);
  const rows = [
    ['Current round', '#' + s.currentRoundNo],
    ['Submitted this round', s.submittedInRound + ' / ' + s.roundSize],
    ['Single payout', fmtCoin(s.singlepaySat)],
    ['Round trigger', 'fills at ' + s.roundSize + ' claims'],
    ['Total paid out (all rounds)', fmtCoin(s.totalPayoutsSat)],
    ['Total submissions (all time)', Number(s.totalSubmissions).toLocaleString()],
    ['Donation balance', s.donationBalanceSat === null ? 'unavailable' : fmtCoin(s.donationBalanceSat)],
    ['Block height', s.blockHeight !== null ? Number(s.blockHeight).toLocaleString() : '–'],
    ['Difficulty', s.difficulty !== null ? Number(s.difficulty).toPrecision(6) : '–'],
  ];
  $('summary-list').innerHTML = rows
    .map(([k, v]) => '<li><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></li>')
    .join('');
  // Inputs talk in whole coins (plain number, no ticker).
  $('sp-value').value = S.satPerCoin ? (s.singlepaySat / S.satPerCoin).toFixed(Math.min(S.decimals, 8)) : '';
  $('rn-value').value = s.currentRoundNo;
}

function renderClaims(claims) {
  const tb = $('claims-table').querySelector('tbody');
  if (!claims.length) {
    tb.innerHTML = '<tr><td colspan="4" class="muted">No claims yet in this round.</td></tr>';
    return;
  }
  tb.innerHTML = claims
    .map((c) => '<tr><td>' + esc(c.id) + '</td><td class="mono">' + esc(c.address) + '</td><td>' + esc(c.ip) + '</td><td>' + esc(c.createdAt) + '</td></tr>')
    .join('');
}

function renderSettled(rows) {
  const tb = $('settled-table').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="muted">No rounds settled yet.</td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map((r) => '<tr><td>#' + esc(r.roundNo) + '</td><td class="num">' + esc(fmtCoin(r.amountSat)) + '</td><td class="num">' + esc(r.payeeCount) + '</td><td class="mono">' + esc(r.txid) + '</td><td>' + esc(r.settledAt) + '</td></tr>')
    .join('');
}

function renderTx(txs) {
  const tb = $('tx-table').querySelector('tbody');
  if (!txs.length) {
    tb.innerHTML = '<tr><td colspan="5" class="muted">No recent transactions (or wallet RPC unavailable).</td></tr>';
    return;
  }
  tb.innerHTML = txs
    .map(
      (t) =>
        '<tr><td>' + esc(t.confirmations) + '</td><td>' + esc(t.category || '') + '</td>' +
        '<td class="num">' + esc(fmtCoin(t.amountSat)) + '</td>' +
        '<td class="mono">' + esc(t.address || '') + '</td><td class="mono">' + esc(t.txid || '') + '</td></tr>',
    )
    .join('');
}

/* ---------- controls ---------- */

async function runAction(name, body, successMsg) {
  const btnEl = document.querySelector('[data-action="' + name + '"]');
  const { status, data } = await postJSON('/api/admin/' + name, body || {});
  if (status === 401) {
    state.authed = false;
    setViews();
    return;
  }
  if (status >= 400 || !data.ok) {
    showAlert('err', (data.message || 'Request failed.') + ' (' + (data.code || status) + ')');
    return;
  }
  if (successMsg) showAlert('ok', successMsg);
  await loadStats();
}

// wire buttons to their actions
[
  ['sp-btn', 'singlepay', () => ({ value: parseFloat($('sp-value').value) }), 'Single payout updated.'],
  ['rn-btn', 'round-no', () => ({ value: parseInt($('rn-value').value, 10) }), 'Round number updated.'],
  ['clear-btn', 'clear-round', () => ({}), 'Round cleared.'],
  ['settle-btn', 'settle', () => ({}), ''],
].forEach(([id, action, bodyFn, okMsg]) => {
  const el = $(id);
  el.dataset.action = action;
  el.addEventListener('click', async () => {
    el.disabled = true;
    try {
      if (action === 'settle') {
        const { status, data } = await postJSON('/api/admin/settle', {});
        if (status === 401) {
          state.authed = false;
          setViews();
          return;
        }
        if (data.ok) {
          showAlert('ok', 'Round #' + data.roundNo + ' settled — tx ' + data.txid + ' (' + data.payeeCount + ' payees).');
        } else {
          const reasons = {
            'not-full': 'Round has fewer claims than the fill threshold.',
            'insufficient-funds': (() => {
              const c = (n) => (n === undefined ? '?' : Number(n).toLocaleString(undefined, { maximumFractionDigits: S.decimals }));
              return 'Not enough donations: required ' + c(data.requiredCoin) + ' ' + S.ticker + ', available ' + c(data.availableCoin) + ' ' + S.ticker + '.';
            })(),
            'already-settled': 'Round already settled.',
            'no-open-round': 'No open round exists.',
          };
          showAlert('err', 'Cannot settle: ' + (reasons[data.reason] || data.reason));
        }
      } else {
        await runAction(action, bodyObj(bodyFn), okMsg);
      }
    } finally {
      el.disabled = false;
      await loadStats();
    }
  });
});

function bodyObj(fn) {
  try {
    const v = fn();
    return v && Object.values(v).every((x) => Number.isFinite(x)) ? v : null;
  } catch {
    return null;
  }
}

boot();
setInterval(async () => {
  if (state.authed) await loadStats().catch(() => undefined);
}, 45000);
