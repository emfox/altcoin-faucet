/* Altcoin Faucet public page script (no build step, no framework). */

const $ = (id) => document.getElementById(id);

/* Coin context is fetched once from /api/config and attached to stats. */
let COIN = null;
const S = { satPerCoin: 1e8, decimals: 8, ticker: 'coin' };

function setCoin(c) {
  if (!c) return;
  COIN = c;
  S.satPerCoin = c.satPerCoin || 1e8;
  S.decimals = c.decimals ?? 8;
  S.ticker = c.ticker || c.name || 'coin';
  const name = c.name || 'Altcoin';
  document.title = `${name} Faucet`;
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', `Free ${name} (${S.ticker}) from the community faucet. Claim once per round.`);
  const badge = $('brand-coin');
  if (badge) badge.textContent = S.ticker;
  const h1 = $('h1-coin');
  if (h1) h1.textContent = `${name} Faucet`;
  const lede = $('lede-text');
  if (lede) lede.textContent = `Free ${name} for the community. Donations keep this faucet running.`;
  const addrLabel = $('addr-label');
  if (addrLabel) addrLabel.textContent = `Your ${name} address`;
  const addrHint = $('addr-hint');
  if (addrHint) addrHint.textContent = `A valid ${name} address. It is checked against the wallet before payout.`;
  const submitBtn = $('submit-btn');
  if (submitBtn) submitBtn.textContent = `Claim ${S.ticker}`;
}

/** Format a sat amount with the coin's decimals + ticker. */
function fmtCoin(sat) {
  if (sat === null || sat === undefined || !Number.isFinite(Number(sat))) return '–';
  const coin = Number(sat) / S.satPerCoin;
  const fixed = coin.toLocaleString(undefined, { maximumFractionDigits: S.decimals });
  return `${fixed} ${S.ticker}`;
}

function fmtInt(n) {
  if (n === null || n === undefined) return '–';
  return Number(n).toLocaleString();
}

function showAlert(kind, text) {
  const box = $('feedback');
  box.className = 'alert ' + kind;
  box.textContent = text;
  box.classList.remove('hidden');
}

function clearAlert() {
  $('feedback').classList.add('hidden');
}

async function refreshStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const s = await res.json();
    if (s.coin) setCoin(s.coin);
    $('st-round').textContent = s.currentRoundNo ? '#' + s.currentRoundNo : '–';
    $('st-submitted').textContent = fmtInt(s.submittedInRound) + ' / ' + fmtInt(s.roundSize);
    $('st-singlepay').textContent = fmtCoin(s.singlepaySat);
    $('st-totalpay').textContent = fmtCoin(s.totalPayoutsSat);
    $('st-total').textContent = fmtInt(s.totalSubmissions);
    $('st-balance').textContent = s.donationBalanceSat === null ? 'unavailable' : fmtCoin(s.donationBalanceSat);
    if (s.donationAddress) $('st-donaddr').textContent = s.donationAddress;
    $('rule-size').textContent = fmtInt(s.roundSize);
    $('ni-blocks').textContent = s.blockHeight !== null ? fmtInt(s.blockHeight) : '–';
    $('ni-diff').textContent = s.difficulty !== null ? Number(s.difficulty).toPrecision(6) : '–';
    $('ni-peers').textContent = s.connections !== null ? fmtInt(s.connections) : '–';
  } catch {
    /* transient network issue; next poll will retry */
  }
}

/* ---- reCAPTCHA v3 ---- */
let recaptchaReady = false;

function loadRecaptcha(siteKey) {
  const script = document.createElement('script');
  script.src = 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(siteKey);
  script.async = true;
  script.onerror = () => showAlert('err', 'Could not load the human-verification script. Please refresh.');
  script.onload = () => {
    if (window.grecaptcha && grecaptcha.enterprise === undefined) {
      recaptchaReady = true;
    }
  };
  document.head.appendChild(script);
}

function getToken(action) {
  return new Promise((resolve) => {
    if (!recaptchaReady) {
      // The library is still loading: wait briefly (typically < 1 s).
      let waited = 0;
      const poll = () => {
        if (recaptchaReady || waited > 5000) return resolve(null);
        waited += 100;
        setTimeout(poll, 100);
      };
      poll();
      return;
    }
    grecaptcha.ready(() => {
      fetch('/api/config')
        .then((r) => r.json())
        .then((cfg) => {
          grecaptcha.execute(cfg.recaptchaSiteKey, { action }).then(resolve, () => resolve(null));
        })
        .catch(() => resolve(null));
    });
  });
}

/* ---- submit ---- */
const form = $('claim-form');
const btn = $('submit-btn');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearAlert();
  const address = $('addr').value.trim();
  if (!address) {
    showAlert('err', 'Please enter your address.');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    const token = await getToken('submit');
    if (!token) {
      showAlert('err', 'Human verification is not ready yet — please retry in a second.');
      return;
    }
    const res = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, recaptchaToken: token }),
    });
    const data = await res.json();
    if (data.ok) {
      let text = data.message || 'Claimed.';
      if (data.txid) text += ' Transaction: ' + data.txid;
      showAlert('ok', text);
      $('addr').value = '';
      refreshStats();
    } else {
      showAlert('err', (data.message || 'Something went wrong.') + ' (' + data.code + ')');
    }
  } catch {
    showAlert('err', 'Network error — please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = COIN ? `Claim ${S.ticker}` : 'Claim coins';
  }
});

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    setCoin(cfg.coin);
    if (!cfg.recaptchaSiteKey || cfg.recaptchaSiteKey.startsWith('your_')) {
      throw new Error('reCAPTCHA not configured');
    }
    loadRecaptcha(cfg.recaptchaSiteKey);
  })
  .catch(() => showAlert('warn', 'Human verification is not configured on this faucet yet.'));

refreshStats();
setInterval(refreshStats, 60000);
