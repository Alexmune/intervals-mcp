import express from "express";
import { randomUUID, timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY    = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID;
const PORT       = process.env.PORT || 3000;
const BASE_URL   = process.env.INTERVALS_BASE_URL || "https://intervals.icu/api/v1";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;          // secreto para proteger el endpoint
const TZ         = process.env.TIMEZONE || "Europe/Madrid";     // zona horaria del atleta

if (!API_KEY || !ATHLETE_ID) {
  console.error("❌ Missing INTERVALS_API_KEY or INTERVALS_ATHLETE_ID");
  process.exit(1);
}

// ─── Intervals API helper ─────────────────────────────────────────────────────
// Límite de peticiones simultáneas a intervals + reintentos ante 429/5xx
const MAX_CONCURRENT = 3;
let inFlight = 0; const waiters = [];
async function acquireSlot() {
  if (inFlight < MAX_CONCURRENT) { inFlight++; return; }
  await new Promise(r => waiters.push(r)); // el hueco se transfiere directamente
}
function releaseSlot() {
  const next = waiters.shift();
  if (next) next(); else inFlight--;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callIntervals(path, method = "GET", body = null) {
  const credentials = Buffer.from(`API_KEY:${API_KEY}`).toString("base64");
  const options = {
    method,
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const MAX_RETRIES = 4;
  for (let attempt = 0; ; attempt++) {
    await acquireSlot();
    let res;
    try { res = await fetch(`${BASE_URL}${path}`, options); }
    catch (e) {
      releaseSlot();
      if (attempt < MAX_RETRIES) { await sleep(500 * 2 ** attempt); continue; }
      console.warn(`⚠️ intervals ${method} ${path.split("?")[0]}: ${e.message}`);
      throw e;
    }
    releaseSlot();
    if (res.ok) {
      const text = await res.text();
      if (!text || text.trim() === "") return {};
      return JSON.parse(text);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const ra = parseFloat(res.headers.get("retry-after"));
      const wait = !isNaN(ra) ? ra * 1000 : 600 * 2 ** attempt + Math.random() * 300;
      console.warn(`⏳ intervals ${res.status} en ${path.split("?")[0]} — reintento ${attempt + 1} en ${Math.round(wait)} ms`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (res.status !== 404) console.warn(`⚠️ intervals ${res.status} en ${method} ${path.split("?")[0]}`);
    throw new Error(`Intervals API ${res.status}: ${text}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Fechas siempre en la zona horaria del atleta (evita el desfase UTC de 00:00-02:00)
const localDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const today    = () => localDate(Date.now());
const daysAgo  = (n) => localDate(Date.now() - n * 86400000);
const daysAhead= (n) => localDate(Date.now() + n * 86400000);
const addDays  = (ds, n) => { const d = new Date(`${ds}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().split("T")[0]; };
const dayOfWeek= (ds) => new Date(`${ds}T12:00:00Z`).getUTCDay(); // 0=Dom, 6=Sáb
const mondayOf = (ds) => { const d = dayOfWeek(ds); return addDays(ds, d === 0 ? -6 : 1 - d); };

function safeRange(oldest, newest, maxDays = 60) {
  const end  = newest || today();
  const start= oldest || daysAgo(maxDays);
  const diff = (new Date(end) - new Date(start)) / 86400000;
  return diff > maxDays ? { oldest: daysAgo(maxDays), newest: end } : { oldest: start, newest: end };
}

function toArray(data, key) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[key])) return data[key];
  if (data && typeof data === "object") {
    const found = Object.values(data).find(Array.isArray);
    return found || [];
  }
  return [];
}

function fmtPace(mps) {
  if (!mps || mps <= 0) return null;
  const total = Math.round(1000 / mps);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} min/km`;
}

function fmtDuration(secs) {
  if (!secs) return "0min";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}min` : `${m}min`;
}

const fmt1 = (v) => (v != null && !isNaN(v)) ? Number(v).toFixed(1) : "N/A";
const fmt0 = (v) => (v != null && !isNaN(v)) ? Math.round(Number(v)).toString() : "N/A";

// Sueño en formato Xh XXmin (nunca decimales)
function fmtSleep(secs) {
  if (!secs) return "N/A";
  let h = Math.floor(secs / 3600);
  let m = Math.round((secs % 3600) / 60);
  if (m === 60) { h++; m = 0; }
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

// Segundos → m:ss
function fmtSecs(secs) {
  if (secs == null || isNaN(secs)) return "N/A";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.round(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s === 60 ? 59 : s).padStart(2, "0")}`;
  return `${m}:${String(s === 60 ? 59 : s).padStart(2, "0")}`;
}

// "4:06" → 4.065 m/s
function paceStrToMps(str) {
  const m = String(str).trim().match(/^(\d+):(\d{1,2})$/);
  if (!m) return null;
  const secs = parseInt(m[1]) * 60 + parseInt(m[2]);
  return secs > 0 ? 1000 / secs : null;
}

const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const stdev = (arr) => {
  if (arr.length < 2) return null;
  const mu = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - mu) ** 2, 0) / (arr.length - 1));
};
const firstDefined = (...vals) => vals.find(v => v != null && v !== "" && !(typeof v === "number" && isNaN(v)));
const cleanId = (id) => String(id).replace(/^i/, "");

// ─── Zonas de FC dinámicas (leídas de intervals, no fijas en el código) ──────
const DEFAULT_HR_UPPER = [133, 148, 163, 178, 193];
// Elige la configuración de CORRER: prioridad al tipo exacto "Run", después cualquier tipo "*Run".
// Nunca "Otro" (Walk/Hike…), que tiene zonas por defecto distintas.
function pickRunConfig(configs) {
  const score = (c) => {
    const t = (c.types || []).map(x => String(x).toLowerCase());
    if (t.includes("run")) return 3;
    if (t.some(x => x.endsWith("run"))) return 2;
    return 0;
  };
  const best = [...configs].sort((a, b) => score(b) - score(a))[0];
  return best && score(best) > 0 ? best : null;
}
let zoneCache = { at: 0, upper: null, cfg: null };

async function getRunConfig(force = false) {
  if (!force && zoneCache.cfg && Date.now() - zoneCache.at < 10 * 60 * 1000) return zoneCache.cfg;
  const data = await callIntervals(`/athlete/${ATHLETE_ID}/sport-settings`);
  const configs = Array.isArray(data) ? data : [data];
  const cfg = pickRunConfig(configs);
  zoneCache = { at: Date.now(), cfg, upper: null };
  return cfg;
}

async function getHrZoneUpper() {
  try {
    const cfg = await getRunConfig();
    if (zoneCache.upper) return zoneCache.upper;
    let upper = null;
    if (Array.isArray(cfg?.hr_zones) && cfg.hr_zones.length >= 3) {
      upper = cfg.hr_zones.map(Number);
    } else if (cfg?.lthr) {
      const l = cfg.lthr, max = cfg.max_hr || DEFAULT_HR_UPPER[4];
      upper = [Math.floor(l * 0.76), Math.floor(l * 0.85), Math.floor(l * 0.93), Math.floor(l * 1.02), max];
    }
    zoneCache.upper = upper && upper.every(n => n > 0) ? upper : DEFAULT_HR_UPPER;
    return zoneCache.upper;
  } catch (_) {
    return DEFAULT_HR_UPPER;
  }
}

// Nombres: 7 zonas → Z1-Z4, Z5a, Z5b, Z5c (modelo intervals) · otro nº → Z1…ZN
const zoneNames = (n) => n === 7 ? ["Z1","Z2","Z3","Z4","Z5a","Z5b","Z5c"] : Array.from({ length: n }, (_, i) => `Z${i + 1}`);
const zoneLabels = (u) => zoneNames(u.length).map((name, i) =>
  i === 0 ? `${name} (≤${u[0]})` : i === u.length - 1 ? `${name} (>${u[i - 1]})` : `${name} (${u[i - 1] + 1}-${u[i]})`);
const zoneOf = (hr, u) => { const i = u.findIndex(x => hr <= x); return i === -1 ? u.length - 1 : i; };

// ─── Desacoplamiento aeróbico (Pa:HR) ─────────────────────────────────────────
// Divide el tramo en dos mitades de igual tiempo y compara la eficiencia (velocidad/FC).
// <5% = base aeróbica sólida para ese ritmo · 5-8% = aceptable · >8% = deriva alta
function computeDecoupling(st, fromM = null, toM = null) {
  const { time, hr, vel, dist } = st;
  if (!hr.length || !vel.length) return null;
  const idx = [];
  for (let i = 0; i < hr.length; i++) {
    const d = dist.length ? dist[i] : null;
    if (fromM != null && d != null && d < fromM) continue;
    if (toM != null && d != null && d > toM) continue;
    if (hr[i] > 60 && vel[i] > 1.5) idx.push(i); // descarta paradas y lecturas erróneas
  }
  if (idx.length < 600) return null; // mínimo ~10 min de datos
  const tOf = (i) => time.length ? time[i] : i;
  const tMid = (tOf(idx[0]) + tOf(idx[idx.length - 1])) / 2;
  const h1 = idx.filter(i => tOf(i) <= tMid), h2 = idx.filter(i => tOf(i) > tMid);
  const half = (ids) => {
    const v = mean(ids.map(i => vel[i])), h = mean(ids.map(i => hr[i]));
    return { v, h, ef: v / h };
  };
  const a = half(h1), b = half(h2);
  const decoupling = (a.ef - b.ef) / a.ef * 100;
  return {
    decoupling,
    first:  { pace: fmtPace(a.v), hr: Math.round(a.h) },
    second: { pace: fmtPace(b.v), hr: Math.round(b.h) },
    rating: decoupling < 5 ? "🟢 <5% — acoplado, base aeróbica sólida a este ritmo"
          : decoupling < 8 ? "🟡 5-8% — deriva moderada"
          : "🔴 >8% — deriva alta (fatiga, calor, deshidratación o ritmo por encima de su nivel aeróbico)",
    km: dist.length ? `${((dist[idx[0]]||0)/1000).toFixed(1)}–${((dist[idx[idx.length-1]]||0)/1000).toFixed(1)} km` : null,
  };
}

// ─── Velocidad ajustada por pendiente (GAP aproximado) ───────────────────────
// Pendiente sobre ~30 s; subida: +3.3 % de coste por 1 % de pendiente; bajada: −1.8 % por 1 % (acotado).
function gapVelocity(vel, dist, alt) {
  const n = vel.length, out = new Array(n);
  for (let k = 0; k < n; k++) {
    let f = 1;
    if (alt.length && dist.length && k >= 30) {
      const dd = (dist[k] || 0) - (dist[k - 30] || 0);
      if (dd > 30) {
        const g = Math.max(-15, Math.min(15, ((alt[k] || 0) - (alt[k - 30] || 0)) / dd * 100));
        f = g >= 0 ? 1 + 0.033 * g : 1 + 0.018 * g;
      }
    }
    out[k] = (vel[k] || 0) * f;
  }
  return out;
}

// ─── Mejor esfuerzo en una distancia (dos punteros sobre distancia/tiempo) ───
// Limpia saltos de GPS: incrementos negativos o > 8 m/s se descartan (conservador)
function cleanDistance(time, dist) {
  const out = new Array(dist.length);
  out[0] = dist[0] || 0;
  for (let i = 1; i < dist.length; i++) {
    const dt  = Math.max(1, (time[i] ?? i) - (time[i - 1] ?? i - 1));
    const inc = (dist[i] || 0) - (dist[i - 1] || 0);
    out[i] = out[i - 1] + (inc > 0 && inc <= 8 * dt ? inc : 0);
  }
  return out;
}

function bestEffort(time, rawDist, targetM) {
  const dist = cleanDistance(time, rawDist);
  if (!time.length || !dist.length || dist[dist.length - 1] < targetM) return null;
  let best = Infinity, j = 0;
  for (let i = 0; i < dist.length; i++) {
    while (j < dist.length && dist[j] - dist[i] < targetM) j++;
    if (j >= dist.length) break;
    const dt = time[j] - time[i];
    if (dt > 0 && dt < best) best = dt;
  }
  return best === Infinity ? null : best;
}

// ─── MCP Server factory ───────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// v7 — CACHÉ, ANÁLISIS DE ENTRENOS, TRAMOS A RITMO MARATÓN Y SEMÁFORO
// ═══════════════════════════════════════════════════════════════════════════
const RACE_DATE = process.env.RACE_DATE || "2026-12-06";
const HOUR = 3600 * 1000;

// ─── Caché LRU en memoria ─────────────────────────────────────────────────────
// Streams e intervalos de una actividad terminada no cambian → se piden una sola vez.
// Se guarda la promesa: dos herramientas que piden lo mismo a la vez comparten la petición.
class LRU {
  constructor(max) { this.max = max; this.m = new Map(); this.hits = 0; this.miss = 0; }
  get(k) {
    const e = this.m.get(k);
    if (!e) { this.miss++; return undefined; }
    if (Date.now() > e.exp) { this.m.delete(k); this.miss++; return undefined; }
    this.m.delete(k); this.m.set(k, e); this.hits++;
    return e.v;
  }
  set(k, v, ttl) {
    this.m.delete(k); this.m.set(k, { v, exp: Date.now() + ttl });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
  del(pred) { for (const k of [...this.m.keys()]) if (pred(k)) this.m.delete(k); }
  get size() { return this.m.size; }
}
const streamCache = new LRU(Number(process.env.STREAM_CACHE_MAX) || 50); // pesados
const dataCache   = new LRU(1000);                                        // ligeros

async function cached(store, key, ttl, fn) {
  const hit = store.get(key);
  if (hit !== undefined) return hit;
  const p = Promise.resolve().then(fn);
  store.set(key, p, ttl);
  try { return await p; }
  catch (e) { store.del(k => k === key); throw e; }
}

// GET sobre /activity/{id}{suffix}: prueba el ID tal cual y, ante 404, sin la "i"
async function activityGet(activity_id, suffix = "") {
  try { return await callIntervals(`/activity/${activity_id}${suffix}`); }
  catch (e) {
    if (String(activity_id) === cleanId(activity_id) || !/ 404/.test(e.message)) throw e;
    return await callIntervals(`/activity/${cleanId(activity_id)}${suffix}`);
  }
}

// ─── Actividad completa (cualquier fecha) ────────────────────────────────────
async function fetchActivity(activity_id) {
  return cached(dataCache, `act:${cleanId(activity_id)}`, 2 * 60 * 1000, () => activityGet(activity_id));
}

// Streams: siempre el conjunto completo, en caché 24 h (el parámetro types se ignora)
const STREAM_TYPES = "time,heartrate,velocity_smooth,distance,cadence,altitude,watts";
async function fetchStreams(activity_id, _types) {
  return cached(streamCache, `st:${cleanId(activity_id)}`, 24 * HOUR, async () => {
    const raw = await activityGet(activity_id, `/streams?${new URLSearchParams({ types: STREAM_TYPES })}`);
    const streams = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const byType = {};
    streams.forEach(s => { if (s.type) byType[s.type] = s.data || []; });
    return {
      time: byType.time || [],
      hr:   byType.heartrate || byType.heart_rate || [],
      vel:  byType.velocity_smooth || byType.speed || byType.velocity || [],
      dist: byType.distance || [],
      cad:  byType.cadence || [],
      alt:  byType.altitude || [],
      pwr:  byType.watts || byType.power || [],
      types: Object.keys(byType),
    };
  });
}

// Intervalos (pasos del entreno estructurado / vueltas). null si no hay (404). Caché 6 h.
async function fetchIntervals(activity_id) {
  return cached(dataCache, `iv:${cleanId(activity_id)}`, 6 * HOUR, async () => {
    try { return await activityGet(activity_id, "/intervals"); }
    catch (e) { if (/ 404/.test(e.message)) return null; throw e; }
  });
}

// Lista de actividades de un rango (caché 60 s: evita pedirla dos veces en la misma consulta)
async function listActivities(oldest, newest) {
  return cached(dataCache, `acts:${oldest}:${newest}`, 60 * 1000, async () =>
    toArray(await callIntervals(`/athlete/${ATHLETE_ID}/activities?${new URLSearchParams({ oldest, newest })}`), "activities")
      .sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local))));
}

function invalidateActivity(activity_id) {
  const id = cleanId(activity_id);
  dataCache.del(k => k === `act:${id}` || k.startsWith("acts:"));
}

// ─── Utilidades de ritmo ─────────────────────────────────────────────────────
const paceToSecs = (s) => { const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
const pS = (mps) => (mps > 0 ? fmtSecs(1000 / mps) : "-");            // m/s → "m:ss"
const kmBuckets = (m) => { const t = m || 0; const n = Math.ceil(t / 1000); return Math.max(1, t - (n - 1) * 1000 < 100 ? n - 1 : n); };
const actDate = (a) => (a.start_date_local || a.date || "").split("T")[0];
const isRun = (a) => /run/i.test(a.type || "");
const DOW = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const dayLabel = (ds) => `${DOW[dayOfWeek(ds)]} ${Number(ds.slice(8))}`;

// ─── Parser del formato de entreno de intervals.icu ──────────────────────────
// "- 2km 5:20-5:40 Pace intensity=warmup" · "8x" abre un bloque que termina en línea en blanco
function parseLenToken(tok) {
  let m;
  if ((m = tok.match(/^(\d+(?:[.,]\d+)?)km$/i))) return { meters: parseFloat(m[1].replace(",", ".")) * 1000 };
  if ((m = tok.match(/^(\d+)mtrs?$/i))) return { meters: +m[1] };
  if ((m = tok.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i)) && (m[1] || m[2] || m[3]))
    return { secs: (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) };
  return {};
}
function parseWorkoutText(text) {
  const out = []; let rep = null;
  const flush = () => {
    if (!rep) return;
    for (let i = 0; i < rep.n; i++) rep.steps.forEach(s => out.push({ ...s, rep: i + 1, reps: rep.n }));
    rep = null;
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const r = line.match(/^(\d+)\s*x$/i);
    if (r) { flush(); rep = { n: +r[1], steps: [] }; continue; }
    if (!line.startsWith("-")) continue;
    const body = line.slice(1).trim();
    const st = { ...parseLenToken(body.split(/\s+/)[0]) };
    const im = body.match(/intensity=(\w+)/i);
    st.intensity = (im ? im[1] : "active").toLowerCase();
    const pr = body.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*Pace/i);
    const p1 = body.match(/(\d{1,2}:\d{2})\s*Pace/i);
    if (pr) { const a = paceToSecs(pr[1]), b = paceToSecs(pr[2]); st.fast = Math.min(a, b); st.slow = Math.max(a, b); }
    else if (p1) { const a = paceToSecs(p1[1]); st.fast = a - 3; st.slow = a + 3; }
    (rep ? rep.steps : out).push(st);
  }
  flush();
  return out;
}
const isRestStep = (s) => /recovery|rest|warmup|cooldown/.test(s.intensity);
const ivSecs = (iv) => iv.moving_time || iv.elapsed_time || 0;
// Intervalos útiles: con distancia y ≥10 s (Garmin mete fragmentos de 1 s al pulsar vuelta)
const usefulIntervals = (arr) => (arr || []).filter(iv => (iv.distance || 0) > 0 && ivSecs(iv) >= 10)
  .sort((x, y) => (x.start_index ?? 0) - (y.start_index ?? 0));
const plannedKm = (e) => {
  if (e.distance > 0) return e.distance / 1000;
  const st = parseWorkoutText(e.description);
  return st.length && st.every(s => s.meters) ? st.reduce((a, s) => a + s.meters, 0) / 1000 : null;
};

// ─── Cumplimiento repetición a repetición ────────────────────────────────────
// Empareja los intervalos registrados con los pasos del entreno planificado.
function repCompliance(ivsRaw, steps) {
  const ivs = usefulIntervals(ivsRaw);
  const targets = steps.filter(s => !isRestStep(s) && s.fast != null);
  if (!ivs.length || !targets.length) return null;
  const work = ivs.filter(iv => String(iv.type || "").toUpperCase() === "WORK");
  let pairs = [], mode;
  // a) Alineación secuencial: cada paso con el siguiente intervalo de duración/distancia parecida
  //    (tolera vueltas extra al final o en medio)
  const fits = (iv, st) => st.secs ? Math.abs(ivSecs(iv) - st.secs) <= Math.max(10, st.secs * 0.15)
                         : st.meters ? Math.abs(iv.distance - st.meters) <= Math.max(100, st.meters * 0.1) : false;
  let j = 0; const seq = [];
  for (const st of steps) {
    let k = j;
    while (k < ivs.length && k <= j + 2 && !fits(ivs[k], st)) k++;
    if (k < ivs.length && k <= j + 2) { seq.push({ iv: ivs[k], st }); j = k + 1; } else break;
  }
  if (seq.length === steps.length) {
    pairs = seq.filter(p => !isRestStep(p.st) && p.st.fast != null); mode = "exacto";
  } else if (work.length === targets.length) {
    pairs = work.map((iv, i) => ({ iv, st: targets[i] })); mode = "por bloques de trabajo";
  } else {
    // c) Aproximado: cada intervalo de trabajo con el objetivo más cercano (±25 s/km)
    const cand = (work.length ? work : ivs.filter(iv => ivSecs(iv) >= 60));
    const uniq = [...new Map(targets.map(t => [`${t.fast}-${t.slow}`, t])).values()];
    pairs = cand.map(iv => {
      const p = 1000 / (iv.average_speed || iv.distance / ivSecs(iv));
      const st = uniq.map(t => ({ t, d: p < t.fast ? t.fast - p : p > t.slow ? p - t.slow : 0 })).sort((a, b) => a.d - b.d)[0];
      return st && st.d <= 25 ? { iv, st: st.t } : null;
    }).filter(Boolean);
    mode = "aproximado";
  }
  if (!pairs.length) return null;
  const rows = pairs.map(({ iv, st }, i) => {
    const secs = iv.moving_time || iv.elapsed_time;
    const pace = 1000 / (iv.average_speed || iv.distance / secs);
    const status = pace < st.fast - 2 ? `⚡${Math.round(st.fast - pace)}s` : pace > st.slow + 2 ? `🐢${Math.round(pace - st.slow)}s` : "✅";
    return { n: i + 1, km: iv.distance / 1000, secs, pace, st, hr: iv.average_heartrate, max: iv.max_heartrate, status };
  });
  const ok = rows.filter(r => r.status === "✅").length;
  const fast = rows.filter(r => r.status.startsWith("⚡")).length, slow = rows.filter(r => r.status.startsWith("🐢")).length;
  const hrs = rows.filter(r => r.hr > 0);
  return {
    mode, rows, ok, fast, slow,
    meanPace: mean(rows.map(r => r.pace)),
    hrFirst: hrs.length ? hrs[0].hr : null, hrLast: hrs.length ? hrs[hrs.length - 1].hr : null,
    maxHr: Math.max(0, ...rows.map(r => r.max || 0)) || null,
  };
}
function complianceSummary(c) {
  return `${c.ok}/${c.rows.length} en rango${c.fast ? ` · ${c.fast} rápidas` : ""}${c.slow ? ` · ${c.slow} lentas` : ""} · media ${fmtSecs(c.meanPace)}` +
    `${c.hrFirst ? ` · FC 1ª→última ${Math.round(c.hrFirst)}→${Math.round(c.hrLast)}` : ""}${c.maxHr ? ` · máx ${Math.round(c.maxHr)}` : ""}`;
}

// Entreno planificado emparejado con una actividad (paired_event_id o mismo día y tipo)
function pairedEvent(a, events) {
  const byId = a.paired_event_id != null ? events.find(e => String(e.id) === String(a.paired_event_id)) : null;
  if (byId) return byId;
  const day = actDate(a);
  const same = events.filter(e => (e.start_date_local || "").startsWith(day) && (!e.category || e.category === "WORKOUT" || String(e.category).startsWith("RACE"))
    && (isRun(a) ? /run/i.test(e.type || "Run") : !/run/i.test(e.type || "Run")));
  if (same.length <= 1) return same[0] || null;
  const km = (a.distance || 0) / 1000;
  return same.sort((x, y) => Math.abs((plannedKm(x) || 0) - km) - Math.abs((plannedKm(y) || 0) - km))[0];
}

// ─── Tramos a ritmo maratón (compartido por get_mp_trend, informe post-entreno y revisión) ──
function mpBand(target = "4:16", fast = "4:05", slow = "4:25", minKm = 2) {
  const vT = paceStrToMps(target), vF = paceStrToMps(fast), vS = paceStrToMps(slow);
  if (!vT || !vF || !vS || vF <= vS) return null;
  // Tolerancia de 4 s/km en los bordes de la banda
  const vHi = 1000 / (1000 / vF - 4), vLo = 1000 / (1000 / vS + 4);
  return { vT, vHi, vLo, minKm, target, key: `${target}|${fast}|${slow}|${minKm}` };
}

// Métricas de un tramo [start..last] (GAP, FC sin retardo, desnivel, desacoplamiento)
function segMetrics(st, gv, start, last) {
  const { hr, dist, alt } = st;
  const tOf = (x) => st.time.length ? st.time[x] : x;
  const segM = (dist[last] || 0) - (dist[start] || 0);
  const secs = tOf(last) - tOf(start);
  if (segM <= 0 || secs <= 0) return null;
  const hrFrom = secs > 300 ? start + Math.min(90, Math.floor((last - start) / 4)) : start;
  const hrVals = []; for (let x = hrFrom; x <= last; x++) if (hr[x] > 60) hrVals.push(hr[x]);
  const gVals = []; for (let x = start; x <= last; x++) gVals.push(gv[x]);
  let up = 0;
  if (alt.length) { for (let x = start + 10; x <= last; x += 10) { const dz = (alt[x] || 0) - (alt[x - 10] || 0); if (dz > 0) up += dz; } }
  const dec = secs >= 1200 ? computeDecoupling({ ...st, vel: gv }, dist[start], dist[last]) : null;
  return { startKm: (dist[start] || 0) / 1000, endKm: (dist[last] || 0) / 1000, km: segM / 1000, v: segM / secs,
           vg: mean(gVals) || segM / secs, hr: hrVals.length >= 60 ? mean(hrVals) : null, up, dec: dec ? dec.decoupling : null };
}

async function computeMpSegments(a, band) {
  const segs = [];
  const push = (m, src) => {
    if (!m || !m.hr) return;
    segs.push({ date: actDate(a), name: a.name || "", src, startKm: m.startKm, endKm: m.endKm ?? m.startKm + m.km, km: m.km,
                pace: 1000 / m.v, gap: 1000 / m.vg, hr: m.hr, hrNorm: m.hr * (band.vT / m.vg), dec: m.dec, up: m.up });
  };
  const inBand = (sp) => sp >= band.vLo && sp <= band.vHi;

  // 1) Intervalos de intervals (pasos del entreno estructurado o vueltas)
  let ivs = [], ivErr = null;
  try { ivs = usefulIntervals((await fetchIntervals(a.id))?.icu_intervals); }
  catch (e) { ivErr = e; }
  const groups = []; let cur = null, before = 0; const startDist = [];
  ivs.forEach(iv => {
    startDist.push(before); before += iv.distance || 0;
    const sp = iv.average_speed || (iv.distance / (iv.moving_time || iv.elapsed_time));
    if (inBand(sp)) (cur = cur || []).push(iv); else { if (cur) groups.push(cur); cur = null; }
  });
  if (cur) groups.push(cur);
  const cands = groups.map(g => {
    const dist = g.reduce((s, iv) => s + (iv.distance || 0), 0);
    const secs = g.reduce((s, iv) => s + (iv.moving_time || iv.elapsed_time || 0), 0);
    const hrW  = g.reduce((s, iv) => s + (iv.average_heartrate || 0) * (iv.moving_time || iv.elapsed_time || 0), 0);
    return { dist, secs, hr: secs ? hrW / secs : null, startIdx: g[0].start_index, endIdx: g[g.length - 1].end_index, startKm: startDist[ivs.indexOf(g[0])] / 1000 };
  }).filter(c => c.dist >= band.minKm * 1000);

  let st = null, gv = null;
  const load = async () => {
    if (st) return st;
    try { st = await fetchStreams(a.id); gv = gapVelocity(st.vel, st.dist, st.alt); } catch (_) { st = null; }
    return st;
  };

  if (cands.length) {
    await load();
    for (const c of cands) {
      const n = st ? Math.min(st.vel.length, st.dist.length, st.hr.length || Infinity) : 0;
      // El último intervalo suele acabar en el último punto (o uno más): se acota al stream
      const end = c.endIdx != null && c.endIdx >= n && c.endIdx - n < 60 ? n - 1 : c.endIdx;
      const ok = st && c.startIdx != null && end != null && end < n && end > c.startIdx;
      const m = ok ? segMetrics(st, gv, c.startIdx, end) : null;
      if (m) push({ ...m, km: c.dist / 1000, v: c.dist / c.secs, hr: m.hr ?? c.hr }, "int");
      else push({ startKm: c.startKm, km: c.dist / 1000, v: c.dist / c.secs, vg: c.dist / c.secs, hr: c.hr, up: 0, dec: null }, "int");
    }
    return { segs, failed: ivErr ? "gps" : null };
  }

  // 2) Respaldo: detección sobre los streams (carreras sin vueltas útiles)
  if (!await load()) return { segs, failed: "full" };
  const n = Math.min(st.vel.length, st.dist.length);
  if (n >= 300 && st.hr.length) {
    const rv = new Array(n); let acc = 0;
    for (let k = 0; k < n; k++) { acc += gv[k] || 0; if (k >= 60) acc -= gv[k - 60] || 0; rv[k] = acc / Math.min(k + 1, 60); }
    let k = 0;
    while (k < n) {
      if (!inBand(rv[k])) { k++; continue; }
      let start = k, last = k, gap = 0; k++;
      while (k < n) { if (inBand(rv[k])) { last = k; gap = 0; } else if (++gap > 45) break; k++; }
      if ((st.dist[last] || 0) - (st.dist[start] || 0) < band.minKm * 1000) continue;
      push(segMetrics(st, gv, start, last), "gps");
    }
  }
  return { segs, failed: ivErr ? "gps" : null };
}

// Con caché de 7 días por actividad: el domingo siguiente solo se procesan las carreras nuevas
async function mpSegmentsFor(a, band) {
  const key = `mp:${cleanId(a.id)}:${band.key}`;
  const hit = dataCache.get(key);
  if (hit !== undefined) return hit;
  const res = await computeMpSegments(a, band);
  if (!res.failed) dataCache.set(key, res, 7 * 24 * HOUR);
  return res;
}

async function computeMpTrend({ target_pace = "4:16", pace_fast = "4:05", pace_slow = "4:25", days = 90, min_km = 2, include_treadmill = false } = {}) {
  const band = mpBand(target_pace, pace_fast, pace_slow, min_km);
  if (!band) return { error: "❌ Ritmos no válidos (formato m:ss, pace_fast más rápido que pace_slow)." };
  const nDays = Math.min(days, 180);
  const acts = (await listActivities(daysAgo(nDays), today()))
    .filter(a => (a.type === "Run" || (include_treadmill && a.type === "VirtualRun")) && (a.distance || 0) >= min_km * 1000 && !(a.trainer && !include_treadmill))
    .filter(a => { const sp = a.average_speed || 0; return sp === 0 || sp > band.vLo * 0.75; });
  const segs = [], failed = [];
  for (let i = 0; i < acts.length; i += 3) {
    const res = await Promise.all(acts.slice(i, i + 3).map(a => mpSegmentsFor(a, band).then(r => ({ a, r }))));
    res.forEach(({ a, r }) => {
      segs.push(...r.segs);
      if (r.failed === "full") failed.push(actDate(a)); else if (r.failed === "gps") failed.push(`${actDate(a)} (solo GPS)`);
    });
  }
  segs.sort((x, y) => x.date.localeCompare(y.date) || x.startKm - y.startKm);
  return { segs, failed, nDays, target_pace, pace_fast, pace_slow, min_km };
}

function mpTrendLines(r, { table = true } = {}) {
  const { segs, failed, nDays, target_pace, pace_fast, pace_slow, min_km } = r;
  const failNote = failed.length ? `⚠️ ${failed.length} actividad(es) no se pudieron leer completas: ${failed.join(", ")}. Repetir en unos minutos.` : null;
  if (!segs.length) return [`No hay tramos de ≥${min_km} km entre ${pace_fast} y ${pace_slow}/km en los últimos ${nDays} días.`, failNote].filter(Boolean);
  const L = [];
  if (table) {
    L.push(`🎯 COSTE CARDÍACO DEL RITMO MARATÓN — banda ${pace_fast}-${pace_slow}/km · normalizado a ${target_pace}`,
           `   ${segs.length} tramos en ${new Set(segs.map(s => s.date)).size} sesiones (últimos ${nDays} días)`, ``,
           `fecha      | inicio | tramo  | ritmo | GAP  | FC  | FC@${target_pace} | desac | desn+`);
    segs.slice(-25).forEach(s => {
      L.push(`${s.date}${s.src === "gps" ? "*" : " "}| ${s.startKm >= 15 ? "🔋" : "  "}${s.startKm.toFixed(1).padStart(4)} | ${s.km.toFixed(1).padStart(4)}km | ${fmtSecs(s.pace)} | ${fmtSecs(s.gap)} | ${Math.round(s.hr)} | ${Math.round(s.hrNorm).toString().padStart(3)}     | ${s.dec != null ? fmt1(s.dec).padStart(4) + "%" : "   - "} | ${Math.round(s.up)}m`);
    });
    L.push(`   🔋 = tramo iniciado a partir del km 15 · * = detectado por GPS (sin vueltas), menos preciso`);
  }
  // Tendencia: regresión ponderada por km de la FC normalizada frente al tiempo
  const t0 = new Date(`${segs[0].date}T12:00:00Z`).getTime();
  const xs = segs.map(s => (new Date(`${s.date}T12:00:00Z`).getTime() - t0) / 86400000);
  const ws = segs.map(s => s.km), ys = segs.map(s => s.hrNorm);
  const W = ws.reduce((a, b) => a + b, 0);
  const mx = xs.reduce((a, x, i) => a + x * ws[i], 0) / W, my = ys.reduce((a, y, i) => a + y * ws[i], 0) / W;
  const sxx = xs.reduce((a, x, i) => a + ws[i] * (x - mx) ** 2, 0);
  const slope = sxx > 0 ? xs.reduce((a, x, i) => a + ws[i] * (x - mx) * (ys[i] - my), 0) / sxx : 0;
  const wavg = (arr) => { const w = arr.reduce((a, s) => a + s.km, 0); return w ? arr.reduce((a, s) => a + s.hrNorm * s.km, 0) / w : null; };
  const cut = daysAgo(28);
  const recent = segs.filter(s => s.date >= cut), older = segs.filter(s => s.date < cut);
  const fresh = recent.filter(s => s.startKm < 15), tired = recent.filter(s => s.startKm >= 15);
  const decs = recent.filter(s => s.dec != null).map(s => s.dec);
  const nSessions = new Set(segs.map(s => s.date)).size;
  const span = xs[xs.length - 1] - xs[0];
  L.push(table ? `` : null, `📉 TENDENCIA RITMO MARATÓN${table ? "" : ` (${segs.length} tramos, ${nDays} días)`}`);
  if (nSessions >= 3 && span >= 21) L.push(`   FC a ${target_pace}: ${slope <= 0 ? "▼" : "▲"} ${Math.abs(slope * 28).toFixed(1)} bpm cada 4 semanas ${slope < -0.5 / 28 ? "🟢 (mejorando)" : slope > 0.5 / 28 ? "🔴 (empeorando)" : "🟡 (estable)"}`);
  else L.push(`   ⚠️ Datos insuficientes para una tendencia fiable (${nSessions} sesiones en ${Math.round(span)} días)`);
  if (older.length && recent.length) L.push(`   Últimas 4 semanas: ${Math.round(wavg(recent))} bpm · antes: ${Math.round(wavg(older))} bpm`);
  if (fresh.length && tired.length) L.push(`   Fresco: ${Math.round(wavg(fresh))} bpm · con fatiga (km 15+): ${Math.round(wavg(tired))} bpm (${wavg(tired) >= wavg(fresh) ? "+" : ""}${Math.round(wavg(tired) - wavg(fresh))})`);
  if (decs.length) L.push(`   Desacoplamiento medio (tramos ≥20 min, 4 semanas): ${fmt1(mean(decs))}%`);
  L.push(`   Km a ritmo maratón en 4 semanas: ${recent.reduce((a, s) => a + s.km, 0).toFixed(1)} km · tramo más largo: ${Math.max(...recent.map(s => s.km), 0).toFixed(1)} km`);
  if (table) L.push(``, `ℹ️ FC@objetivo = FC × velocidad objetivo / velocidad GAP. Contrastar siempre con calor y sueño del día.`);
  if (failNote) L.push(failNote);
  return L.filter(x => x != null);
}

// ─── Semáforo diario de disposición ──────────────────────────────────────────
function classifySession(e) {
  if (!e) return "rest";
  const name = e.name || "";
  if (String(e.category || "").toUpperCase().startsWith("RACE")) return "race";
  if (/(media marat[oó]n|\b10 ?k\b|carrera|\brace\b)/i.test(name) && !/tirada|rodaje|ritmo marat/i.test(name)) return "race";
  if (/^\W*(media )?marat[oó]n\b/i.test(name)) return "race";
  if (/weight|strength/i.test(e.type || "") || /fuerza|gym|gimnasio/i.test(name)) return "strength";
  if (!/run/i.test(e.type || "Run")) return "other";
  if (/tirada|larga|long/i.test(name) || (e.distance || 0) >= 20000 || (e.moving_time || 0) >= 6000) return "long";
  if (/fartlek|series|tempo|umbral|interval|cuestas|test|vo2|progresi/i.test(name)) return "quality";
  if (parseWorkoutText(e.description).some(s => !isRestStep(s) && s.fast != null && s.fast < 270)) return "quality";
  return "easy";
}
const SESSION_RANK = { race: 6, long: 5, quality: 4, easy: 3, strength: 2, other: 1, rest: 0 };
const SESSION_NAME = { race: "carrera", long: "tirada larga", quality: "calidad", easy: "rodaje", strength: "fuerza", other: "otra", rest: "descanso" };
const READINESS_ACTIONS = {
  race:     { green: "Competir según el plan",                          amber: "Salir en el rango lento del objetivo y decidir a mitad de carrera", red: "Rebajar a ritmo maratón o no competir — decide el entrenador" },
  long:     { green: "Tirada según el plan",                            amber: "Tirada completa en Z2 y bloque a ritmo maratón recortado ~20%",   red: "Posponer la tirada 24-48 h; hoy rodaje corto en Z1 o descanso" },
  quality:  { green: "Mantener la sesión tal cual",                     amber: "Calidad en el borde lento del rango y ~20% menos de trabajo; si el calentamiento va pesado, rodaje Z2", red: "Cambiar la calidad por rodaje Z1-Z2 de 40-50 min o descanso; mover la calidad 24-48 h" },
  easy:     { green: "Rodaje según el plan (Z1-Z2)",                    amber: "Rodaje en Z1-Z2 bajo, recortando ~20%",                            red: "Recortar a 30-40 min en Z1 o descansar" },
  strength: { green: "Fuerza según el plan",                            amber: "Fuerza con cargas −20% y sin llegar al fallo",                     red: "Solo movilidad y fortalecimiento de pie" },
  other:    { green: "Sesión según el plan",                            amber: "Sesión suave y más corta",                                         red: "Descanso" },
  rest:     { green: "Descanso previsto",                               amber: "Descanso: prioridad dormir ≥7h 30min",                             red: "Descanso total: prioridad dormir ≥7h 30min" },
};
const LEVEL = { green: "🟢 VERDE", amber: "🟠 ÁMBAR", red: "🔴 ROJO" };

function assessReadiness({ d, wl, sessionType, yRpe }) {
  const w = wl.find(x => x.id === d) || {};
  const prev = wl.filter(x => x.id < d);
  const reasons = []; let score = 0;
  const weekend = [0, 6].includes(dayOfWeek(d));
  const hrvH = prev.map(x => x.hrv).filter(v => v > 0);
  const mu = mean(hrvH), sd = stdev(hrvH);
  if (!w.hrv) reasons.push("sin HRV de hoy (semáforo con datos parciales)");
  else if (mu != null && sd) {
    if (w.hrv < mu - 2 * sd) { score += 2; reasons.push(`HRV ${w.hrv} muy por debajo de su rango (${Math.round(mu - sd)}-${Math.round(mu + sd)})`); }
    else if (w.hrv < mu - sd) { score += weekend ? 0.5 : 1; reasons.push(`HRV ${w.hrv} bajo su rango (${Math.round(mu - sd)}-${Math.round(mu + sd)})${weekend ? " · fin de semana, patrón habitual" : ""}`); }
    const last7 = wl.filter(x => x.id <= d && x.id > addDays(d, -7)).map(x => x.hrv).filter(v => v > 0);
    const older = prev.filter(x => x.id <= addDays(d, -7)).map(x => x.hrv).filter(v => v > 0);
    if (last7.length >= 4 && older.length >= 7) {
      const m7 = mean(last7), mo = mean(older), so = stdev(older) || sd;
      if (m7 < mo - 0.5 * so) { score += 1; reasons.push(`HRV media 7 días ${Math.round(m7)} vs ${Math.round(mo)} antes — tendencia a la baja`); }
    }
  }
  const rmu = mean(prev.map(x => x.restingHR).filter(v => v > 0));
  if (w.restingHR && rmu) {
    const dv = w.restingHR - rmu;
    if (dv >= 8) { score += 2; reasons.push(`FC reposo ${w.restingHR} (+${Math.round(dv)} sobre su media)`); }
    else if (dv >= 5) { score += 1; reasons.push(`FC reposo ${w.restingHR} (+${Math.round(dv)} sobre su media)`); }
  }
  if (w.sleepSecs) {
    const s = w.sleepSecs;
    const p = s < 21600 ? 1.5 : s < 24300 ? 1 : s < 27000 ? 0.5 : 0;
    if (p) { score += p; reasons.push(`sueño ${fmtSleep(s)}`); }
  }
  const last3 = wl.filter(x => x.id <= d && x.id > addDays(d, -3)).map(x => x.sleepSecs).filter(v => v > 0);
  if (last3.length >= 3 && mean(last3) < 24300) { score += 0.5; reasons.push(`media de sueño 3 noches ${fmtSleep(mean(last3))}`); }
  const le = [...wl].reverse().find(x => x.ctl != null && x.id <= d);
  const tsb = le && le.atl != null ? le.ctl - le.atl : null;
  if (tsb != null && tsb < -25) { score += 2; reasons.push(`TSB ${fmt1(tsb)}`); }
  else if (tsb != null && tsb < -18) { score += 1; reasons.push(`TSB ${fmt1(tsb)}`); }
  if (yRpe >= 9 && ["quality", "long", "race"].includes(sessionType)) { score += 0.5; reasons.push(`RPE ${yRpe}/10 ayer`); }
  const level = score >= 3 ? "red" : score >= 1.5 ? "amber" : "green";
  return { level, score, reasons, action: (READINESS_ACTIONS[sessionType] || READINESS_ACTIONS.other)[level] };
}


// ─── MCP Server factory ───────────────────────────────────────────────────────
function createServer() {
  const srv = new McpServer({ name: "intervals-mcp", version: "7.1.0" });

  srv.tool("get_daily_briefing",
    "ONE-CALL morning report with a readiness traffic light (green/amber/red + concrete action for today's planned session, from HRV vs range, 7-day HRV trend, resting HR, sleep, TSB and yesterday's RPE), plus today's HRV vs 30-day baseline (mean ± SD), resting HR, sleep (Xh XXmin), CTL/ATL/TSB, ramp rate, today's and tomorrow's planned workouts, last activity, week-to-date km, and automatic alerts. Use this instead of calling wellness+fitness+events+activities separately.",
    { date: z.string().optional().describe("Fecha YYYY-MM-DD (default: hoy, hora de Madrid)") },
    async ({ date }) => {
      try {
        const d = date || today();
        const wParams = new URLSearchParams({ oldest: addDays(d, -30), newest: d });
        const [wData, evData, actData] = await Promise.all([
          callIntervals(`/athlete/${ATHLETE_ID}/wellness?${wParams}`),
          callIntervals(`/athlete/${ATHLETE_ID}/events?${new URLSearchParams({ oldest: d, newest: addDays(d, 1) })}`),
          callIntervals(`/athlete/${ATHLETE_ID}/activities?${new URLSearchParams({ oldest: [addDays(d, -14), mondayOf(d)].sort()[0], newest: d })}`),
        ]);
        const wl   = toArray(wData, "wellness").sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const w    = wl.find(x => x.id === d) || {};
        const prev = wl.filter(x => x.id < d);
        const hrvHist = prev.map(x => x.hrv).filter(v => v > 0);
        const rhrHist = prev.map(x => x.restingHR).filter(v => v > 0);
        const hrvMu = mean(hrvHist), hrvSd = stdev(hrvHist);
        const rhrMu = mean(rhrHist);
        const lo = hrvMu != null && hrvSd != null ? hrvMu - hrvSd : null;
        const hi = hrvMu != null && hrvSd != null ? hrvMu + hrvSd : null;

        const loadEntry = [...wl].reverse().find(x => x.ctl != null) || {};
        const tsb = loadEntry.ctl != null && loadEntry.atl != null ? loadEntry.ctl - loadEntry.atl : null;

        const alerts = [];
        const events = toArray(evData, "events");
        const acts = toArray(actData, "activities").sort((a, b) => String(b.start_date_local).localeCompare(String(a.start_date_local)));
        const evToday = events.filter(e => (e.start_date_local || "").startsWith(d));
        const evTom   = events.filter(e => (e.start_date_local || "").startsWith(addDays(d, 1)));
        const main = evToday.filter(e => !e.category || e.category === "WORKOUT" || String(e.category).startsWith("RACE"))
          .map(e => ({ e, t: classifySession(e) })).sort((x, y) => SESSION_RANK[y.t] - SESSION_RANK[x.t])[0];
        const sessionType = main ? main.t : "rest";
        const yRpe = Math.max(0, ...acts.filter(a => actDate(a) === addDays(d, -1)).map(a => firstDefined(a.icu_rpe, a.perceived_exertion) || 0));
        const rd = assessReadiness({ d, wl, sessionType, yRpe });
        const L = [`☀️ INFORME — ${d}`, ``,
          `🚦 SEMÁFORO: ${LEVEL[rd.level]} (${rd.score.toFixed(1)} pts) — ${rd.action}`,
          `   Sesión: ${SESSION_NAME[sessionType]}${main ? ` (${main.e.name})` : ""}`,
          `   ${rd.reasons.length ? `Motivos: ${rd.reasons.join(" · ")}` : "Todo dentro de rango"}`,
          ``, `💓 RECUPERACIÓN`];
        if (w.hrv) {
          const status = lo == null ? "" : w.hrv < lo ? " 🔴 POR DEBAJO del baseline" : w.hrv > hi ? " 🟢 por encima del baseline" : " 🟢 dentro del baseline";
          L.push(`   HRV: ${w.hrv}${status}`);
          if (lo != null && w.hrv < lo) alerts.push(`HRV ${w.hrv} por debajo del límite inferior (${Math.round(lo)})`);
        } else L.push(`   HRV: sin dato todavía (¿reloj sincronizado?)`);
        if (hrvMu != null) L.push(`   Baseline 30d: ${Math.round(hrvMu)} ± ${Math.round(hrvSd || 0)} (intervalo ${Math.round(lo)}–${Math.round(hi)}, n=${hrvHist.length})`);
        if (w.restingHR) {
          L.push(`   FC reposo: ${w.restingHR} bpm${rhrMu ? ` (media 30d ${Math.round(rhrMu)})` : ""}`);
          if (rhrMu && w.restingHR >= rhrMu + 5) alerts.push(`FC reposo ${w.restingHR} bpm, +${Math.round(w.restingHR - rhrMu)} sobre su media`);
        }
        if (w.sleepSecs) {
          L.push(`   Sueño: ${fmtSleep(w.sleepSecs)}${w.sleepScore ? ` · score ${w.sleepScore}/100` : ""}`);
          if (w.sleepSecs < 27000) alerts.push(`Sueño ${fmtSleep(w.sleepSecs)} (< 7h 30min)`);
        }
        const nights = prev.slice(-6).concat(w.sleepSecs ? [w] : []).filter(x => x.sleepSecs);
        if (nights.length >= 3) {
          const ok = nights.filter(x => x.sleepSecs >= 27000).length;
          L.push(`   Noches ≥7h 30min (últimos 7 días): ${ok}/${nights.length}`);
        }
        ["fatigue","soreness","mood","motivation"].forEach(k => { if (w[k] != null) L.push(`   ${k}: ${w[k]}`); });
        const vo2Hist = wl.filter(x => x.vo2max > 0);
        if (vo2Hist.length) {
          const vNow = vo2Hist[vo2Hist.length - 1], vOld = vo2Hist[0];
          const diff = vNow.vo2max - vOld.vo2max;
          L.push(`   VO2max (Garmin): ${vNow.vo2max}${vNow.id !== d ? ` (dato del ${vNow.id})` : ""}${vo2Hist.length > 1 && vOld.id !== vNow.id ? ` · ${diff > 0 ? "+" : ""}${diff} desde ${vOld.id}` : ""}`);
        }

        L.push(``, `📊 CARGA`);
        if (loadEntry.ctl != null) {
          L.push(`   CTL ${fmt1(loadEntry.ctl)} · ATL ${fmt1(loadEntry.atl)} · TSB ${fmt1(tsb)} ${tsb > 5 ? "🟢" : tsb > -10 ? "🟡" : tsb > -25 ? "🟠" : "🔴"}`);
          if (loadEntry.rampRate != null) L.push(`   Ramp rate: ${Number(loadEntry.rampRate).toFixed(2)}/semana`);
          if (tsb != null && tsb < -25) alerts.push(`TSB ${fmt1(tsb)} (< -25)`);
          if (loadEntry.rampRate != null && loadEntry.rampRate > 7) alerts.push(`Ramp rate ${Number(loadEntry.rampRate).toFixed(1)} (> 7/semana)`);
        } else L.push(`   Sin datos de carga`);

        const evLine = (e) => `   • ${e.name || "Evento"} (${e.type || e.category || "?"})${e.moving_time ? ` · ${fmtDuration(e.moving_time)}` : ""}${e.distance ? ` · ${(e.distance/1000).toFixed(1)} km` : ""} [ID:${e.id}]${e.description ? `\n${e.description.split("\n").map(x => `     ${x}`).join("\n")}` : ""}`;
        L.push(``, `📅 HOY`);
        L.push(evToday.length ? evToday.map(evLine).join("\n") : `   Sin entrenamiento planificado`);
        L.push(`📅 MAÑANA`);
        L.push(evTom.length ? evTom.map(e => `   • ${e.name || "Evento"} (${e.type || e.category || "?"})`).join("\n") : `   Sin entrenamiento planificado`);

        const last = acts.find(a => (a.start_date_local || "") < `${d}T23:59:59`);
        if (last) {
          const dec = firstDefined(last.decoupling, last.icu_decoupling);
          const rpe = firstDefined(last.icu_rpe, last.perceived_exertion);
          const lastDate = (last.start_date_local||"").split("T")[0];
          const gap = Math.round((new Date(`${d}T12:00:00Z`) - new Date(`${lastDate}T12:00:00Z`)) / 86400000);
          L.push(``, `🏃 ÚLTIMA ACTIVIDAD — ${lastDate}${gap >= 3 ? ` (hace ${gap} días — ¿falta sincronizar?)` : ""} [ID:${last.id}]`);
          L.push(`   ${last.name || last.type}: ${last.distance ? (last.distance/1000).toFixed(2) + " km · " : ""}${fmtDuration(last.moving_time)}${last.average_speed ? " · " + fmtPace(last.average_speed) : ""}${last.average_heartrate ? " · " + fmt0(last.average_heartrate) + " bpm" : ""}`);
          const extra = [
            firstDefined(last.icu_training_load, last.tss) != null ? `carga ${fmt0(firstDefined(last.icu_training_load, last.tss))}` : null,
            dec != null ? `desacoplamiento ${fmt1(dec)}%` : null,
            rpe != null ? `RPE ${rpe}/10` : `⚠️ sin RPE registrado`,
          ].filter(Boolean);
          L.push(`   ${extra.join(" · ")}`);
        }

        const monday = mondayOf(d);
        const week = acts.filter(a => (a.start_date_local || "") >= monday && /run/i.test(a.type || ""));
        const weekKm = week.reduce((x, a) => x + (a.distance || 0), 0) / 1000;
        L.push(``, `📆 SEMANA (desde ${monday}): ${weekKm.toFixed(1)} km en ${week.length} sesiones de carrera`);

        L.push(``, alerts.length ? `🚨 ALERTAS\n${alerts.map(x => `   • ${x}`).join("\n")}` : `✅ Sin alertas`);
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_daily_briefing: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_post_workout_report",
    "ONE-CALL post-workout analysis (default: latest activity). Returns metrics, GAP, planned-vs-done, HR zones, rep-by-rep compliance against the planned workout's pace targets, marathon-pace block (auto-detected, or from_km/to_km) with HR@4:16 and decoupling, whole-run decoupling, compact km splits, RPE/feel/notes.",
    {
      activity_id: z.string().optional().describe("ID de la actividad (default: la última registrada)"),
      mp_from_km:  z.number().optional().describe("Inicio del bloque a ritmo maratón en km (si no, se detecta solo)"),
      mp_to_km:    z.number().optional().describe("Fin del bloque a ritmo maratón en km"),
      splits:      z.boolean().optional().describe("Incluir splits por km (default: true)"),
    },
    async ({ activity_id, mp_from_km, mp_to_km, splits = true }) => {
      try {
        let id = activity_id;
        if (!id) {
          const acts = await listActivities(daysAgo(10), today());
          if (!acts.length) return { content: [{ type: "text", text: "No hay actividades en los últimos 10 días." }] };
          id = String(acts[acts.length - 1].id);
        }
        const a = await fetchActivity(id);
        if (!a || !a.id) return { content: [{ type: "text", text: `⚠️ Actividad ${id} no encontrada.` }] };
        const day = actDate(a);
        const run = isRun(a);
        const [evData, st, ivRaw, u] = await Promise.all([
          callIntervals(`/athlete/${ATHLETE_ID}/events?${new URLSearchParams({ oldest: day, newest: day })}`).catch(() => []),
          run ? fetchStreams(a.id).catch(() => null) : null,
          fetchIntervals(a.id).catch(() => null),
          getHrZoneUpper(),
        ]);
        const sp = firstDefined(a.average_speed, a.averageSpeed);
        const gap = firstDefined(a.gap, a.icu_gap);
        const load = firstDefined(a.icu_training_load, a.tss);
        const rpe = firstDefined(a.icu_rpe, a.perceived_exertion);
        const temp = firstDefined(a.average_weather_temp, a.average_temp);
        const FEEL = { 1: "muy fuerte", 2: "fuerte", 3: "normal", 4: "flojo", 5: "muy flojo" };

        const L = [`🏃 ${dayLabel(day)} (${day}) — ${a.name || a.type} [ID:${a.id}]`];
        L.push(`   ${((a.distance || 0) / 1000).toFixed(2)} km · ${fmtDuration(a.moving_time)}${sp ? ` · ${pS(sp)}/km` : ""}${gap ? ` (GAP ${pS(gap)})` : ""}` +
          `${a.average_heartrate ? ` · FC ${fmt0(a.average_heartrate)}/${fmt0(a.max_heartrate)}` : ""}${a.average_cadence ? ` · cad ${fmt0(a.average_cadence)}` : ""}` +
          `${load != null ? ` · carga ${fmt0(load)}` : ""}${temp != null ? ` · ${fmt0(temp)}°C` : ""}`);

        // Plan vs hecho
        const ev = pairedEvent(a, toArray(evData, "events"));
        const steps = ev ? parseWorkoutText(ev.description) : [];
        if (ev) {
          const pk = plannedKm(ev);
          L.push(`📋 Plan: ${ev.name}${pk ? ` · ${pk.toFixed(1)} km → hecho ${((a.distance || 0) / 1000).toFixed(1)} km (${Math.round((a.distance || 0) / 10 / pk)}%)` : ""}`);
        } else L.push(`📋 Sin entrenamiento planificado emparejado`);

        // Zonas
        let zt = a.icu_hr_zone_times || a.icu_zone_times || [];
        if (!zt.length && st?.hr.length) { zt = new Array(u.length).fill(0); st.hr.forEach(h => { if (h > 0) zt[zoneOf(h, u)]++; }); }
        if (zt.length) {
          const tot = zt.slice(0, u.length).reduce((x, y) => x + (y || 0), 0) || 1;
          const zn = zoneNames(u.length);
          L.push(`❤️ Zonas: ${zt.slice(0, u.length).map((s, i) => [zn[i], Math.round((s || 0) / tot * 100)]).filter(([, p]) => p > 0).map(([n, p]) => `${n} ${p}%`).join(" · ")}`);
        }

        // Cumplimiento repetición a repetición
        let hasCompliance = false;
        if (steps.length && ivRaw?.icu_intervals?.length) {
          const c = repCompliance(ivRaw.icu_intervals, steps);
          if (c && new Set(c.rows.map(r => `${r.st.fast}-${r.st.slow}`)).size === 1 && c.rows.length === 1) { /* rodaje de un solo paso: sin tabla */ }
          else if (c) {
            hasCompliance = true;
            L.push(`🎯 Cumplimiento (${c.mode}): ${complianceSummary(c)}`);
            if (c.rows.length > 1) c.rows.slice(0, 30).forEach(r => L.push(`   ${String(r.n).padStart(2)} ${r.km.toFixed(2)}km ${fmtSecs(r.secs)} → ${fmtSecs(r.pace)} (obj ${fmtSecs(r.st.fast)}-${fmtSecs(r.st.slow)}) FC ${r.hr ? Math.round(r.hr) : "-"}/${r.max ? Math.round(r.max) : "-"} ${r.status}`));
          }
        }

        // Bloque a ritmo maratón + desacoplamiento global
        if (run && st && st.hr.length) {
          const gv = gapVelocity(st.vel, st.dist, st.alt);
          const band = mpBand();
          let seg = null;
          if (mp_from_km != null && mp_to_km != null) {
            const idx = []; st.dist.forEach((dd, i) => { if (dd >= mp_from_km * 1000 && dd <= mp_to_km * 1000) idx.push(i); });
            const m = idx.length > 60 ? segMetrics(st, gv, idx[0], idx[idx.length - 1]) : null;
            if (m && m.hr) {
              const dec = computeDecoupling(st, mp_from_km * 1000, mp_to_km * 1000);
              seg = { ...m, pace: 1000 / m.v, gap: 1000 / m.vg, hrNorm: m.hr * (band.vT / m.vg), dec: dec ? dec.decoupling : m.dec };
            }
          } else {
            const r = await mpSegmentsFor(a, band);
            seg = r.segs.sort((x, y) => y.km - x.km)[0] || null;
          }
          if (seg) {
            const dr = seg.dec == null ? "" : seg.dec < 5 ? " 🟢" : seg.dec < 8 ? " 🟡" : " 🔴";
            L.push(`🎯 Bloque MP: km ${seg.startKm.toFixed(1)}-${(seg.endKm ?? seg.startKm + seg.km).toFixed(1)} (${seg.km.toFixed(1)} km) · ${fmtSecs(seg.pace)} (GAP ${fmtSecs(seg.gap)}) · FC ${Math.round(seg.hr)} · FC@4:16 ${Math.round(seg.hrNorm)}` +
              `${seg.dec != null ? ` · desac ${fmt1(seg.dec)}%${dr}` : " · desac: tramo <20 min"}`);
          }
          const whole = !seg && !hasCompliance ? computeDecoupling(st) : null;
          if (whole) L.push(`🫀 Desacoplamiento global: ${fmt1(whole.decoupling)}% ${whole.decoupling < 5 ? "🟢" : whole.decoupling < 8 ? "🟡" : "🔴"} (1ª mitad ${whole.first.pace.replace(" min/km", "")} @ ${whole.first.hr} · 2ª ${whole.second.pace.replace(" min/km", "")} @ ${whole.second.hr})`);

          if (splits && st.dist.length) {
            const n = kmBuckets(st.dist[st.dist.length - 1]);
            const b = Array.from({ length: n }, () => ({ v: [], h: [] }));
            for (let i = 0; i < st.dist.length; i++) {
              const k = Math.min(Math.floor((st.dist[i] || 0) / 1000), n - 1);
              if (k < 0) continue;
              if (st.vel[i] > 0) b[k].v.push(st.vel[i]);
              if (st.hr[i] > 0) b[k].h.push(st.hr[i]);
            }
            const cells = b.map((x, k) => x.v.length ? `${k + 1} ${pS(mean(x.v))}/${x.h.length ? Math.round(mean(x.h)) : "-"}` : null).filter(Boolean);
            L.push(`📊 Splits (km ritmo/FC):`);
            for (let i = 0; i < cells.length; i += 6) L.push(`   ${cells.slice(i, i + 6).join(" · ")}`);
          }
        }

        // Diario
        const diary = [rpe != null ? `RPE ${rpe}/10` : null, a.feel != null ? `sensaciones ${FEEL[a.feel] || a.feel}` : null].filter(Boolean);
        L.push(diary.length ? `😓 ${diary.join(" · ")}` : `⚠️ Sin RPE ni sensaciones → registrarlos con update_activity`);
        if (a.description) L.push(`📝 ${a.description}`);
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_post_workout_report: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_weekly_review",
    "ONE-CALL Sunday review of a Monday–Sunday week: planned vs done day by day, km/load vs the previous 4 weeks (% change), HRV/sleep/resting-HR vs 30-day baseline, CTL/ATL/TSB change, key sessions (rep compliance, marathon-pace blocks with HR@4:16 and decoupling), missing RPE, next week's plan status, race countdown and the marathon-pace trend summary. Replaces ~9 separate calls.",
    {
      week_start: z.string().optional().describe("Lunes YYYY-MM-DD (default: semana en curso si hoy es sábado o domingo; si no, la anterior)"),
      include_mp_trend: z.boolean().optional().describe("Añadir el resumen de get_mp_trend (default: true)"),
    },
    async ({ week_start, include_mp_trend = true }) => {
      try {
        const d = today();
        const mon = week_start ? mondayOf(week_start) : ([0, 6].includes(dayOfWeek(d)) ? mondayOf(d) : addDays(mondayOf(d), -7));
        const sun = addDays(mon, 6);
        const [acts, evData, wData] = await Promise.all([
          listActivities(addDays(mon, -28), sun),
          callIntervals(`/athlete/${ATHLETE_ID}/events?${new URLSearchParams({ oldest: mon, newest: addDays(sun, 7) })}`),
          callIntervals(`/athlete/${ATHLETE_ID}/wellness?${new URLSearchParams({ oldest: addDays(mon, -31), newest: sun })}`),
        ]);
        const events = toArray(evData, "events").filter(e => !e.category || e.category === "WORKOUT" || String(e.category).startsWith("RACE"));
        const wl = toArray(wData, "wellness").sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const inWeek = (ds, m) => ds >= m && ds <= addDays(m, 6);
        const alerts = [];

        // Volumen: esta semana y las 4 anteriores
        const weeks = [0, 1, 2, 3, 4].map(k => {
          const m = addDays(mon, -7 * k);
          const wa = acts.filter(a => inWeek(actDate(a), m));
          const runs = wa.filter(isRun);
          return { m, km: runs.reduce((s, a) => s + (a.distance || 0), 0) / 1000, runs: runs.length,
                   ld: wa.reduce((s, a) => s + (firstDefined(a.icu_training_load, a.tss) || 0), 0), secs: wa.reduce((s, a) => s + (a.moving_time || 0), 0) };
        });
        const cw = weeks[0], pw = weeks[1], avg3 = mean(weeks.slice(1, 4).map(w => w.km));
        const pct = (x, y) => y > 0 ? `${x >= y ? "+" : ""}${Math.round((x / y - 1) * 100)}%` : "—";
        const L = [`📋 REVISIÓN SEMANAL ${mon} → ${sun}`, ``,
          `📏 VOLUMEN: ${cw.km.toFixed(1)} km en ${cw.runs} carreras · ${fmtDuration(cw.secs)} · carga ${fmt0(cw.ld)} (${(cw.km ? cw.ld / cw.km : 0).toFixed(1)} TSS/km)`,
          `   vs semana anterior (${pw.km.toFixed(1)} km): ${pct(cw.km, pw.km)} · vs media 3 semanas previas (${avg3.toFixed(1)} km): ${pct(cw.km, avg3)}`,
          `   Últimas semanas: ${weeks.slice().reverse().map(w => `${w.m.slice(5)} ${w.km.toFixed(0)}`).join(" · ")} km`];
        if (avg3 > 0 && cw.km > avg3 * 1.2) alerts.push(`volumen ${pct(cw.km, avg3)} sobre la tendencia (guía ~15%; no aplica al rebote tras semana de carrera)`);

        // Día a día: plan vs hecho
        L.push(``, `📅 PLAN vs HECHO`);
        let plKm = 0, noKm = 0;
        const weekActs = acts.filter(a => inWeek(actDate(a), mon));
        for (let i = 0; i < 7; i++) {
          const day = addDays(mon, i);
          const pl = events.filter(e => (e.start_date_local || "").startsWith(day));
          const dn = weekActs.filter(a => actDate(a) === day);
          pl.forEach(e => { if (/run/i.test(e.type || "Run")) { const pk = plannedKm(e); if (pk) plKm += pk; else noKm++; } });
          if (!pl.length && !dn.length) { L.push(`   ${dayLabel(day)} · descanso`); continue; }
          const used = new Set();
          const parts = pl.map(e => {
            const a = dn.find(x => !used.has(x.id) && pairedEvent(x, [e]) === e);
            if (a) used.add(a.id);
            const pk = plannedKm(e);
            if (!a) return `${e.name}${pk ? ` (${pk.toFixed(0)} km)` : ""} → ${day < d ? "❌ no hecho" : "pendiente"}`;
            const r = pk && isRun(a) ? (a.distance || 0) / 1000 / pk : null;
            const mark = r == null ? "✅" : r >= 0.9 ? "✅" : r >= 0.7 ? "🟡" : "🟠";
            return `${e.name}${pk ? ` (${pk.toFixed(0)})` : ""} → ${isRun(a) ? `${((a.distance || 0) / 1000).toFixed(1)} km ${pS(a.average_speed)} FC ${fmt0(a.average_heartrate)}` : fmtDuration(a.moving_time)}` +
              `${firstDefined(a.icu_rpe, a.perceived_exertion) != null ? ` RPE ${firstDefined(a.icu_rpe, a.perceived_exertion)}` : ""} ${mark}`;
          });
          dn.filter(a => !used.has(a.id)).forEach(a => parts.push(`➕ ${a.name || a.type} ${isRun(a) ? `${((a.distance || 0) / 1000).toFixed(1)} km ${pS(a.average_speed)}` : fmtDuration(a.moving_time)}`));
          L.push(`   ${dayLabel(day)} · ${parts.join(" | ")}`);
        }
        if (plKm > 0) L.push(`   Planificado: ${plKm.toFixed(1)} km${noKm ? ` + ${noKm} sesión(es) por tiempo` : ""} · hecho: ${cw.km.toFixed(1)} km`);

        // Sesiones clave: cumplimiento por repetición y bloques a ritmo maratón
        const band = mpBand();
        const runs = weekActs.filter(isRun);
        const keyLines = [];
        for (let i = 0; i < runs.length; i += 3) {
          const res = await Promise.all(runs.slice(i, i + 3).map(async (a) => {
            const out = [];
            const ev = pairedEvent(a, events);
            const steps = ev ? parseWorkoutText(ev.description) : [];
            if (steps.some(s => !isRestStep(s) && s.fast != null && s.fast < 270)) {
              const iv = await fetchIntervals(a.id).catch(() => null);
              const c = iv?.icu_intervals ? repCompliance(iv.icu_intervals, steps) : null;
              if (c) out.push(`${dayLabel(actDate(a))} · ${ev.name}: ${complianceSummary(c)}`);
            }
            if ((a.average_speed || 0) === 0 || a.average_speed > band.vLo * 0.75) {
              const r = await mpSegmentsFor(a, band).catch(() => ({ segs: [] }));
              r.segs.filter(s => s.km >= 3).forEach(s => out.push(`${dayLabel(actDate(a))} · MP km ${s.startKm.toFixed(1)}-${(s.endKm ?? s.startKm + s.km).toFixed(1)} (${s.km.toFixed(1)} km) ${fmtSecs(s.pace)} · FC ${Math.round(s.hr)} · FC@4:16 ${Math.round(s.hrNorm)}${s.dec != null ? ` · desac ${fmt1(s.dec)}% ${s.dec < 5 ? "🟢" : s.dec < 8 ? "🟡" : "🔴"}` : ""}`));
            }
            return out;
          }));
          res.forEach(r => keyLines.push(...r));
        }
        if (keyLines.length) L.push(``, `🎯 SESIONES CLAVE`, ...keyLines.map(x => `   ${x}`));
        const noRpe = runs.filter(a => firstDefined(a.icu_rpe, a.perceived_exertion) == null);
        if (noRpe.length) alerts.push(`sin RPE: ${noRpe.map(a => dayLabel(actDate(a))).join(", ")}`);

        // Recuperación
        const base = wl.filter(x => x.id < mon && x.id >= addDays(mon, -30));
        const wk = wl.filter(x => inWeek(x.id, mon));
        const bh = base.map(x => x.hrv).filter(v => v > 0), mu = mean(bh), sd = stdev(bh);
        const wh = wk.map(x => x.hrv).filter(v => v > 0);
        const sl = wk.map(x => x.sleepSecs).filter(v => v > 0);
        const rb = mean(base.map(x => x.restingHR).filter(v => v > 0)), rw = mean(wk.map(x => x.restingHR).filter(v => v > 0));
        L.push(``, `💓 RECUPERACIÓN`);
        if (wh.length && mu != null) {
          const low = sd ? wh.filter(v => v < mu - sd).length : 0;
          L.push(`   HRV media ${Math.round(mean(wh))} vs baseline ${Math.round(mu)} ± ${Math.round(sd || 0)} · ${low} día(s) bajo el rango · valores: ${wk.map(x => x.hrv || "-").join(" ")}`);
          if (low >= 3) alerts.push(`${low} días con HRV bajo el rango`);
        }
        if (sl.length) {
          const ok = sl.filter(s => s >= 27000).length;
          L.push(`   Sueño medio ${fmtSleep(mean(sl))} · noches ≥7h 30min: ${ok}/${sl.length}`);
          if (ok < 5 && sl.length >= 6) alerts.push(`solo ${ok} noches ≥7h 30min (objetivo 5/7)`);
        }
        if (rw) L.push(`   FC reposo media ${Math.round(rw)}${rb ? ` (baseline ${Math.round(rb)})` : ""}`);

        // Carga
        const lStart = [...wl].reverse().find(x => x.ctl != null && x.id < mon);
        const lEnd = [...wl].reverse().find(x => x.ctl != null && x.id <= sun);
        if (lEnd) {
          const tsb = lEnd.ctl - lEnd.atl;
          L.push(``, `📈 CARGA: CTL ${lStart ? `${fmt1(lStart.ctl)} → ` : ""}${fmt1(lEnd.ctl)}${lStart ? ` (${lEnd.ctl >= lStart.ctl ? "+" : ""}${fmt1(lEnd.ctl - lStart.ctl)})` : ""} · ATL ${fmt1(lEnd.atl)} · TSB ${fmt1(tsb)}${lEnd.rampRate != null ? ` · ramp ${Number(lEnd.rampRate).toFixed(1)}` : ""} (${lEnd.id})`);
          if (tsb < -25) alerts.push(`TSB ${fmt1(tsb)}`);
        }

        // Semana siguiente y cuenta atrás
        const nx = events.filter(e => { const ds = (e.start_date_local || "").split("T")[0]; return ds > sun && ds <= addDays(sun, 7); });
        const nxKm = nx.filter(e => /run/i.test(e.type || "Run")).reduce((s, e) => s + (plannedKm(e) || 0), 0);
        const toRace = Math.round((new Date(`${RACE_DATE}T12:00:00Z`) - new Date(`${d}T12:00:00Z`)) / 86400000);
        L.push(``, `🗓️ SIGUIENTE SEMANA: ${nx.length ? `${nx.length} sesiones planificadas · ${nxKm.toFixed(0)} km` : "sin planificar"}${toRace > 0 ? ` · Valencia en ${toRace} días (${Math.floor(toRace / 7)} sem ${toRace % 7} d)` : ""}`);

        if (include_mp_trend) {
          const r = await computeMpTrend();
          if (!r.error) L.push(``, ...mpTrendLines(r, { table: false }));
        }
        L.push(``, alerts.length ? `🚨 ALERTAS\n${alerts.map(x => `   • ${x}`).join("\n")}` : `✅ Sin alertas`);
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_weekly_review: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_athlete",
    "Athlete profile + running settings in one call: weight/age, LTHR, max HR, Critical Speed, D', configured HR zones, pace zones derived from CS, and gear (optional).",
    { include_gear: z.boolean().optional().describe("Incluir material/zapatillas (default: false)") },
    async ({ include_gear = false }) => {
      try {
        const [raw, cfg, gearData] = await Promise.all([
          callIntervals(`/athlete/${ATHLETE_ID}`),
          getRunConfig(true),
          include_gear ? callIntervals(`/athlete/${ATHLETE_ID}/gear`).catch(() => []) : null,
        ]);
        const p = raw.athlete || raw;
        const L = [`👤 ${p.name || p.username || "Atleta"}${p.sex ? ` · ${p.sex}` : ""}${p.dob ? ` · nacido ${p.dob}` : ""}${p.weight || p.icu_weight ? ` · ${p.weight || p.icu_weight} kg` : ""}${p.city ? ` · ${p.city}` : ""}`];
        if (!cfg) L.push(`⚠️ No hay configuración de carrera (Run) en intervals.`);
        else {
          const csMps = cfg.threshold_pace ? parseFloat(cfg.threshold_pace) : null;
          const csSecs = csMps ? (csMps < 20 ? 1000 / csMps : csMps) : null;
          L.push(`🎯 LTHR ${cfg.lthr ?? "?"} · FC máx ${cfg.max_hr ?? "?"}${csSecs ? ` · CS ${fmtSecs(csSecs)}/km` : ""}${cfg.w_prime ? ` · D' ${cfg.w_prime} m` : ""}`);
          if (Array.isArray(cfg.hr_zones) && cfg.hr_zones.length) L.push(`❤️ Zonas FC: ${zoneLabels(cfg.hr_zones.map(Number)).join(" · ")}`);
          if (csSecs) {
            const Z = [["Z1", 0, 77.5], ["Z2", 78.5, 87.7], ["Z3", 88.7, 94.3], ["Z4", 95.3, 100], ["Z5a", 101, 103.4], ["Z5b", 104.4, 111.5], ["Z5c", 112.5, 999]];
            L.push(`🏃 Zonas ritmo: ${Z.map(([n, lo, hi]) => lo === 0 ? `${n} >${fmtSecs(csSecs / (hi / 100))}` : hi >= 999 ? `${n} <${fmtSecs(csSecs / (lo / 100))}` : `${n} ${fmtSecs(csSecs / (hi / 100))}-${fmtSecs(csSecs / (lo / 100))}`).join(" · ")}`);
          }
        }
        if (include_gear) {
          const gear = toArray(gearData, "gear").filter(g => !g.retired).sort((a, b) => (b.distance || 0) - (a.distance || 0));
          L.push(gear.length ? `👟 Material: ${gear.map(g => `${g.name} ${fmt0((g.distance || 0) / 1000)} km`).join(" · ")}` : `👟 Sin material en intervals (Garmin no lo envía)`);
        }
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_athlete: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_activities",
    "List activities (distance, pace, HR, load, RPE, IDs) — or, with by_week, weekly totals (km, sessions, time, load) Monday–Sunday.",
    {
      oldest:  z.string().optional().describe("YYYY-MM-DD (default: hace 30 días)"),
      newest:  z.string().optional().describe("YYYY-MM-DD (default: hoy)"),
      limit:   z.number().optional().describe("Máximo de actividades (default: 20)"),
      by_week: z.boolean().optional().describe("Totales por semana lunes-domingo en lugar de la lista"),
      weeks:   z.number().optional().describe("Con by_week: semanas hacia atrás (default: 8, máx: 26)"),
    },
    async ({ oldest, newest, limit = 20, by_week = false, weeks = 8 }) => {
      try {
        if (by_week) {
          const w = Math.min(weeks, 26);
          const acts = await listActivities(addDays(mondayOf(today()), -7 * (w - 1)), today());
          const map = {};
          acts.forEach(a => {
            const k = mondayOf(actDate(a));
            const m = map[k] || (map[k] = { runs: 0, n: 0, km: 0, secs: 0, ld: 0 });
            m.n++; m.secs += a.moving_time || 0; m.ld += firstDefined(a.icu_training_load, a.tss) || 0;
            if (isRun(a)) { m.runs++; m.km += (a.distance || 0) / 1000; }
          });
          const rows = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
          const L = [`📊 SEMANAS (lun-dom) — km de carrera · sesiones · tiempo · carga`];
          rows.forEach(([k, m]) => L.push(`   ${k}: ${m.km.toFixed(1)} km · ${m.runs} carreras (${m.n} total) · ${fmtDuration(m.secs)} · ${fmt0(m.ld)}`));
          return { content: [{ type: "text", text: L.join("\n") }] };
        }
        const range = safeRange(oldest || daysAgo(30), newest, 180);
        const acts = (await listActivities(range.oldest, range.newest)).slice().reverse().slice(0, limit);
        if (!acts.length) return { content: [{ type: "text", text: `No hay actividades (${range.oldest} → ${range.newest}).` }] };
        const L = acts.map(a => `${actDate(a)} ${a.name || a.type} (${a.type}) [ID:${a.id}] · ${a.distance > 0 ? `${(a.distance / 1000).toFixed(2)} km · ` : ""}${fmtDuration(a.moving_time)}` +
          `${a.average_speed && isRun(a) ? ` · ${pS(a.average_speed)}` : ""}${a.average_heartrate ? ` · ${fmt0(a.average_heartrate)} bpm` : ""}` +
          `${firstDefined(a.icu_training_load, a.tss) != null ? ` · carga ${fmt0(firstDefined(a.icu_training_load, a.tss))}` : ""}${firstDefined(a.icu_rpe, a.perceived_exertion) != null ? ` · RPE ${firstDefined(a.icu_rpe, a.perceived_exertion)}` : ""}`);
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_activities: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_activity_data",
    "Raw breakdown of one activity when get_post_workout_report is not enough. view: 'splits' (km by km: pace, HR, cadence), 'intervals' (every interval/lap), 'decoupling' (Pa:HR for from_km–to_km), 'zones' (time in HR zones + elevation per km).",
    {
      activity_id: z.string().describe("ID de la actividad"),
      view:    z.enum(["splits", "intervals", "decoupling", "zones"]).optional().describe("default: splits"),
      from_km: z.number().optional().describe("decoupling: inicio del tramo en km"),
      to_km:   z.number().optional().describe("decoupling: fin del tramo en km"),
    },
    async ({ activity_id, view = "splits", from_km, to_km }) => {
      try {
        if (view === "intervals") {
          const raw = await fetchIntervals(activity_id);
          const ivs = raw?.icu_intervals || [];
          if (!ivs.length) return { content: [{ type: "text", text: "No hay intervalos para esta actividad." }] };
          const L = [`🔁 INTERVALOS (${ivs.length})`];
          ivs.forEach((iv, i) => L.push(`${String(i + 1).padStart(2)} ${iv.type || ""} ${((iv.distance || 0) / 1000).toFixed(2)} km · ${fmtSecs(iv.moving_time || iv.elapsed_time)} · ${pS(iv.average_speed)}` +
            `${iv.average_heartrate ? ` · FC ${fmt0(iv.average_heartrate)}/${fmt0(iv.max_heartrate)}` : ""}${iv.average_cadence ? ` · ${fmt0(iv.average_cadence)} spm` : ""}`));
          return { content: [{ type: "text", text: L.join("\n") }] };
        }
        const st = await fetchStreams(activity_id);
        if (!st.dist.length) return { content: [{ type: "text", text: "No hay streams para esta actividad." }] };
        if (view === "decoupling") {
          const r = computeDecoupling(st, from_km != null ? from_km * 1000 : null, to_km != null ? to_km * 1000 : null);
          if (!r) return { content: [{ type: "text", text: "⚠️ No hay datos suficientes de FC/ritmo en ese tramo (mínimo ~10 min)." }] };
          return { content: [{ type: "text", text: `🫀 Desacoplamiento${r.km ? ` km ${r.km}` : ""}: ${fmt1(r.decoupling)}% · 1ª mitad ${r.first.pace} @ ${r.first.hr} · 2ª ${r.second.pace} @ ${r.second.hr}\n   ${r.rating}` }] };
        }
        const { time, hr, vel, dist, cad, alt } = st;
        const n = kmBuckets(dist[dist.length - 1]);
        const b = Array.from({ length: n }, () => ({ v: [], h: [], c: [], a0: null, a1: null }));
        for (let i = 0; i < dist.length; i++) {
          const k = Math.min(Math.floor((dist[i] || 0) / 1000), n - 1);
          if (k < 0) continue;
          if (vel[i] > 0) b[k].v.push(vel[i]);
          if (hr[i] > 0) b[k].h.push(hr[i]);
          if (cad[i] > 0) b[k].c.push(cad[i]);
          if (alt.length) { if (b[k].a0 == null) b[k].a0 = alt[i]; b[k].a1 = alt[i]; }
        }
        const L = [`⏱ ${fmtDuration(time[time.length - 1] || 0)} · ${((dist[dist.length - 1] || 0) / 1000).toFixed(2)} km`];
        if (view === "zones" && hr.length) {
          const u = await getHrZoneUpper();
          const z = new Array(u.length).fill(0); let tot = 0;
          hr.forEach(x => { if (x > 0) { z[zoneOf(x, u)]++; tot++; } });
          L.push(`❤️ ${zoneLabels(u).map((lab, i) => `${lab} ${Math.round(z[i] / tot * 100)}%`).join(" · ")}`);
        }
        L.push(view === "zones" ? `km ritmo FC cad desnivel(GPS)` : `km ritmo FC cad`);
        b.forEach((x, k) => {
          if (!x.v.length && !x.h.length) return;
          const el = view === "zones" && x.a0 != null ? ` ${x.a1 - x.a0 >= 0 ? "+" : ""}${Math.round(x.a1 - x.a0)}m` : "";
          L.push(`${k + 1} ${x.v.length ? pS(mean(x.v)) : "-"} ${x.h.length ? Math.round(mean(x.h)) : "-"} ${x.c.length ? Math.round(mean(x.c)) : "-"}${el}`);
        });
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_activity_data: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_wellness",
    "Wellness by day: HRV, resting HR, sleep, VO2max, weight, subjective scores. With raw_date: dump every raw field for that day (debug).",
    {
      start_date: z.string().optional().describe("YYYY-MM-DD (default: hace 14 días)"),
      end_date:   z.string().optional().describe("YYYY-MM-DD (default: hoy)"),
      raw_date:   z.string().optional().describe("YYYY-MM-DD: volcar todos los campos de ese día"),
    },
    async ({ start_date, end_date, raw_date }) => {
      try {
        if (raw_date) {
          const e = toArray(await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${new URLSearchParams({ oldest: raw_date, newest: raw_date })}`), "wellness")[0];
          if (!e) return { content: [{ type: "text", text: `No hay wellness para ${raw_date}` }] };
          return { content: [{ type: "text", text: Object.entries(e).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") }] };
        }
        const range = safeRange(start_date || daysAgo(14), end_date, 180);
        const entries = toArray(await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${new URLSearchParams({ oldest: range.oldest, newest: range.newest })}`), "wellness")
          .filter(w => w.hrv || w.restingHR || w.sleepSecs || w.weight || w.vo2max);
        if (!entries.length) return { content: [{ type: "text", text: "No hay datos de wellness en el rango." }] };
        const L = [`fecha      HRV  FCr  sueño      score VO2  otros`];
        entries.forEach(w => L.push(`${w.id} ${String(w.hrv || "-").padStart(4)} ${String(w.restingHR || "-").padStart(4)}  ${(w.sleepSecs ? fmtSleep(w.sleepSecs) : "-").padEnd(10)} ${String(w.sleepScore || "-").padStart(4)} ${String(w.vo2max || "-").padStart(4)}` +
          `${["fatigue", "soreness", "mood", "motivation", "weight"].filter(k => w[k] != null).map(k => ` ${k} ${w[k]}`).join("")}${w.comments || w.notes ? ` 📝 ${w.comments || w.notes}` : ""}`));
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_wellness: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_fitness",
    "CTL (fitness), ATL (fatigue), TSB (form) and ramp rate: daily for the last 14 days, or with weeks=N the weekly trend (Sunday values) over N weeks.",
    {
      start_date: z.string().optional().describe("YYYY-MM-DD (default: hace 42 días)"),
      end_date:   z.string().optional().describe("YYYY-MM-DD (default: hoy)"),
      weeks:      z.number().optional().describe("Tendencia semanal de N semanas (máx 52)"),
    },
    async ({ start_date, end_date, weeks }) => {
      try {
        const oldest = weeks ? daysAgo(Math.min(weeks, 52) * 7) : (start_date || daysAgo(42));
        const newest = weeks ? today() : (end_date || today());
        const entries = toArray(await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${new URLSearchParams({ oldest, newest })}`), "wellness")
          .filter(x => x.ctl != null).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (!entries.length) return { content: [{ type: "text", text: "No hay datos de CTL/ATL." }] };
        const t = (x) => x.ctl - x.atl;
        const icon = (v) => v > 5 ? "🟢" : v > -10 ? "🟡" : v > -25 ? "🟠" : "🔴";
        const last = entries[entries.length - 1];
        const L = [`📊 ${last.id}: CTL ${fmt1(last.ctl)} · ATL ${fmt1(last.atl)} · TSB ${fmt1(t(last))} ${icon(t(last))}${last.rampRate != null ? ` · ramp ${Number(last.rampRate).toFixed(2)}/sem` : ""}`];
        if (weeks) {
          const byWeek = {};
          entries.forEach(x => { byWeek[mondayOf(x.id)] = x; });
          Object.entries(byWeek).sort((a, b) => a[0].localeCompare(b[0])).forEach(([m, x]) => L.push(`   sem ${m}: CTL ${fmt1(x.ctl)} · ATL ${fmt1(x.atl)} · TSB ${fmt1(t(x))} ${icon(t(x))}`));
        } else entries.slice(-14).forEach(x => L.push(`   ${x.id}: CTL ${fmt1(x.ctl)} · ATL ${fmt1(x.atl)} · TSB ${fmt1(t(x))}`));
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_fitness: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_events",
    "Planned workouts/events from the calendar (with their full workout text), or one event by event_id.",
    {
      start_date: z.string().optional().describe("YYYY-MM-DD (default: hoy)"),
      end_date:   z.string().optional().describe("YYYY-MM-DD (default: +21 días)"),
      event_id:   z.string().optional().describe("Un evento concreto por su ID"),
    },
    async ({ start_date, end_date, event_id }) => {
      try {
        const evs = event_id
          ? [await callIntervals(`/athlete/${ATHLETE_ID}/events/${event_id}`)].flat()
          : toArray(await callIntervals(`/athlete/${ATHLETE_ID}/events?${new URLSearchParams({ oldest: start_date || today(), newest: end_date || daysAhead(21) })}`), "events");
        if (!evs.length || !evs[0]) return { content: [{ type: "text", text: "No hay eventos planificados." }] };
        const L = evs.map(e => {
          const pk = plannedKm(e);
          return `📅 ${(e.start_date_local || "").replace("T", " ").slice(0, 16)} ${dayLabel((e.start_date_local || "").slice(0, 10))} — ${e.name || "Evento"} (${e.type || e.category || "?"}) [ID:${e.id}]` +
            `${pk ? ` · ${pk.toFixed(1)} km` : ""}${e.moving_time ? ` · ${fmtDuration(e.moving_time)}` : ""}${e.load ? ` · carga ${fmt0(e.load)}` : ""}` +
            `${e.description ? `\n${e.description.split("\n").map(x => `   ${x}`).join("\n")}` : ""}`;
        });
        return { content: [{ type: "text", text: L.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_events: ${err.message}` }] };
      }
    }
  );

  srv.tool("create_events",
    "Create one or many calendar events in ONE call (a whole week on Sundays). Each event: date, name, type (Run/WeightTraining/…), description in intervals.icu workout text format, optional duration_mins, distance_km, load, time (HH:MM). Default time: Saturday 09:00, other days 19:00. Strength-session duration is fixed automatically.",
    {
      events: z.array(z.object({
        date:          z.string().describe("YYYY-MM-DD"),
        name:          z.string(),
        type:          z.string().optional().describe("Run (default), WeightTraining, Ride, Swim…"),
        description:   z.string().optional().describe("Estructura del entreno en formato intervals.icu"),
        duration_mins: z.number().optional(),
        distance_km:   z.number().optional(),
        load:          z.number().optional(),
        time:          z.string().optional().describe("HH:MM para sobrescribir la hora por defecto"),
        category:      z.enum(["WORKOUT", "RACE_A", "RACE_B", "RACE_C", "NOTE"]).optional().describe("default: WORKOUT (carreras: RACE_A/B/C)"),
      })).min(1).max(30),
    },
    async ({ events }) => {
      try {
        const bodies = events.map(e => {
          const t = e.time ? `${e.time}:00` : (dayOfWeek(e.date) === 6 ? "09:00:00" : "19:00:00");
          return {
            start_date_local: `${e.date}T${t}`,
            name: e.name,
            type: e.type || "Run",
            category: e.category || "WORKOUT",
            description: e.description || "",
            ...(e.duration_mins && { moving_time: e.duration_mins * 60 }),
            ...(e.distance_km   && { distance: Math.round(e.distance_km * 1000) }),
            ...(e.load          && { load: e.load }),
          };
        });
        const res = await callIntervals(`/athlete/${ATHLETE_ID}/events/bulk`, "POST", bodies);
        const created = Array.isArray(res) ? res : toArray(res, "events");

        // intervals devuelve los eventos ordenados por fecha → emparejar por fecha + nombre, nunca por posición
        const pool = [...created];
        const matched = events.map(e => {
          const k = pool.findIndex(c => (c.start_date_local || "").startsWith(e.date) && c.name === e.name);
          return k === -1 ? null : pool.splice(k, 1)[0];
        });

        // Fijar duración de las sesiones de fuerza
        await Promise.all(events.map(async (e, i) => {
          const c = matched[i];
          if (c?.id && e.duration_mins && /weight|strength/i.test(e.type || "")) {
            try { await callIntervals(`/athlete/${ATHLETE_ID}/events/${c.id}`, "PUT", { moving_time: e.duration_mins * 60 }); } catch (_) {}
          }
        }));

        const L = [`✅ ${created.length || events.length} eventos creados`];
        events.forEach((e, i) => L.push(`   ${e.date} — ${e.name} (${e.type || "Run"})${matched[i]?.id ? ` [ID:${matched[i].id}]` : ""}`));
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ create_events: ${err.message}` }] };
      }
    }
  );

  srv.tool("update_event",
    "Update an existing calendar event: change name, description, date, duration or load.",
    {
      event_id:      z.string().describe("Event ID to update (from get_events [ID:xxx])"),
      name:          z.string().optional().describe("New workout name"),
      description:   z.string().optional().describe("New description (use intervals.icu workout format with - steps)"),
      date:          z.string().optional().describe("New date YYYY-MM-DD"),
      load:          z.number().optional().describe("New target TSS/load"),
      duration_mins: z.number().optional().describe("New planned duration in minutes"),
    },
    async ({ event_id, name, description, date, load, duration_mins }) => {
      try {
        const body = {
          ...(name          && { name }),
          ...(description   != null && { description }),
          ...(load          && { load }),
          ...(duration_mins && { moving_time: duration_mins * 60 }),
        };
        if (date) {
          const startTime = dayOfWeek(date) === 6 ? "09:00:00" : "19:00:00";
          body.start_date_local = `${date}T${startTime}`;
        }
        await callIntervals(`/athlete/${ATHLETE_ID}/events/${event_id}`, "PUT", body);
        return { content: [{ type: "text", text: `✅ Evento ${event_id} actualizado correctamente.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ update_event: ${err.message}` }] };
      }
    }
  );

  srv.tool("delete_event",
    "Delete a planned event by its ID",
    { event_id: z.string().describe("Event ID") },
    async ({ event_id }) => {
      try {
        await callIntervals(`/athlete/${ATHLETE_ID}/events/${event_id}`, "DELETE");
        return { content: [{ type: "text", text: `✅ Event ${event_id} deleted.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
      }
    }
  );

  srv.tool("update_activity",
    "Write post-workout diary data to a completed activity: RPE (1-10), feel (1=muy fuerte … 5=muy flojo), name, description, or append a diary note. RPE also lets intervals.icu compute load for strength sessions without HR.",
    {
      activity_id: z.string().describe("Activity ID e.g. i139521833"),
      rpe:         z.number().min(1).max(10).optional().describe("Esfuerzo percibido 1-10"),
      feel:        z.number().min(1).max(5).optional().describe("Sensaciones: 1 muy fuerte, 2 fuerte, 3 normal, 4 flojo, 5 muy flojo"),
      name:        z.string().optional().describe("Nuevo nombre"),
      description: z.string().optional().describe("Sustituye la descripción completa"),
      append_note: z.string().optional().describe("Añade una nota de diario al final de la descripción existente"),
    },
    async ({ activity_id, rpe, feel, name, description, append_note }) => {
      try {
        const body = {
          ...(rpe  != null && { icu_rpe: Math.round(rpe) }),
          ...(feel != null && { feel: Math.round(feel) }),
          ...(name && { name }),
        };
        if (description != null) body.description = description;
        if (append_note) {
          const current = description != null ? description : ((await fetchActivity(activity_id))?.description || "");
          body.description = `${current ? current + "\n\n" : ""}📝 ${append_note}`;
        }
        if (!Object.keys(body).length) return { content: [{ type: "text", text: "⚠️ No hay nada que actualizar." }] };
        try { await callIntervals(`/activity/${activity_id}`, "PUT", body); }
        catch (_) { await callIntervals(`/activity/${cleanId(activity_id)}`, "PUT", body); }
        invalidateActivity(activity_id);
        const parts = [rpe != null && `RPE ${rpe}`, feel != null && `feel ${feel}`, name && "nombre", (description != null || append_note) && "descripción"].filter(Boolean);
        return { content: [{ type: "text", text: `✅ Actividad ${activity_id} actualizada: ${parts.join(", ")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ update_activity: ${err.message}` }] };
      }
    }
  );

  srv.tool("update_wellness",
    "Update wellness for a day: HRV, resting HR, sleep, weight, fatigue, mood, motivation, soreness, notes",
    {
      date:        z.string().describe("Date YYYY-MM-DD"),
      hrv:         z.number().optional(),
      resting_hr:  z.number().optional(),
      sleep_secs:  z.number().optional().describe("Seconds (7h=25200)"),
      sleep_score: z.number().optional().describe("0-100"),
      weight:      z.number().optional().describe("kg"),
      fatigue:     z.number().optional().describe("1-10"),
      mood:        z.number().optional().describe("1-10"),
      motivation:  z.number().optional().describe("1-10"),
      soreness:    z.number().optional().describe("1-10"),
      notes:       z.string().optional(),
    },
    async ({ date, hrv, resting_hr, sleep_secs, sleep_score, weight, fatigue, mood, motivation, soreness, notes }) => {
      try {
        const body = {
          id: date,
          ...(hrv         != null && { hrv }),
          ...(resting_hr  != null && { restingHR: resting_hr }),
          ...(sleep_secs  != null && { sleepSecs: sleep_secs }),
          ...(sleep_score != null && { sleepScore: sleep_score }),
          ...(weight      != null && { weight }),
          ...(fatigue     != null && { fatigue }),
          ...(mood        != null && { mood }),
          ...(motivation  != null && { motivation }),
          ...(soreness    != null && { soreness }),
          ...(notes                && { notes }),
        };
        await callIntervals(`/athlete/${ATHLETE_ID}/wellness/${date}`, "PUT", body);
        return { content: [{ type: "text", text: `✅ Wellness updated for ${date}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
      }
    }
  );

  srv.tool("update_sport_settings",
    "Update running thresholds in intervals.icu after a test or race: LTHR, max HR, threshold pace / Critical Speed (m:ss per km), D'. HR zones are rescaled proportionally to the new LTHR. All analysis tools use the new zones automatically.",
    {
      lthr:           z.number().optional().describe("Nueva FC umbral (bpm)"),
      max_hr:         z.number().optional().describe("Nueva FC máxima (bpm)"),
      threshold_pace: z.string().optional().describe("Nuevo ritmo umbral / CS en formato m:ss por km (ej: '4:02')"),
      d_prime:        z.number().optional().describe("Nuevo D' en metros"),
      rescale_hr_zones: z.boolean().optional().describe("Reescalar zonas FC al nuevo LTHR (default: true)"),
      hr_zones:       z.array(z.number()).optional().describe("Fijar zonas FC explícitas: límites superiores en bpm, el último = FC máx. Ej: [133,148,163,178,193]"),
    },
    async ({ lthr, max_hr, threshold_pace, d_prime, rescale_hr_zones = true, hr_zones }) => {
      try {
        const cfg = await getRunConfig(true);
        if (!cfg?.id) return { content: [{ type: "text", text: "❌ No se encontró la configuración de running en intervals." }] };
        const body = {};
        const before = [], after = [];
        if (lthr != null)   { body.lthr = lthr;     before.push(`LTHR ${cfg.lthr ?? "?"}`);  after.push(`LTHR ${lthr}`); }
        if (max_hr != null) { body.max_hr = max_hr; before.push(`FCmax ${cfg.max_hr ?? "?"}`); after.push(`FCmax ${max_hr}`); }
        if (threshold_pace) {
          const mps = paceStrToMps(threshold_pace);
          if (!mps) return { content: [{ type: "text", text: `❌ Formato de ritmo no válido: "${threshold_pace}" (usa m:ss, ej 4:02)` }] };
          body.threshold_pace = mps;
          before.push(`CS ${cfg.threshold_pace ? fmtSecs(1000 / cfg.threshold_pace) : "?"}/km`);
          after.push(`CS ${threshold_pace}/km`);
        }
        if (d_prime != null) { body.w_prime = d_prime; before.push(`D' ${cfg.w_prime ?? "?"}`); after.push(`D' ${d_prime}`); }
        let newZones = null;
        if (hr_zones?.length) {
          const sorted = [...hr_zones].map(Number);
          if (sorted.some((v, i) => i > 0 && v <= sorted[i - 1])) return { content: [{ type: "text", text: "❌ Las zonas deben ser límites superiores crecientes." }] };
          newZones = sorted;
          body.hr_zones = sorted;
          if (Array.isArray(cfg.hr_zone_names)) {
            const DEF5 = ["Recovery", "Endurance", "Tempo", "Threshold", "Interval"];
            body.hr_zone_names = sorted.length === 5 ? DEF5 : zoneNames(sorted.length);
          }
          before.push(`zonas FC ${(cfg.hr_zones || []).join("/")}`);
          after.push(`zonas FC ${sorted.join("/")}`);
        }
        if (!Object.keys(body).length) return { content: [{ type: "text", text: "⚠️ No hay nada que actualizar." }] };

        if (!newZones && rescale_hr_zones && Array.isArray(cfg.hr_zones) && cfg.hr_zones.length && (lthr != null || max_hr != null)) {
          const ratio = lthr != null && cfg.lthr ? lthr / cfg.lthr : 1;
          newZones = cfg.hr_zones.map((z, i, arr) => i === arr.length - 1 ? (max_hr ?? cfg.max_hr ?? z) : Math.round(z * ratio));
          body.hr_zones = newZones;
        }
        await callIntervals(`/athlete/${ATHLETE_ID}/sport-settings/${cfg.id}`, "PUT", body);
        zoneCache = { at: 0, upper: null, cfg: null }; // invalida caché
        const L = [`✅ Umbrales de running actualizados`, `   Antes:   ${before.join(" · ")}`, `   Después: ${after.join(" · ")}`];
        if (newZones) L.push(`   Zonas FC (límites superiores): ${newZones.join(" / ")}`);
        L.push(`   Recuerda: actualizar también el archivo del proyecto con los valores nuevos.`);
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ update_sport_settings: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_best_efforts",
    "Best efforts over standard distances (1k, 3k, 5k, 10k, 15k, half, 30k) computed from recent run streams, plus Riegel marathon predictions from the 10k and half. Slow (~10-30 s): use for monthly load reviews or after races, not daily.",
    {
      days:           z.number().optional().describe("Días hacia atrás (default: 90, máx: 180)"),
      max_activities: z.number().optional().describe("Máximo de actividades a analizar (default: 40, máx: 80)"),
    },
    async ({ days = 90, max_activities = 40 }) => {
      try {
        const nDays = Math.min(days, 180);
        const params = new URLSearchParams({ oldest: daysAgo(nDays), newest: today() });
        const acts = toArray(await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`), "activities")
          .filter(a => a.type === "Run" && (a.distance || 0) >= 1000 && !a.trainer)
          .sort((a, b) => String(b.start_date_local).localeCompare(String(a.start_date_local)))
          .slice(0, Math.min(max_activities, 80));
        if (!acts.length) return { content: [{ type: "text", text: "No hay carreras en ese periodo." }] };

        const DIST = [[1000,"1 km"],[3000,"3 km"],[5000,"5 km"],[10000,"10 km"],[15000,"15 km"],[21097.5,"Media"],[30000,"30 km"]];
        const best = {};
        for (let i = 0; i < acts.length; i += 3) {
          const batch = acts.slice(i, i + 3);
          const results = await Promise.all(batch.map(a => fetchStreams(a.id, "time,distance").then(st => ({ a, st })).catch(() => null)));
          for (const r of results) {
            if (!r) continue;
            for (const [m] of DIST) {
              const t = bestEffort(r.st.time, r.st.dist, m);
              if (!t || m / t > 6.5) continue; // descarta saltos de GPS (> 2:34/km)
              if (!best[m] || t < best[m].t) best[m] = { t, a: r.a };
            }
          }
        }
        const L = [`🏅 MEJORES ESFUERZOS — últimos ${nDays} días (${acts.length} carreras analizadas)`, ``];
        for (const [m, label] of DIST) {
          const b = best[m];
          if (!b) continue;
          L.push(`   ${label.padEnd(6)} ${fmtSecs(b.t).padStart(8)}  (${fmtSecs(b.t / (m / 1000))}/km)  ${(b.a.start_date_local || "").split("T")[0]} · ${b.a.name || ""}`);
        }
        const pred = [[10000, "10 km"], [21097.5, "Media"]].filter(([m]) => best[m]).map(([m, label]) => {
          const t = best[m].t * Math.pow(42195 / m, 1.06);
          return `   Desde ${label}: ${fmtSecs(t)} (${fmtSecs(t / 42.195)}/km)`;
        });
        if (pred.length) {
          L.push(``, `🔮 PREDICCIÓN MARATÓN (Riegel, exponente 1.06)`, ...pred);
          L.push(`   ⚠️ Orientativo: los mejores esfuerzos dentro de entrenos no son marcas a tope, y Riegel suele ser optimista para maratón si falta volumen específico.`);
        }
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_best_efforts: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_mp_trend",
    "Marathon-pace readiness indicator: every continuous segment inside a grade-adjusted pace band (default 4:05-4:25/km) over the last N days, with pace, HR, HR normalised to the target pace, decoupling, elevation and start km (fatigue context), plus the trend of the HR cost of marathon pace. Cached per activity: only new runs are processed.",
    {
      target_pace: z.string().optional().describe("Ritmo objetivo m:ss/km (default: 4:16)"),
      pace_fast:   z.string().optional().describe("Límite rápido de la banda m:ss/km, ritmo GAP (default: 4:05)"),
      pace_slow:   z.string().optional().describe("Límite lento de la banda m:ss/km, ritmo GAP (default: 4:25)"),
      days:        z.number().optional().describe("Días hacia atrás (default: 90, máx: 180)"),
      min_km:      z.number().optional().describe("Longitud mínima del tramo en km (default: 2)"),
      include_treadmill: z.boolean().optional().describe("Incluir cinta/VirtualRun (default: false)"),
    },
    async (args) => {
      try {
        const r = await computeMpTrend(args);
        if (r.error) return { content: [{ type: "text", text: r.error }] };
        return { content: [{ type: "text", text: mpTrendLines(r, { table: true }).join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_mp_trend: ${err.message}` }] };
      }
    }
  );

  srv.tool("project_fitness",
    "Project CTL/ATL/TSB day by day until a date (default: next race). Uses actual loads so far, planned calendar events (their load, or estimated from duration with the athlete's own load-per-hour), and for weeks without planned events the weekly loads you pass (weekly_loads) or, by default, the average of the last 4 weeks. Reports the last 8 weeks of real load for calibration, a weekly table and the morning form (CTL/TSB) on key dates.",
    {
      until:        z.string().optional().describe("Fecha final YYYY-MM-DD (default: 2026-12-06)"),
      weekly_loads: z.array(z.number()).optional().describe("Carga semanal (TSS) para cada semana SIN entrenos planificados, en orden. Si faltan semanas se repite la última"),
      key_dates:    z.array(z.string()).optional().describe("Fechas clave YYYY-MM-DD para mostrar la forma de esa mañana (carreras)"),
      day_pattern:  z.array(z.number()).length(7).optional().describe("Reparto de la carga semanal lun→dom (default: [0.13,0.18,0.05,0.17,0.13,0.34,0])"),
    },
    async ({ until = "2026-12-06", weekly_loads, key_dates, day_pattern }) => {
      try {
        const d = today();
        if (until <= d) return { content: [{ type: "text", text: "❌ La fecha final debe ser futura." }] };
        const pattern = day_pattern || [0.13, 0.18, 0.05, 0.17, 0.13, 0.34, 0];
        const psum = pattern.reduce((a, b) => a + b, 0) || 1;
        const histStart = addDays(mondayOf(d), -56);

        const [wData, aData, eData] = await Promise.all([
          callIntervals(`/athlete/${ATHLETE_ID}/wellness?${new URLSearchParams({ oldest: addDays(d, -3), newest: d })}`),
          callIntervals(`/athlete/${ATHLETE_ID}/activities?${new URLSearchParams({ oldest: histStart, newest: d })}`),
          callIntervals(`/athlete/${ATHLETE_ID}/events?${new URLSearchParams({ oldest: histStart, newest: until })}`),
        ]);

        // Punto de partida: CTL/ATL al final de ayer
        const wl = toArray(wData, "wellness").filter(w => w.ctl != null && w.id < d).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const base = wl[wl.length - 1];
        if (!base) return { content: [{ type: "text", text: "❌ No hay CTL/ATL recientes en wellness." }] };
        let ctl = base.ctl, atl = base.atl;
        let cursor = addDays(base.id, 1);

        // Cargas reales y ratio carga/hora por tipo (calibración con sus propios datos)
        const acts = toArray(aData, "activities");
        const actual = {}; const perType = {};
        acts.forEach(a => {
          const day = (a.start_date_local || "").split("T")[0];
          const ld = firstDefined(a.icu_training_load, a.tss) || 0;
          actual[day] = (actual[day] || 0) + ld;
          const key = /run/i.test(a.type || "") ? "Run" : (a.type || "Other");
          if (!perType[key]) perType[key] = { load: 0, secs: 0 };
          perType[key].load += ld; perType[key].secs += a.moving_time || 0;
        });
        const lph = (type) => {
          const key = /run/i.test(type || "Run") ? "Run" : type;
          const p = perType[key];
          return p && p.secs > 1800 ? p.load / (p.secs / 3600) : (key === "Run" ? 60 : 20);
        };

        // Historial semanal (8 semanas completas)
        const weeks = [];
        for (let w = 8; w >= 1; w--) {
          const mon = addDays(mondayOf(d), -7 * w);
          let ld = 0, km = 0;
          acts.forEach(a => {
            const day = (a.start_date_local || "").split("T")[0];
            if (day >= mon && day <= addDays(mon, 6)) { ld += firstDefined(a.icu_training_load, a.tss) || 0; if (/run/i.test(a.type || "")) km += (a.distance || 0) / 1000; }
          });
          weeks.push({ mon, ld, km });
        }
        const avg4 = mean(weeks.slice(-4).map(w => w.ld));

        // Calibración: intervals calcula la carga de los entrenos PLANIFICADOS con otro modelo (por ritmo)
        // que puede diferir mucho de la carga real (por FC). Factor = real / planificado en semanas pasadas.
        const allEvents = toArray(eData, "events").filter(e => !e.category || e.category === "WORKOUT");
        let pastPlanned = 0, pastActual = 0;
        weeks.forEach(w => {
          let pl = 0;
          allEvents.forEach(e => {
            const day = (e.start_date_local || "").split("T")[0];
            if (day >= w.mon && day <= addDays(w.mon, 6)) pl += firstDefined(e.icu_training_load, e.load) || 0;
          });
          if (pl > 0 && w.ld > 0) { pastPlanned += pl; pastActual += w.ld; }
        });
        const calib = pastPlanned > 0 ? Math.max(0.4, Math.min(1.5, pastActual / pastPlanned)) : 1;

        // Entrenos planificados (futuros)
        const planned = {}; let lastPlanned = null, estimated = 0;
        allEvents.forEach(e => {
          const day = (e.start_date_local || "").split("T")[0];
          if (day < d) return;
          let ld = firstDefined(e.icu_training_load, e.load);
          if (ld != null) ld *= calib;
          else if (e.moving_time) { ld = e.moving_time / 3600 * lph(e.type); estimated++; }
          if (ld == null) return;
          planned[day] = (planned[day] || 0) + ld;
          if (!lastPlanned || day > lastPlanned) lastPlanned = day;
        });
        // Semanas genéricas: a partir del lunes siguiente al último entreno planificado (o del lunes que viene)
        const genericFrom = addDays(mondayOf(lastPlanned && lastPlanned >= d ? lastPlanned : d), 7);

        const kc = 1 - Math.exp(-1 / 42), ka = 1 - Math.exp(-1 / 7);
        const series = {}; const weekRows = []; let wkLoad = 0;
        let genericIdx = -1, lastGenericMon = null;
        while (cursor <= until) {
          let ld;
          if (cursor < d) ld = actual[cursor] || 0;
          else if (cursor === d && actual[cursor]) ld = actual[cursor];
          else if (cursor < genericFrom) ld = planned[cursor] || 0;
          else {
            const mon = mondayOf(cursor);
            if (mon !== lastGenericMon) { genericIdx++; lastGenericMon = mon; }
            const wk = weekly_loads?.length ? weekly_loads[Math.min(genericIdx, weekly_loads.length - 1)] : avg4;
            const dow = dayOfWeek(cursor); // 0=dom
            ld = wk * pattern[dow === 0 ? 6 : dow - 1] / psum;
          }
          series[cursor] = { ctlPrev: ctl, atlPrev: atl };
          ctl += (ld - ctl) * kc; atl += (ld - atl) * ka;
          wkLoad += ld;
          if (dayOfWeek(cursor) === 0 || cursor === until) {
            weekRows.push({ end: cursor, ld: wkLoad, ctl, atl, src: cursor < genericFrom ? "plan" : "supuesto" });
            wkLoad = 0;
          }
          cursor = addDays(cursor, 1);
        }

        const L = [`🔮 PROYECCIÓN DE CARGA hasta ${until}`, `   Punto de partida (${base.id}): CTL ${fmt1(base.ctl)} · ATL ${fmt1(base.atl)}`, ``, `📚 CARGA REAL — últimas 8 semanas`];
        weeks.forEach(w => L.push(`   sem ${w.mon}: ${fmt0(w.ld)} TSS · ${w.km.toFixed(0)} km`));
        L.push(`   Media últimas 4 semanas: ${fmt0(avg4)} TSS/semana · carrera ≈ ${fmt0(lph("Run"))} TSS/h`);
        const kmTot = weeks.reduce((a, w) => a + w.km, 0), ldTot = weeks.reduce((a, w) => a + w.ld, 0);
        if (kmTot > 0) L.push(`   Conversión real: ${(ldTot / kmTot).toFixed(1)} TSS por km (útil para traducir km planificados a carga)`);
        L.push(`   Calibración carga planificada → real: ×${calib.toFixed(2)}${pastPlanned > 0 ? "" : " (sin histórico de planificados)"}`);
        L.push(``, `📅 PROYECCIÓN SEMANAL (fin de semana, domingo)`, `   semana      | carga | CTL  | ATL  | TSB   | origen`);
        weekRows.forEach(r => L.push(`   ${r.end} | ${fmt0(r.ld).padStart(5)} | ${fmt1(r.ctl).padStart(4)} | ${fmt1(r.atl).padStart(4)} | ${fmt1(r.ctl - r.atl).padStart(5)} | ${r.src}`));
        const peak = weekRows.reduce((m, r) => r.ctl > m.ctl ? r : m, weekRows[0]);
        L.push(`   Pico de CTL: ${fmt1(peak.ctl)} (semana que acaba el ${peak.end})`);

        const kd = [...new Set([...(key_dates || []), until])].filter(x => series[x]).sort();
        if (kd.length) {
          L.push(``, `🏁 FORMA LA MAÑANA DE LAS FECHAS CLAVE`);
          kd.forEach(x => { const s = series[x]; const tsb = s.ctlPrev - s.atlPrev; L.push(`   ${x}: CTL ${fmt1(s.ctlPrev)} · TSB ${fmt1(tsb)} ${tsb >= 8 && tsb <= 15 ? "🎯" : tsb > 15 ? "🟢 (muy fresco)" : tsb >= 0 ? "🟡" : "🟠"}`); });
        }
        L.push(``, `ℹ️ Semanas "plan" = entrenos del calendario${estimated ? ` (${estimated} con carga estimada por duración)` : ""}; "supuesto" = ${weekly_loads?.length ? "cargas indicadas" : "media de las últimas 4 semanas"}. Modelo exponencial 42/7 días; puede diferir ±1 punto de intervals.`);
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ project_fitness: ${err.message}` }] };
      }
    }
  );

  return srv;
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, mcp-session-id");
  if (req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});

// ─── Autenticación ────────────────────────────────────────────────────────────
// Si MCP_AUTH_TOKEN está definido, se exige el token en una de estas formas:
//   https://…/mcp/<TOKEN>        ← recomendada para el conector de Claude
//   https://…/sse?token=<TOKEN>
//   cabecera Authorization: Bearer <TOKEN>
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const bearer   = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = req.params.token || req.query.token || bearer;
  if (provided && safeEqual(provided, AUTH_TOKEN)) return next();
  console.warn(`🔒 Acceso rechazado: ${req.method} ${req.params.token ? "/mcp/***" : req.path} desde ${req.ip}`);
  res.status(401).json({ error: "Unauthorized" });
}
const MCP_PATHS = ["/sse", "/mcp/:token"];

// Session store for stateful MCP connections
const sessions = new Map();

function getOrCreateTransport(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId).transport;
  }
  return null;
}

// ── POST /sse — new MCP Streamable HTTP transport ─────────────────────────────
app.post(MCP_PATHS, requireAuth, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = getOrCreateTransport(sessionId);

    // Sesión de antes de un redespliegue: según la especificación MCP se responde 404
    // para que el cliente (Claude) abra una sesión nueva automáticamente.
    if (!transport && sessionId) {
      console.log(`Sesión desconocida (probable redespliegue): ${sessionId}`);
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: req.body?.id ?? null });
      return;
    }

    if (!transport) {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport });
          console.log(`Session created: ${id}`);
        },
      });

      transport.onclose = () => {
        const id = [...sessions.entries()].find(([, v]) => v.transport === transport)?.[0];
        if (id) {
          sessions.delete(id);
          console.log(`Session closed: ${id}`);
        }
      };

      const srv = createServer();
      await srv.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("POST /sse error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
    }
  }
});

// ── GET /sse — SSE stream for server-to-client notifications ──────────────────
app.get(MCP_PATHS, requireAuth, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    const transport = getOrCreateTransport(sessionId);
    if (!transport) {
      res.status(sessionId ? 404 : 400).json({ error: sessionId ? "Session not found" : "No active session. Send POST /sse first." });
      return;
    }
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("GET /sse error:", err.message);
    if (!res.headersSent) res.status(500).end();
  }
});

// ── DELETE /sse — close session ───────────────────────────────────────────────
app.delete(MCP_PATHS, requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    try { await transport.close(); } catch (_) {}
    sessions.delete(sessionId);
    console.log(`Session deleted: ${sessionId}`);
  }
  res.status(200).end();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "ok", version: "7.1.0", transport: "streamable-http", sessions: sessions.size, auth: !!AUTH_TOKEN,
  cache: { streams: streamCache.size, data: dataCache.size, hits: streamCache.hits + dataCache.hits, misses: streamCache.miss + dataCache.miss }
}));

app.listen(PORT, () => {
  console.log(`✅ Intervals MCP v7.1 (Streamable HTTP, 18 herramientas) — port ${PORT} — athlete ${ATHLETE_ID} — ${AUTH_TOKEN ? "🔒 token activo" : "⚠️ SIN token: endpoint abierto"}`);
});
