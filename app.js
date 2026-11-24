{
// ---------- outils ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const API = 'https://api.tcgdex.net/v2/fr';
const IMG = (path, q = 'low') => `https://assets.tcgdex.net/fr/${path}/${q}.webp`;
const chf = v => 'CHF ' + (v ?? 0).toLocaleString('fr-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const VNAME = { normal: 'Normale', reverse: 'Reverse', holo: 'Holo', firstEdition: '1re édition' };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let toastT;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------- état ----------
const cfg = store.get('cfg', { user: '', repo: 'pokescan-data', token: '' });
let coll = store.get('coll', { v: 1, items: [] });
let collSha = store.get('collSha', null);
let dirty = store.get('dirty', false);
let hist = store.get('hist', { days: [], prices: {} });
let rate = null;
const details = new Map(); // id -> carte TCGdex complète (avec prix)

// ---------- prix ----------
// Même règle que tools/update_prices.py
// Prix Cardmarket (EUR) ; si Cardmarket n'a rien, prix TCGplayer (USD) converti en EUR.
const TCG_KEYS = {
  normal: ['normal', 'holofoil', 'unlimited', 'unlimited-holofoil'],
  holo: ['holofoil', 'unlimited-holofoil', 'normal'],
  reverse: ['reverse-holofoil'],
  firstEdition: ['1st-edition-holofoil', '1st-edition', '1st-edition-normal'],
};
let usd = null; // dollars pour 1 euro
function priceInfo(card, variant) {
  const cm = card?.pricing?.cardmarket || {};
  const keys = variant === 'reverse' ? ['trend-holo', 'avg30-holo', 'avg-holo'] : ['trend', 'avg30', 'avg'];
  const low = (variant === 'reverse' ? cm['low-holo'] : null) || cm.low;
  const [trend, avg30] = [+cm[keys[0]] || 0, +cm[keys[1]] || 0];
  // Pic passager (ex. Rayquaza XY141 : tendance 138 €, moyenne 30 j 75 €) → on prend la moyenne 30 j
  if (trend && avg30 && trend > 1.5 * avg30) return { eur: avg30, low, src: 'Cardmarket' };
  for (const k of keys) if (cm[k]) return { eur: +cm[k], low, src: 'Cardmarket' };
  const tp = card?.pricing?.tcgplayer || {}, r = usd || 1.1;
  for (const k of TCG_KEYS[variant] || []) {
    const x = tp[k], p = x && (x.marketPrice || x.midPrice);
    if (p) return { eur: p / r, low: x.lowPrice ? x.lowPrice / r : null, src: 'TCGplayer' };
  }
  return null;
}
const priceEur = (card, variant) => priceInfo(card, variant)?.eur ?? null;
// Prix douteux = TCGdex a probablement relié la carte au mauvais produit
// (ex. Mewtwo EX XY107 à 5'550 € sans aucune offre "low"). Même règle que tools/update_prices.py
function suspect(card, variant) {
  const i = priceInfo(card, variant);
  if (!i || i.eur < 50) return false;
  return i.low ? i.eur > 30 * i.low : i.eur >= 100;
}
const trustedEur = (card, v) => suspect(card, v) ? null : priceEur(card, v);
const curRate = () => rate || hist.days?.[hist.days.length - 1]?.rate || 0.93;
function unitEur(it) {
  if (it.pm != null) return it.pm / curRate(); // prix manuel (saisi en CHF)
  const s = hist.prices?.[it.id + '|' + it.v];
  if (details.has(it.id) && suspect(details.get(it.id), it.v)) return null; // exclu du total
  const live = details.has(it.id) ? priceEur(details.get(it.id), it.v) : null;
  return live ?? (s && s.length ? s[s.length - 1][1] : null);
}
const isSuspect = it => it.pm == null && details.has(it.id) && suspect(details.get(it.id), it.v);
// Les promos (et numéros avec lettres) n'ont pas de "/total" imprimé
const numTxt = info => /^Promo/i.test(info.set) || /[a-z]/i.test(info.num) ? info.num : `${info.num}/${info.total || '?'}`;
async function getRate() {
  if (rate) return rate;
  const last = hist.days?.[hist.days.length - 1];
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=CHF,USD').then(r => r.json());
    rate = r.rates.CHF; usd = r.rates.USD || null;
  } catch { rate = last?.rate || 0.93; usd = last?.usd || null; }
  return rate;
}
async function detail(id) {
  if (details.has(id)) return details.get(id);
  const c = await fetch(`${API}/cards/${encodeURIComponent(id)}`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (c) details.set(id, c);
  return c;
}
function variantsOf(c) {
  const v = c?.variants || {};
  const list = ['normal', 'reverse', 'holo', 'firstEdition'].filter(k => v[k]);
  return list.length ? list : ['normal'];
}

// ---------- GitHub ----------
const gh = (path, opt = {}) => fetch(`https://api.github.com/repos/${cfg.user}/${cfg.repo}/${path}`, {
  ...opt, headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', ...(opt.headers || {}) },
});
const b64dec = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), c => c.charCodeAt(0)));
const b64enc = s => { const u = new TextEncoder().encode(s); let r = ''; for (let i = 0; i < u.length; i += 8192) r += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(r); };
async function ghGet(file) {
  const r = await gh('contents/' + file + '?t=' + Date.now());
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json();
  let text;
  if (j.content) text = b64dec(j.content);
  else { // fichier > 1 Mo : on passe par l'API "raw"
    const raw = await gh('contents/' + file, { headers: { Accept: 'application/vnd.github.raw+json' } });
    text = await raw.text();
  }
  return { json: JSON.parse(text), sha: j.sha };
}
async function ghPut(file, json, sha, msg) {
  const r = await gh('contents/' + file, {
    method: 'PUT', body: JSON.stringify({ message: msg, content: b64enc(JSON.stringify(json, null, 1)), ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
  return (await r.json()).content.sha;
}
const ready = () => cfg.user && cfg.repo && cfg.token;

async function pull() {
  if (!ready()) return;
  try {
    const [c, h] = await Promise.all([ghGet('collection.json'), ghGet('history.json')]);
    if (h.json) { hist = h.json; store.set('hist', hist); }
    if (dirty) { collSha = c.sha; await push(); }
    else if (c.json) { coll = c.json; collSha = c.sha; store.set('coll', coll); store.set('collSha', collSha); }
  } catch (e) { toast('Synchronisation impossible (' + e.message + ')'); }
  renderColl();
}
let saveT, saving = false;
function save() {
  dirty = true; store.set('coll', coll); store.set('dirty', true);
  clearTimeout(saveT); saveT = setTimeout(push, 1500);
}
async function push() {
  if (!ready() || saving) return;
  saving = true;
  try {
    try { collSha = await ghPut('collection.json', coll, collSha, 'Collection mise à jour'); }
    catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      collSha = (await ghGet('collection.json')).sha; // version en conflit : on réessaie avec la dernière
      collSha = await ghPut('collection.json', coll, collSha, 'Collection mise à jour');
    }
    dirty = false; store.set('dirty', false); store.set('collSha', collSha);
  } catch (e) { toast('Pas sauvegardé sur GitHub (' + e.message + '), je réessaierai'); }
  saving = false;
}

// ---------- collection ----------
function addItem(id, v, q) {
  const it = coll.items.find(x => x.id === id && x.v === v);
  if (it) it.q += q; else coll.items.push({ id, v, q, added: today() });
  save(); renderColl();
}
const cardInfo = id => {
  const db = Scan.db; const i = db?.byId.get(id);
  if (i == null) return null;
  const c = db.cards[i], s = db.sets[c[3]] || ['?', 0];
  return { id, name: c[1], num: c[2], set: s[0], total: s[1], img: c[4] };
};

// ---------- navigation ----------
let view = 'scan';
function show(v) {
  view = v;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  if (v === 'scan') startCam(); else stopCam();
  if (v === 'coll') renderColl();
  if (v === 'set') fillSettings();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.v));

// ---------- feuille du bas ----------
function openSheet(html) { $('#sheetbox').innerHTML = html; $('#sheet').hidden = false; return $('#sheetbox'); }
function closeSheet() { $('#sheet').hidden = true; $('#sheetbox').innerHTML = ''; }
$('.sheet-bg').onclick = closeSheet;

// Bloc "ajouter cette carte" (scan, ajout manuel, page de classeur)
async function addBlock(el, id, { alts = [], onDone, label = 'Ajouter', onPick, onAdd, v0 = null, q0 = 1 } = {}) {
  const info = cardInfo(id);
  if (!info) { el.innerHTML = '<p class="note">Carte inconnue.</p>'; return; }
  let v = v0, q = q0;
  const draw = c => {
    const vs = variantsOf(c); if (!v || !vs.includes(v)) v = vs[0];
    const p = c ? trustedEur(c, v) : null, bad = c && suspect(c, v);
    el.innerHTML = `<div class="res">
      <div class="res-main"><img src="${IMG(info.img)}" alt="">
        <div><h3>${esc(info.name)}</h3>
          <div class="meta">${esc(info.set)} · ${esc(numTxt(info))}</div>
          <div class="price">${c ? (p != null ? chf(p * curRate()) : bad ? 'Prix douteux' : 'Prix inconnu') : '…'}</div>
          <div class="chips">${vs.map(k => `<button class="chip ${k === v ? 'on' : ''}" data-v="${k}">${VNAME[k]}</button>`).join('')}</div>
        </div></div>
      <div class="qty"><button data-q="-1" aria-label="Moins">−</button><span>${q}</span><button data-q="1" aria-label="Plus">+</button>
        <span class="note" style="min-width:0;font-size:13px;font-weight:400">exemplaire(s)</span></div>
      <div class="row"><button class="btn" data-a="skip">${onDone ? 'Ignorer' : 'Fermer'}</button><button class="btn primary" data-a="add">${label}</button></div>
      ${alts.length ? `<div class="note" style="margin-top:10px">Ce n'est pas la bonne ? Choisis :</div>
        <div class="alts">${alts.map(a => { const x = cardInfo(a); return x ? `<button data-alt="${esc(a)}"><img src="${IMG(x.img)}" alt="" loading="lazy">${esc(x.num)}</button>` : ''; }).join('')}</div>` : ''}
    </div>`;
    el.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { v = b.dataset.v; draw(c); });
    el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { q = Math.max(1, q + +b.dataset.q); draw(c); });
    el.querySelector('[data-a=add]').onclick = () => {
      if (onAdd) return onAdd(id, v, q);
      addItem(id, v, q); toast(`${info.name} ajoutée ✓`); (onDone || closeSheet)(true);
    };
    el.querySelector('[data-a=skip]').onclick = () => (onDone || closeSheet)(false);
    el.querySelectorAll('[data-alt]').forEach(b => b.onclick = () => {
      const nid = b.dataset.alt; onPick?.(nid);
      addBlock(el, nid, { alts: [id, ...alts.filter(a => a !== nid)], onDone, label, onPick, onAdd });
    });
  };
  draw(null);
  await getRate();
  draw(await detail(id));
}

// ---------- caméra ----------
const video = $('#video');
let stream = null, mode = 'card', loopT = null, locked = false, recent = [], cooldown = null;
async function startCam() {
  if (stream || !Scan.db) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
    video.srcObject = stream; await video.play();
    $('#camoff').hidden = true; layout(); loop();
  } catch (e) {
    stream = null; $('#camoff').hidden = false;
    $('#camoff p').textContent = 'Impossible d\'ouvrir la caméra. Autorise-la dans Safari (aA › Réglages du site web › Caméra).';
  }
}
function stopCam() {
  clearTimeout(loopT); loopT = null;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}
$('#camstart').onclick = startCam;

// Rectangles du guide, en pixels de l'écran (dans #cam)
function guides() {
  const r = $('#cam').getBoundingClientRect(), cw = r.width, ch = r.height;
  if (mode === 'card') {
    let h = ch * 0.8, w = h * 63 / 88;
    if (w > cw * 0.78) { w = cw * 0.78; h = w * 88 / 63; }
    return [{ x: (cw - w) / 2, y: (ch - h) / 2, w, h }];
  }
  const gap = 0.04;
  let w = (cw * 0.96) / (3 + 2 * gap), h = w * 88 / 63;
  if (h * (3 + 2 * gap) > ch * 0.96) { h = (ch * 0.96) / (3 + 2 * gap); w = h * 63 / 88; }
  const W = w * (3 + 2 * gap), H = h * (3 + 2 * gap), x0 = (cw - W) / 2, y0 = (ch - H) / 2, out = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) out.push({ x: x0 + i * w * (1 + gap), y: y0 + j * h * (1 + gap), w, h });
  return out;
}
function layout() {
  $('#overlay').innerHTML = guides().map(g => `<div class="guide ${mode === 'page' ? 'cell' : ''}" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px"></div>`).join('');
  $('#hint').textContent = mode === 'card' ? 'Place une carte dans le cadre' : 'Aligne les 9 cartes dans la grille, puis capture';
  $('#shoot').hidden = mode !== 'page';
}
new ResizeObserver(() => stream && layout()).observe($('#cam'));
// écran -> pixels de la vidéo (la vidéo est en "object-fit: cover")
function toVideo(g) {
  const r = $('#cam').getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(r.width / vw, r.height / vh), ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
  return { x: (g.x - ox) / s, y: (g.y - oy) / s, w: g.w / s, h: g.h / s };
}
function loop() {
  clearTimeout(loopT);
  loopT = setTimeout(() => { if (stream && !locked && mode === 'card' && view === 'scan') tick(); if (stream) loop(); }, 280);
}
function tick() {
  if (!video.videoWidth) return;
  const g = toVideo(guides()[0]);
  const f = Scan.featureFrom(video, g.x, g.y, g.w, g.h);
  const cands = Scan.match(f, 12);
  const top = cands[0];
  if (f.contrast < 22) top.d = 9; // rien dans le cadre
  const box = $('#overlay .guide');
  if (cooldown && (top.i !== cooldown || top.d > 0.9)) cooldown = null;
  recent.push(top.d < 0.75 && top.i !== cooldown ? top.i : -1); recent = recent.slice(-3);
  box?.classList.toggle('ok', top.d < 0.75);
  if (recent.length === 3 && recent.every(x => x === recent[0] && x >= 0)) lock(cands, g);
}
async function lock(cands, g) {
  locked = true; recent = [];
  // photo de la zone du numéro pour l'OCR
  const snap = document.createElement('canvas');
  snap.width = 900; snap.height = Math.round(900 * 0.13 * g.h / g.w);
  snap.getContext('2d').drawImage(video, g.x, g.y + g.h * 0.87, g.w, g.h * 0.13, 0, 0, snap.width, snap.height);
  const ids = cands.map(c => Scan.db.cards[c.i][0]);
  const done = added => { cooldown = Scan.db.byId.get(cur); $('#result').innerHTML = ''; locked = false; };
  let cur = ids[0];
  const el = $('#result');
  addBlock(el, ids[0], { alts: ids.slice(1, 9), onDone: done, onPick: id => (cur = id) });
  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'end' }), 300);
  const txt = await ocr(snap);
  const re = Scan.applyOcr(cands.map(c => ({ ...c })), txt);
  const nid = Scan.db.cards[re[0].i][0];
  if (locked && nid !== ids[0] && cur === ids[0]) {
    cur = nid;
    addBlock(el, nid, { alts: re.slice(1, 9).map(c => Scan.db.cards[c.i][0]), onDone: done, onPick: id => (cur = id) });
  }
}
let worker = null;
async function ocr(canvas) {
  try {
    if (!window.Tesseract) return '';
    if (!worker) {
      worker = await Tesseract.createWorker('eng');
      await worker.setParameters({ tessedit_char_whitelist: '0123456789/', tessedit_pageseg_mode: '11' });
    }
    const r = await Promise.race([worker.recognize(canvas), new Promise(res => setTimeout(() => res(null), 6000))]);
    return r?.data?.text || '';
  } catch { return ''; }
}

// mode
document.querySelectorAll('#mode button').forEach(b => b.onclick = () => {
  mode = b.dataset.m; document.querySelectorAll('#mode button').forEach(x => x.classList.toggle('on', x === b));
  $('#result').innerHTML = ''; locked = false; layout();
});

// ---------- page de classeur ----------
$('#shoot').onclick = async () => {
  if (!video.videoWidth) return;
  const snap = document.createElement('canvas'); snap.width = video.videoWidth; snap.height = video.videoHeight;
  snap.getContext('2d').drawImage(video, 0, 0);
  const slots = guides().map(g => {
    const v = toVideo(g), f = Scan.featureFrom(snap, v.x, v.y, v.w, v.h), cands = Scan.match(f, 8);
    const d = f.contrast < 22 ? 9 : cands[0].d; // poche vide
    return { ids: cands.map(c => Scan.db.cards[c.i][0]), d, on: d < 0.8, v: null };
  });
  await getRate();
  const el = $('#result');
  const draw = () => {
    const n = slots.filter(s => s.on).length;
    el.innerHTML = `<div class="res"><div class="note">Touche une carte pour la corriger ou l'exclure.</div>
      <div class="grid9">${slots.map((s, k) => {
        const x = cardInfo(s.ids[0]);
        const vide = !s.on && s.d >= 0.8 && !s.v;
        return `<button class="g9 ${s.on ? 'on' : 'empty'}" data-k="${k}">${vide ? '<img alt="">' : `<img src="${IMG(x.img)}" alt="">`}<div class="n">${s.on ? esc(x.name) : vide ? 'Vide ?' : 'Exclue'}</div></button>`;
      }).join('')}</div>
      <div class="row"><button class="btn" data-a="x">Annuler</button><button class="btn primary" data-a="ok" ${n ? '' : 'disabled'}>Ajouter ${n} carte${n > 1 ? 's' : ''}</button></div>
      <p class="note">Sans correction, chaque carte est ajoutée en variante normale (ou holo si elle n'existe qu'en holo).</p></div>`;
    el.querySelectorAll('.g9').forEach(b => b.onclick = () => {
      const s = slots[+b.dataset.k];
      const box = openSheet('<div></div>');
      addBlock(box.firstChild, s.ids[0], {
        alts: s.ids.slice(1), label: 'Garder cette carte', v0: s.v, q0: s.q || 1,
        onAdd: (id, v, q) => { s.ids = [id, ...s.ids.filter(x => x !== id)]; s.v = v; s.q = q; s.on = true; closeSheet(); draw(); },
        onDone: () => { s.on = false; closeSheet(); draw(); },
      });
    });
    el.querySelector('[data-a=x]').onclick = () => (el.innerHTML = '');
    el.querySelector('[data-a=ok]').onclick = async () => {
      const keep = slots.filter(s => s.on);
      for (const s of keep) {
        const v = s.v || variantsOf(await detail(s.ids[0]))[0], q = s.q || 1;
        const it = coll.items.find(x => x.id === s.ids[0] && x.v === v);
        if (it) it.q += q; else coll.items.push({ id: s.ids[0], v, q, added: today() });
      }
      save(); renderColl(); el.innerHTML = ''; toast(`${keep.length} carte(s) ajoutée(s) ✓`);
    };
  };
  draw();
  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
};

// ---------- graphique ----------
function lineChart(el, pts, { money = true } = {}) {
  const draw = () => {
    const W = el.clientWidth, H = el.clientHeight;
    if (pts.length < 2) { el.innerHTML = ''; return; }
    const ys = pts.map(p => p[1]), lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.12 || hi * 0.05 || 1;
    const y0 = lo - pad, y1 = hi + pad, L = 4, R = W - 4, T = 14, B = H - 20;
    const X = i => L + (R - L) * i / (pts.length - 1), Y = v => B - (B - T) * (v - y0) / (y1 - y0);
    const up = ys[ys.length - 1] >= ys[0], col = up ? 'var(--up)' : 'var(--down)';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const fmt = s => new Date(s + 'T12:00').toLocaleDateString('fr-CH', { day: 'numeric', month: 'short' });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution de la valeur">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? '#3ddc84' : '#ff5a5f'}" stop-opacity=".35"/><stop offset="1" stop-color="${up ? '#3ddc84' : '#ff5a5f'}" stop-opacity="0"/></linearGradient></defs>
      <path d="${d}L${R},${B}L${L},${B}Z" fill="url(#g)"/>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"/>
      <circle cx="${X(pts.length - 1)}" cy="${Y(ys[ys.length - 1])}" r="4" fill="${col}"/>
      <text x="${L}" y="${H - 4}" fill="#9a9db0" font-size="11">${esc(fmt(pts[0][0]))}</text>
      <text x="${R}" y="${H - 4}" fill="#9a9db0" font-size="11" text-anchor="end">${esc(pts[pts.length - 1][2] || fmt(pts[pts.length - 1][0]))}</text>
      <text x="${R}" y="11" fill="#9a9db0" font-size="11" text-anchor="end">${esc(money ? chf(hi) : hi)}</text>
    </svg>`;
  };
  draw();
  if (!el._ro) { el._ro = new ResizeObserver(() => el._draw?.()); el._ro.observe(el); }
  el._draw = draw;
}

// ---------- vue collection ----------
let range = 30;
document.querySelectorAll('#range button').forEach(b => b.onclick = () => {
  range = +b.dataset.r; document.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === b)); renderTotal();
});
$('#q').oninput = renderList; $('#sort').onchange = renderList;
let fetching = false;
async function fetchMissing() {
  if (fetching) return; fetching = true;
  const need = [...new Set(coll.items.filter(it => unitEur(it) == null && !details.has(it.id)).map(it => it.id))];
  for (let i = 0; i < need.length; i += 6) await Promise.all(need.slice(i, i + 6).map(detail));
  fetching = false;
  if (need.length && view === 'coll') renderColl();
}
function liveTotal() {
  let eur = 0, n = 0;
  for (const it of coll.items) { eur += (unitEur(it) || 0) * it.q; n += it.q; }
  return { eur, n };
}
function renderTotal() {
  const r = rate || hist.days?.[hist.days.length - 1]?.rate || 0.93;
  const { eur, n } = liveTotal();
  const now = eur * r;
  $('#total').textContent = chf(now);
  let pts = (hist.days || []).map(d => [d.d, d.chf]);
  if (range) { const lim = new Date(Date.now() - range * 864e5).toISOString().slice(0, 10); pts = pts.filter(p => p[0] >= lim); }
  if (!pts.length || pts[pts.length - 1][0] !== today()) pts.push([today(), now, 'Maintenant']);
  else pts[pts.length - 1] = [today(), now, "Aujourd'hui"];
  lineChart($('#chart'), pts);
  const first = pts[0][1], diff = now - first;
  $('#delta').className = 'delta ' + (diff >= 0 ? 'up' : 'down');
  $('#delta').textContent = pts.length > 1 ? `${diff >= 0 ? '+' : '−'}${chf(Math.abs(diff))} (${first ? (diff / first * 100).toFixed(1) : '0'} %)` : '';
  $('#chartnote').textContent = pts.length < 3 ? 'Le graphique se remplit au fil des jours : un point chaque nuit.' : '';
  $('#count').textContent = `${n} carte${n > 1 ? 's' : ''} · ${coll.items.length} référence${coll.items.length > 1 ? 's' : ''}`;
}
function renderList() {
  const r = curRate(), q = norm($('#q').value.trim()), sort = $('#sort').value;
  let rows = coll.items.map((it, k) => ({ it, k, info: cardInfo(it.id), u: unitEur(it) }));
  if (q) rows = rows.filter(x => x.info && norm(x.info.name + ' ' + x.info.set).includes(q));
  rows.sort(sort === 'name' ? (a, b) => (a.info?.name || '').localeCompare(b.info?.name || '')
    : sort === 'new' ? (a, b) => (b.it.added || '').localeCompare(a.it.added || '') || b.k - a.k
    : (a, b) => (b.u || 0) * b.it.q - (a.u || 0) * a.it.q);
  $('#list').innerHTML = rows.slice(0, 400).map(({ it, k, info, u }) => info ? `<li data-k="${k}">
    <img src="${IMG(info.img)}" alt="" loading="lazy">
    <div class="t"><b>${esc(info.name)}</b><span>${esc(info.set)} · ${esc(info.num)} · ${VNAME[it.v] || esc(it.v)}${it.q > 1 ? ' · ×' + it.q : ''}${it.pm != null ? ' · prix manuel' : ''}</span></div>
    <div class="v">${u != null ? chf(u * it.q * r) : isSuspect(it) ? '<small>Prix douteux</small>' : '…'}${it.q > 1 && u != null ? `<small>${chf(u * r)} pièce</small>` : ''}</div></li>` : '').join('')
    || '<li class="note">Aucune carte pour l\'instant. Va dans Scanner pour en ajouter.</li>';
  $('#list').querySelectorAll('li[data-k]').forEach(li => li.onclick = () => itemSheet(coll.items[+li.dataset.k]));
}
async function renderColl() {
  if (!Scan.db) return;
  renderTotal(); renderList();
  if (!rate) { await getRate(); renderTotal(); renderList(); }
  fetchMissing();
}
async function itemSheet(it) {
  const info = cardInfo(it.id); if (!info) return;
  const box = openSheet('');
  const draw = c => {
    const r = curRate(), u = unitEur(it), vs = variantsOf(c);
    const raw = c ? priceEur(c, it.v) : null, bad = c && suspect(c, it.v);
    if (!vs.includes(it.v)) vs.push(it.v);
    box.innerHTML = `<img class="bigimg" src="${IMG(info.img, 'high')}" alt="">
      <h2 style="margin:0">${esc(info.name)}</h2>
      <div class="note">${esc(info.set)} · ${esc(numTxt(info))}</div>
      <div class="price" style="font-size:24px;font-weight:800;margin-top:6px">${u != null ? chf(u * r) : bad ? 'Prix douteux' : 'Prix inconnu'} <span class="note" style="font-weight:400">${u != null ? 'pièce' + (it.pm != null ? ' (manuel)' : c && priceInfo(c, it.v)?.src === 'TCGplayer' ? ' · TCGplayer' : '') : ''}</span></div>
      ${bad && it.pm == null ? `<div class="warn">Cardmarket indique ${chf(raw * r)}, ce qui est sûrement une erreur de la base de prix (mauvais produit relié). Cette carte est <b>exclue du total</b> tant que tu n'as pas mis de prix manuel.</div>` : ''}
      <div class="pm"><label>Prix manuel (CHF)<input id="pm" type="number" inputmode="decimal" min="0" step="0.05" placeholder="${raw != null && !bad ? (raw * r).toFixed(2) : 'ex. 10'}" value="${it.pm ?? ''}"></label>
        <button class="btn" data-a="pm">${it.pm != null ? 'Modifier' : 'Utiliser'}</button>${it.pm != null ? '<button class="btn" data-a="pmx">Auto</button>' : ''}</div>
      <div class="fig" id="ichart" style="height:140px"></div><div class="note" id="inote"></div>
      <div class="chips">${vs.map(k => `<button class="chip ${k === it.v ? 'on' : ''}" data-v="${k}">${VNAME[k] || esc(k)}</button>`).join('')}</div>
      <div class="qty"><button data-q="-1" aria-label="Moins">−</button><span>${it.q}</span><button data-q="1" aria-label="Plus">+</button></div>
      <div class="row"><button class="btn" data-a="del">Supprimer</button><button class="btn primary" data-a="ok">OK</button></div>`;
    const s = (hist.prices?.[it.id + '|' + it.v] || []).map(p => [p[0], p[1] * r]);
    if (u != null && (!s.length || s[s.length - 1][0] !== today())) s.push([today(), u * r, 'Maintenant']);
    lineChart(box.querySelector('#ichart'), s);
    box.querySelector('#inote').textContent = s.length < 2 ? 'Historique de prix : un point chaque nuit.' : '';
    box.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
      const other = coll.items.find(x => x !== it && x.id === it.id && x.v === b.dataset.v);
      if (other) { other.q += it.q; coll.items.splice(coll.items.indexOf(it), 1); it = other; } else it.v = b.dataset.v;
      save(); draw(c); renderColl();
    });
    box.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { it.q = Math.max(1, it.q + +b.dataset.q); save(); draw(c); renderColl(); });
    const del = box.querySelector('[data-a=del]');
    del.onclick = () => {
      if (del.dataset.sure) { coll.items.splice(coll.items.indexOf(it), 1); save(); closeSheet(); renderColl(); }
      else { del.dataset.sure = 1; del.textContent = 'Confirmer ?'; del.style.color = 'var(--down)'; }
    };
    box.querySelector('[data-a=pm]').onclick = () => {
      const x = parseFloat(String(box.querySelector('#pm').value).replace(',', '.'));
      if (!(x >= 0)) { toast('Entre un prix en CHF'); return; }
      it.pm = Math.round(x * 100) / 100; save(); draw(c); renderColl(); toast('Prix manuel enregistré');
    };
    const pmx = box.querySelector('[data-a=pmx]');
    if (pmx) pmx.onclick = () => { delete it.pm; save(); draw(c); renderColl(); };
    box.querySelector('[data-a=ok]').onclick = closeSheet;
  };
  draw(details.get(it.id));
  draw(await detail(it.id));
}

// ---------- ajout manuel ----------
let aT;
$('#aq').oninput = () => { clearTimeout(aT); aT = setTimeout(searchDb, 200); };
function searchDb() {
  const raw = $('#aq').value.trim(), el = $('#alist');
  if (!Scan.db || raw.length < 2) { el.innerHTML = ''; return; }
  const m = raw.match(/^(.*?)\s+(\S*\d\S*)$/), name = norm(m ? m[1] : raw), num = m ? m[2].toLowerCase() : null;
  const res = [];
  for (const c of Scan.db.cards) {
    if (!norm(c[1]).includes(name)) continue;
    if (num && String(c[2]).toLowerCase().replace(/^0+/, '') !== num.replace(/^0+/, '')) continue;
    res.push(c); if (res.length >= 60) break;
  }
  el.innerHTML = res.map(c => { const s = Scan.db.sets[c[3]] || ['?', 0];
    return `<li data-id="${esc(c[0])}"><img src="${IMG(c[4])}" alt="" loading="lazy"><div class="t"><b>${esc(c[1])}</b><span>${esc(s[0])} · ${esc(c[2])}/${esc(s[1])}</span></div></li>`; }).join('')
    || '<li class="note">Aucun résultat.</li>';
  el.querySelectorAll('li[data-id]').forEach(li => li.onclick = () => { const box = openSheet('<div></div>'); addBlock(box.firstChild, li.dataset.id); });
}


// ---------- nouvelles cartes (au plus une fois par heure, en arrière-plan) ----------
const b64i8 = r => { let s = ''; for (const x of r) s += String.fromCharCode(x & 255); return btoa(s); };
const i8b64 = b => Int8Array.from(atob(b), c => (c.charCodeAt(0) << 24) >> 24);
function loadExtras() {
  const ex = store.get('extras', { cards: [], rows: [], sets: {} });
  // les cartes que la base GitHub contient déjà n'ont plus besoin d'être gardées ici
  const keep = ex.cards.map((c, k) => [c, ex.rows[k]]).filter(([c]) => !Scan.db.byId.has(c[0]));
  ex.cards = keep.map(x => x[0]); ex.rows = keep.map(x => x[1]);
  for (const id in ex.sets || {}) if (!Scan.db.sets[id]) Scan.db.sets[id] = ex.sets[id];
  Scan.addCards(ex.cards, ex.rows.map(i8b64));
  store.set('extras', ex);
}
let updating = false;
async function checkNewCards(force = false) {
  if (updating || !Scan.db) return;
  if (!force && Date.now() - store.get('lastCheck', 0) < 3600e3) return;
  updating = true;
  try {
    const [brief, sets] = await Promise.all([fetch(API + '/cards').then(r => r.json()), fetch(API + '/sets').then(r => r.json())]);
    store.set('lastCheck', Date.now());
    const ex = store.get('extras', { cards: [], rows: [], sets: {} });
    for (const s of sets) if (!Scan.db.sets[s.id]) { Scan.db.sets[s.id] = ex.sets[s.id] = [s.name, s.cardCount?.official || 0]; }
    const setIds = new Set(sets.map(s => s.id));
    const todo = brief.filter(c => c.image && !Scan.db.byId.has(c.id)).slice(0, 400);
    let added = 0;
    const one = c => new Promise(res => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          let sid = c.id.slice(0, -(c.localId.length + 1)); if (!setIds.has(sid)) sid = c.id.replace(/-[^-]*$/, '');
          const card = [c.id, c.name, c.localId, sid, c.image.split('/fr/')[1]], row = Scan.featureFromCardImage(img);
          if (Scan.addCards([card], [row])) { ex.cards.push(card); ex.rows.push(b64i8(row)); added++; }
        } catch {}
        res();
      };
      img.onerror = () => res();
      img.src = c.image + '/low.png';
    });
    for (let i = 0; i < todo.length; i += 3) {
      await Promise.all(todo.slice(i, i + 3).map(one));
      $('#s-new').textContent = `Nouvelles cartes : ${Math.min(i + 3, todo.length)} / ${todo.length}`;
      await new Promise(r => setTimeout(r, 30)); // laisse respirer l'app
    }
    store.set('extras', ex);
    store.set('lastNew', { at: Date.now(), added });
    if (added) toast(`${added} nouvelle${added > 1 ? 's' : ''} carte${added > 1 ? 's' : ''} ajoutée${added > 1 ? 's' : ''} au scanner`);
  } catch {}
  updating = false;
  showNewStatus();
}
function showNewStatus() {
  const l = store.get('lastNew', null), el = $('#s-new');
  if (el && !updating) el.textContent = l ? `Dernière recherche de nouvelles cartes : ${new Date(l.at).toLocaleString('fr-CH', { dateStyle: 'short', timeStyle: 'short' })} (${l.added} ajoutée${l.added > 1 ? 's' : ''})` : '';
}

// ---------- réglages ----------
function fillSettings() {
  $('#s-ver').textContent = 'Version de l\'app : ' + window.V;
  $('#s-user').value = cfg.user; $('#s-repo').value = cfg.repo; $('#s-token').value = cfg.token;
  const db = Scan.db;
  $('#s-db').textContent = db ? `Base du scanner : ${db.cards.length.toLocaleString('fr-CH')} cartes (base du ${db.built} + nouveautés).` : '';
  showNewStatus();
}
$('#s-save').onclick = async () => {
  cfg.user = $('#s-user').value.trim(); cfg.repo = $('#s-repo').value.trim(); cfg.token = $('#s-token').value.trim();
  store.set('cfg', cfg);
  const msg = $('#s-msg'); msg.textContent = 'Test…';
  try {
    const r = await gh('');
    if (!r.ok) throw new Error(r.status === 404 ? 'dépôt introuvable (nom ou clé incorrects)' : r.status === 401 ? 'clé refusée' : 'erreur ' + r.status);
    msg.textContent = 'Connecté ✓'; await pull();
  } catch (e) { msg.textContent = 'Échec : ' + e.message; }
};
$('#s-prices').onclick = async () => {
  if (!ready()) return toast('Configure GitHub d\'abord');
  const r = await gh('actions/workflows/prices.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  toast(r.ok ? 'Relève lancée, reviens dans 2-3 minutes' : 'Impossible (' + r.status + ') : la clé doit avoir le droit « Actions »');
  if (r.ok) setTimeout(pull, 150000);
};

// ---------- démarrage ----------
(async () => {
  $('#hint').textContent = 'Chargement de la base des cartes…';
  try { await Scan.load('./'); }
  catch { $('#hint').textContent = 'Base des cartes introuvable'; toast('La base du scanner n\'est pas encore construite'); return; }
  try { loadExtras(); } catch {}
  checkNewCards();
  if (!ready()) { show('set'); $('#s-msg').textContent = 'Bienvenue ! Entre tes infos GitHub pour sauvegarder ta collection.'; }
  else show('scan');
  pull();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCam(); else { if (view === 'scan') startCam(); pull(); checkNewCards(); }
  });
})();

// ---------- mise à jour de l'app ----------
// L'iPhone garde les fichiers en cache : on télécharge index.html sans cache et on compare la version.
async function checkUpdate(manual) {
  try {
    const html = await fetch('./?nocache=' + Date.now(), { cache: 'no-store' }).then(r => r.text());
    const v = html.match(/name="pokescan-version" content="([^"]+)"/)?.[1];
    // (une seule tentative par version, pour ne jamais boucler si le serveur renvoie encore l'ancienne page)
    if (v && v !== window.V && (manual || sessionStorage.getItem('upd') !== v)) {
      sessionStorage.setItem('upd', v); toast('Mise à jour…');
      setTimeout(() => location.replace('./?v=' + encodeURIComponent(v)), 600);
    }
    else if (manual) toast('L\'app est à jour (' + window.V + ')');
  } catch { if (manual) toast('Pas de connexion'); }
}
$('#s-upd').onclick = () => checkUpdate(true);
checkUpdate(false);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(false); });
}
