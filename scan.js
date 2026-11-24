// Moteur de reconnaissance : même calcul que tools/features.py
const Scan = (() => {
  const GW = 8, GH = 11, AW = 14, AH = 12, ART = [4, 8, 60, 44];
  const W = 64, H = 88;
  let DB = null; // {cards, sets, dim, scale, feats:Int8Array, byId}

  // pixels RGBA d'une image 256x352 -> Float32Array 88*64*3 (moyenne par blocs 4x4)
  function small(px) {
    const a = new Float32Array(W * H * 3);
    for (let y = 0; y < 352; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4, j = (((y >> 2) * W) + (x >> 2)) * 3;
      a[j] += px[i]; a[j + 1] += px[i + 1]; a[j + 2] += px[i + 2];
    }
    for (let k = 0; k < a.length; k++) a[k] /= 16;
    return a;
  }
  function norm(v) {
    let m = 0; for (const x of v) m += x; m /= v.length;
    let s = 0; for (let k = 0; k < v.length; k++) { v[k] -= m; s += v[k] * v[k]; }
    s = Math.sqrt(s / v.length) + 1e-6;
    for (let k = 0; k < v.length; k++) v[k] /= s;
    return v;
  }
  function feature(px) {
    const a = small(px);
    // grille de couleurs 11x8x3
    const col = new Float32Array(GW * GH * 3), cw = W / GW, ch = H / GH;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = (Math.floor(y / ch) * GW + Math.floor(x / cw)) * 3, j = (y * W + x) * 3;
      col[c] += a[j]; col[c + 1] += a[j + 1]; col[c + 2] += a[j + 2];
    }
    const n = cw * ch, mean = [0, 0, 0];
    for (let k = 0; k < col.length; k++) { col[k] /= n; mean[k % 3] += col[k] / (GW * GH); }
    for (let k = 0; k < col.length; k++) col[k] -= mean[k % 3];
    norm(col);
    // illustration en gris, grille 12x14, puis gradients
    const [x0, y0, x1, y1] = ART, bw = (x1 - x0) / AW, bh = (y1 - y0) / AH;
    const g = new Float32Array(AW * AH);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const j = (y * W + x) * 3;
      g[Math.floor((y - y0) / bh) * AW + Math.floor((x - x0) / bw)] += (a[j] + a[j + 1] + a[j + 2]) / 3;
    }
    for (let k = 0; k < g.length; k++) g[k] /= bw * bh;
    const gx = new Float32Array(AH * (AW - 1)), gy = new Float32Array((AH - 1) * AW);
    for (let y = 0; y < AH; y++) for (let x = 0; x < AW - 1; x++) gx[y * (AW - 1) + x] = g[y * AW + x + 1] - g[y * AW + x];
    for (let y = 0; y < AH - 1; y++) for (let x = 0; x < AW; x++) gy[y * AW + x] = g[(y + 1) * AW + x] - g[y * AW + x];
    norm(gx); norm(gy);
    const f = new Float32Array(col.length + gx.length + gy.length);
    f.set(col); f.set(gx.map(v => v * 0.8), col.length); f.set(gy.map(v => v * 0.8), col.length + gx.length);
    return f;
  }

  async function load(base) {
    const [idx, bin] = await Promise.all([
      fetch(base + 'db/index.json').then(r => r.json()),
      fetch(base + 'db/features.bin').then(r => r.arrayBuffer()),
    ]);
    DB = { ...idx, feats: new Int8Array(bin), byId: new Map(idx.cards.map((c, i) => [c[0], i])) };
    return DB;
  }

  // k meilleurs candidats : [{i, d}] (distance au carré, plus petit = mieux)
  function match(f, k = 12) {
    const { feats, dim, scale } = DB, N = feats.length / dim;
    const q = new Float32Array(dim); for (let j = 0; j < dim; j++) q[j] = f[j] * scale;
    const best = [];
    for (let i = 0, o = 0; i < N; i++, o += dim) {
      let d = 0;
      for (let j = 0; j < dim; j++) { const t = feats[o + j] - q[j]; d += t * t; }
      if (best.length < k || d < best[best.length - 1].d) {
        best.push({ i, d }); best.sort((a, b) => a.d - b.d); if (best.length > k) best.pop();
      }
    }
    const s2 = scale * scale * dim;
    return best.map(b => ({ i: b.i, d: b.d / s2 }));
  }

  // Dessine une zone (sx,sy,sw,sh) d'une source dans un canvas 256x352 et renvoie l'empreinte
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  function featureFrom(src, sx, sy, sw, sh) {
    cv.width = 256; cv.height = 352;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, 256, 352);
    const px = ctx.getImageData(0, 0, 256, 352).data;
    const f = feature(px);
    // contraste (écart-type de la luminosité) : très faible = poche vide / pas de carte
    let m = 0, m2 = 0, n = 0;
    for (let i = 0; i < px.length; i += 32) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; m += l; m2 += l * l; n++; }
    m /= n; f.contrast = Math.sqrt(Math.max(0, m2 / n - m * m));
    return f;
  }

  // Bonus si l'OCR a lu "numéro/total" et que ça correspond à une carte candidate
  function applyOcr(cands, text) {
    const m = (text || '').replace(/[oO]/g, '0').match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
    if (!m) return cands;
    const num = String(+m[1]), tot = +m[2];
    for (const c of cands) {
      const card = DB.cards[c.i], set = DB.sets[card[3]];
      if (String(+card[2]) === num || card[2] === m[1]) c.d *= (set && set[1] === tot) ? 0.35 : 0.7;
    }
    return cands.sort((a, b) => a.d - b.d);
  }

  // Ajoute des cartes calculées dans l'app (nouvelles sorties) : rows = [Int8Array(dim)]
  function addCards(cards, rows) {
    const fresh = cards.map((c, k) => [c, rows[k]]).filter(([c]) => !DB.byId.has(c[0]));
    if (!fresh.length) return 0;
    const n = DB.feats.length, out = new Int8Array(n + fresh.length * DB.dim);
    out.set(DB.feats);
    fresh.forEach(([c, r], k) => { out.set(r, n + k * DB.dim); DB.byId.set(c[0], DB.cards.length); DB.cards.push(c); });
    DB.feats = out;
    return fresh.length;
  }
  const quant = f => { const q = new Int8Array(f.length); for (let j = 0; j < f.length; j++) q[j] = Math.max(-127, Math.min(127, Math.round(f[j] * DB.scale))); return q; };
  // Empreinte d'une image de carte TCGdex (PNG à coins transparents posés sur du gris, comme en Python)
  function featureFromCardImage(img) {
    cv.width = 256; cv.height = 352;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(0, 0, 256, 352);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, 256, 352);
    return quant(feature(ctx.getImageData(0, 0, 256, 352).data));
  }

  return { feature, featureFrom, featureFromCardImage, load, match, applyOcr, addCards, get db() { return DB; } };
})();
if (typeof module !== 'undefined') module.exports = Scan;
