import express from "express";
import { randomUUID, timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY    = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID;
const PORT       = process.env.PORT || 3000;
const BASE_URL   = "https://intervals.icu/api/v1";
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
  const minkm = 1000 / mps / 60;
  const mins  = Math.floor(minkm);
  const secs  = Math.round((minkm - mins) * 60);
  return `${mins}:${String(secs).padStart(2, "0")} min/km`;
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

// ─── Actividad completa (cualquier fecha, no solo 60 días) ───────────────────
async function fetchActivity(activity_id) {
  try { return await callIntervals(`/activity/${activity_id}`); }
  catch (_) { return await callIntervals(`/activity/${cleanId(activity_id)}`); }
}

async function fetchStreams(activity_id, types = "time,heartrate,velocity_smooth,distance,cadence,altitude") {
  const params = new URLSearchParams({ types });
  let raw;
  try { raw = await callIntervals(`/activity/${activity_id}/streams?${params}`); }
  catch (_) { raw = await callIntervals(`/activity/${cleanId(activity_id)}/streams?${params}`); }
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
}

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
function createServer() {
  const srv = new McpServer({ name: "intervals-mcp", version: "6.5.0" });

  srv.tool("get_athlete_profile",
    "Get full athlete profile: demographics, weight, HR zones, pace zones, FTP, VO2max, thresholds. Dumps all available fields.",
    {},
    async () => {
      try {
        const raw  = await callIntervals(`/athlete/${ATHLETE_ID}`);
        const d    = raw.athlete || raw;

        const lines = [
          `👤 PERFIL — ${d.name || d.username || "N/A"}`,
          d.city      ? `📍 ${d.city}` : null,
          d.country   ? `🌍 ${d.country}` : null,
          d.sex       ? `⚧  ${d.sex}` : null,
          d.dob       ? `🎂 DOB: ${d.dob}` : null,
          d.weight    ? `⚖️  Peso: ${d.weight} kg` : null,
          d.height    ? `📐 Altura: ${d.height} cm` : null,
          ``,
          `❤️  UMBRALES`,
          d.maxHR          ? `   FC máxima: ${d.maxHR} bpm` : null,
          d.restingHR      ? `   FC reposo: ${d.restingHR} bpm` : null,
          d.lthr           ? `   LTHR: ${d.lthr} bpm` : null,
          d.ftp            ? `   FTP ciclismo: ${d.ftp} W` : null,
          d.runningFTP     ? `   FTP running: ${d.runningFTP}` : null,
          d.swimFTP        ? `   FTP natación: ${d.swimFTP}` : null,
          d.vo2max         ? `   VO2max: ${d.vo2max}` : null,
          d.lactateThreshold ? `   Lactato: ${d.lactateThreshold}` : null,
        ].filter(v => v != null);

        // HR zones
        const hrZones = d.hrZones || d.heartRateZones || d.zones?.hr || [];
        if (hrZones.length) {
          lines.push(`\n📊 ZONAS FC`);
          hrZones.forEach((z, i) => {
            const from = z.min || z.from || z.low || "";
            const to   = z.max || z.to   || z.high || "";
            lines.push(`   Z${i+1}: ${from}–${to} bpm`);
          });
        }

        // Pace zones
        const paceZones = d.paceZones || d.zones?.pace || [];
        if (paceZones.length) {
          lines.push(`\n🏃 ZONAS RITMO`);
          paceZones.forEach((z, i) => {
            lines.push(`   Z${i+1}: ${z.min || z.from || ""} – ${z.max || z.to || ""} min/km`);
          });
        }

        // Power zones
        const pwrZones = d.powerZones || d.zones?.power || [];
        if (pwrZones.length) {
          lines.push(`\n⚡ ZONAS POTENCIA`);
          pwrZones.forEach((z, i) => {
            lines.push(`   Z${i+1}: ${z.min || z.from || ""}–${z.max || z.to || ""} W`);
          });
        }

        // Dump any extra unknown keys for debugging
        const knownKeys = new Set(["name","username","city","country","sex","dob","weight","height","maxHR","restingHR","lthr","ftp","runningFTP","swimFTP","vo2max","lactateThreshold","hrZones","heartRateZones","paceZones","powerZones","zones","athlete","id"]);
        const extras = Object.entries(d).filter(([k,v]) => !knownKeys.has(k) && v != null && typeof v !== "object");
        if (extras.length) {
          lines.push(`\n📋 OTROS CAMPOS`);
          extras.forEach(([k,v]) => lines.push(`   ${k}: ${v}`));
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_athlete_profile: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_athlete_settings",
    "Get athlete sport settings: HR zones, pace zones, power zones, FTP, thresholds per sport type.",
    {},
    async () => {
      try {
        // Try different endpoints for settings/zones
        let data;
        try {
          data = await callIntervals(`/athlete/${ATHLETE_ID}/config`);
        } catch (_) {
          try {
            data = await callIntervals(`/athlete/${ATHLETE_ID}/sports-settings`);
          } catch (_) {
            data = await callIntervals(`/athlete/${ATHLETE_ID}`);
          }
        }

        if (!data || typeof data !== "object") {
          return { content: [{ type: "text", text: "No settings data available." }] };
        }

        const d = data.athlete || data;
        const lines = [`⚙️ CONFIGURACIÓN DEL ATLETA\n`];

        // HR zones
        const hrZones = d.hrZones || d.heartRateZones || d.hr_zones || [];
        if (hrZones.length) {
          lines.push(`❤️  ZONAS FC`);
          hrZones.forEach((z, i) => {
            const from = z.min ?? z.from ?? z.low ?? "";
            const to   = z.max ?? z.to   ?? z.high ?? "";
            const name = z.name || z.label || `Z${i+1}`;
            lines.push(`   ${name}: ${from}–${to} bpm`);
          });
          lines.push("");
        }

        // Pace zones
        const paceZones = d.paceZones || d.pace_zones || [];
        if (paceZones.length) {
          lines.push(`🏃 ZONAS RITMO`);
          paceZones.forEach((z, i) => {
            lines.push(`   Z${i+1}: ${z.min || z.from || ""}–${z.max || z.to || ""} min/km`);
          });
          lines.push("");
        }

        // FTP / thresholds
        if (d.ftp || d.lthr || d.runningFTP || d.maxHR) {
          lines.push(`📊 UMBRALES`);
          if (d.maxHR)      lines.push(`   FC máxima: ${d.maxHR} bpm`);
          if (d.lthr)       lines.push(`   LTHR: ${d.lthr} bpm`);
          if (d.ftp)        lines.push(`   FTP ciclismo: ${d.ftp} W`);
          if (d.runningFTP) lines.push(`   FTP running: ${d.runningFTP}`);
        }

        if (lines.length <= 2) {
          lines.push(`Campos disponibles: ${Object.keys(d).join(", ")}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_athlete_settings: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_activities",
    "Get recent activities: distance, pace, HR, power, TSS, calories. Returns IDs for get_activity_detail.",
    {
      oldest: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
      newest: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      limit:  z.number().optional().describe("Max results (default: 20)"),
    },
    async ({ oldest, newest, limit = 20 }) => {
      try {
        const range  = safeRange(oldest || daysAgo(30), newest, 60);
        const params = new URLSearchParams({ oldest: range.oldest, newest: range.newest });
        const data   = await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`);
        const acts   = toArray(data, "activities").slice(0, limit);
        if (!acts.length) return { content: [{ type: "text", text: `No activities found (${range.oldest} → ${range.newest}).` }] };
        const lines = acts.map(a => [
          `📅 ${(a.start_date_local || a.date || "").split("T")[0]} — ${a.name || "Activity"} (${a.type || "?"})${a.id ? ` [ID:${a.id}]` : ""}`,
          `   ⏱ ${fmtDuration(a.moving_time || a.movingTime)}`,
          (a.distance > 0) ? `   📏 ${(a.distance / 1000).toFixed(2)} km` : null,
          (a.average_heartrate || a.averageHeartrate) ? `   ❤️  ${fmt0(a.average_heartrate || a.averageHeartrate)} bpm` : null,
          (a.average_speed || a.averageSpeed) ? `   🏃 ${fmtPace(a.average_speed || a.averageSpeed)}` : null,
          (a.total_elevation_gain || a.totalElevationGain) ? `   ⛰️  ${fmt0(a.total_elevation_gain || a.totalElevationGain)} m` : null,
          a.tss      ? `   📊 TSS ${fmt0(a.tss)}` : null,
          a.calories ? `   🔥 ${fmt0(a.calories)} kcal` : null,
          (a.perceived_exertion || a.perceivedExertion) ? `   😓 RPE ${a.perceived_exertion || a.perceivedExertion}/10` : null,
        ].filter(Boolean).join("\n"));
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
      }
    }
  );

  srv.tool("get_activity_detail",
    "Deep detail for any activity (any date): distance, pace, GAP, HR, zones, load, intensity, aerobic decoupling (Pa:HR), efficiency factor, RPE/feel, gear, laps. Use ID from get_activities [ID:xxx].",
    {
      activity_id: z.string().describe("Activity ID e.g. i139521833"),
      compute_decoupling: z.boolean().optional().describe("Calcular desacoplamiento desde streams si intervals no lo da (default: true)"),
    },
    async ({ activity_id, compute_decoupling = true }) => {
      try {
        let a;
        try { a = await fetchActivity(activity_id); } catch (_) { a = null; }
        if (!a || !a.id) {
          // Fallback: buscar en la lista de los últimos 60 días
          const params = new URLSearchParams({ oldest: daysAgo(60), newest: today() });
          const acts = toArray(await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`), "activities");
          a = acts.find(x => String(x.id) === activity_id || String(x.id) === cleanId(activity_id));
        }
        if (!a) return { content: [{ type: "text", text: `⚠️ Actividad ${activity_id} no encontrada.` }] };

        const u  = await getHrZoneUpper();
        const sp = firstDefined(a.average_speed, a.averageSpeed);
        const gap = firstDefined(a.gap, a.icu_gap);
        const load = firstDefined(a.icu_training_load, a.tss);
        const intensity = firstDefined(a.icu_intensity);
        const ef  = firstDefined(a.icu_efficiency_factor, a.efficiency_factor);
        let dec   = firstDefined(a.decoupling, a.icu_decoupling, a.icu_aerobic_decoupling);
        const rpe = firstDefined(a.icu_rpe, a.perceived_exertion, a.perceivedExertion);
        const FEEL = { 1: "Muy fuerte 💪", 2: "Fuerte", 3: "Normal", 4: "Flojo", 5: "Muy flojo 😩" };

        const lines = [
          `📊 ${(a.start_date_local||"").split("T")[0]} — ${a.name||"Activity"} (${a.type||"Run"}) [ID:${a.id}]`,
          ``,
          `📏 MÉTRICAS`,
          `   Distancia:   ${((a.distance||0)/1000).toFixed(2)} km`,
          `   Duración:    ${fmtDuration(a.moving_time||a.movingTime)}`,
          sp  ? `   Ritmo medio: ${fmtPace(sp)}` : null,
          gap ? `   Ritmo GAP (ajustado a pendiente): ${fmtPace(gap)}` : null,
          (a.total_elevation_gain||a.totalElevationGain) ? `   Desnivel+:   ${fmt0(a.total_elevation_gain||a.totalElevationGain)} m (GPS/intervals — contrastar con Garmin)` : null,
          a.calories ? `   Calorías:    ${fmt0(a.calories)} kcal` : null,
          ``,
          `📈 CARGA`,
          load != null ? `   Carga (TSS): ${fmt0(load)}` : null,
          intensity != null ? `   Intensidad:  ${fmt0(intensity)}%` : null,
          a.trimp != null ? `   TRIMP:       ${fmt0(a.trimp)}` : null,
          ``,
          `❤️  FC`,
          (a.average_heartrate||a.averageHeartrate) ? `   Media:  ${fmt0(a.average_heartrate||a.averageHeartrate)} bpm` : null,
          (a.max_heartrate||a.maxHeartrate)         ? `   Máxima: ${fmt0(a.max_heartrate||a.maxHeartrate)} bpm` : null,
        ].filter(v => v != null);

        if (a.average_cadence||a.averageCadence) lines.push(`\n👟 Cadencia: ${fmt0(a.average_cadence||a.averageCadence)} spm`);
        if (a.average_watts||a.averageWatts)     lines.push(`⚡ Potencia: ${fmt0(a.average_watts||a.averageWatts)} W`);

        // Eficiencia aeróbica
        let decDetail = null;
        if (dec == null && compute_decoupling && /run/i.test(a.type || "Run")) {
          try { decDetail = computeDecoupling(await fetchStreams(a.id)); } catch (_) {}
          if (decDetail) dec = decDetail.decoupling;
        }
        if (dec != null || ef != null) {
          lines.push(`\n🫀 EFICIENCIA AERÓBICA`);
          if (dec != null) {
            lines.push(`   Desacoplamiento Pa:HR: ${fmt1(dec)}%${decDetail ? " (calculado desde streams)" : ""}`);
            lines.push(`   ${dec < 5 ? "🟢 <5% — acoplado" : dec < 8 ? "🟡 5-8% — deriva moderada" : "🔴 >8% — deriva alta"}`);
          }
          if (decDetail) lines.push(`   1ª mitad: ${decDetail.first.pace} @ ${decDetail.first.hr} bpm · 2ª mitad: ${decDetail.second.pace} @ ${decDetail.second.hr} bpm`);
          if (ef != null) lines.push(`   Efficiency Factor: ${Number(ef).toFixed(3)}`);
          lines.push(`   (Para un tramo concreto, p.ej. los km a ritmo maratón: get_decoupling con from_km/to_km)`);
        }

        // Sensaciones
        if (rpe != null || a.feel != null) {
          lines.push(`\n😓 SENSACIONES`);
          if (rpe != null)    lines.push(`   RPE: ${rpe}/10`);
          if (a.feel != null) lines.push(`   Feel: ${FEEL[a.feel] || a.feel}`);
        }
        if (a.description) lines.push(`\n📝 ${a.description}`);

        // Material
        const gear = a.gear || a.gear_id;
        if (gear) lines.push(`\n👟 Material: ${gear.name || gear}${gear.distance ? ` (${fmt0(gear.distance/1000)} km acumulados)` : ""}`);

        // Zonas
        const zt = a.icu_hr_zone_times || a.icu_zone_times || [];
        if (zt.length) {
          lines.push(`\n📊 TIEMPO EN ZONAS FC`);
          const zn = zoneLabels(u);
          const tot = zt.slice(0, u.length).reduce((x, y) => x + (y || 0), 0) || 1;
          zt.slice(0, u.length).forEach((sec, i) => { const m = Math.round((sec||0)/60); if (m > 0) lines.push(`   ${zn[i]}: ${m} min (${Math.round((sec||0)/tot*100)}%)`); });
        }

        const laps = a.laps || [];
        if (laps.length) {
          lines.push(`\n🔁 LAPS (${laps.length})`);
          laps.slice(0,20).forEach((l,i) => {
            const lsp = l.average_speed||l.averageSpeed;
            const hr = l.average_heartrate||l.averageHeartrate;
            lines.push(`  ${i+1}: ${((l.distance||0)/1000).toFixed(2)}km | ${fmtDuration(l.moving_time||l.elapsed_time||0)}${lsp?` | ${fmtPace(lsp)}`:""}${hr?` | ${fmt0(hr)}bpm`:""}`);
          });
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_activity_detail: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_activity_streams",
    "Get per-second stream data: HR, cadence, pace, altitude, power. Calculates time in HR zones AND per-km splits.",
    {
      activity_id:  z.string().describe("Activity ID e.g. i139521833"),
      stream_types: z.string().optional().describe("Comma-separated stream types (default: time,heartrate,cadence,velocity_smooth,altitude,distance)"),
      compact: z.boolean().optional().describe("Salida compacta: solo resumen mínimo + splits en una línea por km (ahorra contexto). Default: false"),
    },
    async ({ activity_id, stream_types, compact = false }) => {
      try {
        const cleanId = activity_id.replace(/^i/, "");
        const types   = stream_types || "time,heartrate,cadence,velocity_smooth,altitude,distance,watts";
        const params  = new URLSearchParams({ types });

        let raw;
        try { raw = await callIntervals(`/activity/${activity_id}/streams?${params}`); }
        catch (_) { raw = await callIntervals(`/activity/${cleanId}/streams?${params}`); }

        const streams = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        if (!streams.length) return { content: [{ type: "text", text: "No hay streams para esta actividad." }] };

        const byType = {};
        streams.forEach(s => { if (s.type) byType[s.type] = s.data || []; });

        const availableTypes = streams.map(s => s.type || s.name).join(", ");
        const lines = [`📈 Streams disponibles: ${availableTypes}\n`];

        const time = byType.time || [];
        const hr   = byType.heartrate || byType.heart_rate || [];
        const vel  = byType.velocity_smooth || byType.speed || byType.velocity || [];
        const cad  = byType.cadence || [];
        const alt  = byType.altitude || [];
        const dist = byType.distance || [];
        const pwr  = byType.watts || byType.power || [];

        // ── Modo compacto: una línea por km (km ritmo FC cad) ──────────────
        if (compact && dist.length) {
          const out = [`⏱ ${fmtDuration(time[time.length-1]||0)} · ${((dist[dist.length-1]||0)/1000).toFixed(2)} km`, `km ritmo FC cad`];
          const n = Math.ceil((dist[dist.length-1]||0) / 1000);
          const buckets = Array.from({ length: n }, () => ({ v: [], h: [], c: [] }));
          for (let i = 0; i < dist.length; i++) {
            const k = Math.min(Math.floor((dist[i]||0) / 1000), n - 1);
            if (k < 0) continue;
            if (vel[i] > 0) buckets[k].v.push(vel[i]);
            if (hr[i]  > 0) buckets[k].h.push(hr[i]);
            if (cad[i] > 0) buckets[k].c.push(cad[i]);
          }
          buckets.forEach((b, k) => {
            if (!b.v.length && !b.h.length) return;
            out.push(`${k+1} ${b.v.length ? fmtPace(mean(b.v)).replace(" min/km","") : "-"} ${b.h.length ? Math.round(mean(b.h)) : "-"} ${b.c.length ? Math.round(mean(b.c)) : "-"}`);
          });
          return { content: [{ type: "text", text: out.join("\n") }] };
        }

        if (time.length) lines.push(`⏱ ${time.length} puntos · duración ${fmtDuration(time[time.length-1]||0)}`);

        // ── Global HR summary ──────────────────────────────────────────────
        if (hr.length) {
          const v = hr.filter(x => x > 0);
          if (v.length) {
            const avg = Math.round(v.reduce((a,b)=>a+b,0)/v.length);
            const max = Math.max(...v), min = Math.min(...v);
            lines.push(`\n❤️  FRECUENCIA CARDÍACA`);
            lines.push(`   Media: ${avg} bpm | Máx: ${max} bpm | Mín: ${min} bpm`);
            const u = await getHrZoneUpper();
            const z = new Array(u.length).fill(0);
            v.forEach(x => { z[zoneOf(x, u)]++; });
            const tot = v.length;
            const zn  = zoneLabels(u);
            z.forEach((c, i) => {
              const pct  = Math.round(c/tot*100);
              const mins = Math.round(c/60);
              if (pct > 0) lines.push(`   ${zn[i]}: ${pct}% (~${mins} min)`);
            });
          }
        }

        if (vel.length) {
          const v = vel.filter(x => x > 0);
          if (v.length) {
            const avg  = v.reduce((a,b)=>a+b,0)/v.length;
            const best = fmtPace(Math.max(...v));
            lines.push(`\n🏃 RITMO`);
            lines.push(`   Medio: ${fmtPace(avg)}`);
            if (best) lines.push(`   Mejor momento: ${best}`);
          }
        }

        if (cad.length) {
          const v = cad.filter(x => x > 0);
          if (v.length) {
            lines.push(`\n👟 CADENCIA`);
            lines.push(`   Media: ${Math.round(v.reduce((a,b)=>a+b,0)/v.length)} spm | Máx: ${Math.max(...v)} spm`);
          }
        }

        if (alt.length) {
          const max = Math.round(Math.max(...alt));
          const min = Math.round(Math.min(...alt));
          lines.push(`\n⛰️  ALTITUD: máx ${max} m | mín ${min} m | desnivel acum: ${max - min} m`);
        }

        if (pwr.length) {
          const v = pwr.filter(x => x > 0);
          if (v.length) {
            lines.push(`\n⚡ POTENCIA: media ${Math.round(v.reduce((a,b)=>a+b,0)/v.length)} W | máx ${Math.max(...v)} W`);
          }
        }

        // ── Per-km splits ──────────────────────────────────────────────────
        if (dist.length && (hr.length || vel.length)) {
          const totalDist = dist[dist.length - 1] || 0;
          const numKm     = Math.floor(totalDist / 1000);

          if (numKm >= 1) {
            lines.push(`\n📊 SPLITS POR KILÓMETRO`);
            lines.push(`  ${"Km".padEnd(4)} ${"Ritmo".padEnd(9)} ${"FC".padEnd(7)} ${"Cad".padEnd(6)} Desnivel`);
            lines.push(`  ${"─".repeat(42)}`);

            for (let km = 1; km <= numKm; km++) {
              const fromM = (km - 1) * 1000;
              const toM   = km * 1000;

              // Get indices for this km band
              const idx = [];
              dist.forEach((d, i) => { if (d >= fromM && d < toM) idx.push(i); });

              if (!idx.length) continue;

              // Average pace (velocity → min/km)
              let paceStr = "   -  ";
              if (vel.length) {
                const vv = idx.map(i => vel[i]).filter(x => x > 0);
                if (vv.length) paceStr = fmtPace(vv.reduce((a,b)=>a+b,0)/vv.length);
              }

              // Average HR
              let hrStr = "  -  ";
              if (hr.length) {
                const hv = idx.map(i => hr[i]).filter(x => x > 0);
                if (hv.length) hrStr = `${Math.round(hv.reduce((a,b)=>a+b,0)/hv.length)} bpm`;
              }

              // Average cadence
              let cadStr = "  - ";
              if (cad.length) {
                const cv = idx.map(i => cad[i]).filter(x => x > 0);
                if (cv.length) cadStr = `${Math.round(cv.reduce((a,b)=>a+b,0)/cv.length)} spm`;
              }

              // Elevation gain/loss for this km
              let elevStr = "";
              if (alt.length) {
                const av   = idx.map(i => alt[i]);
                const gain = Math.max(0, Math.round(av[av.length-1] - av[0]));
                const loss = Math.max(0, Math.round(av[0] - av[av.length-1]));
                if (gain > 0) elevStr = `↑${gain}m`;
                if (loss > 0) elevStr += `${elevStr ? " " : ""}↓${loss}m`;
              }

              lines.push(`  ${String(km).padEnd(4)} ${paceStr.padEnd(9)} ${hrStr.padEnd(7)} ${cadStr.padEnd(6)} ${elevStr}`);
            }

            // Partial last km if any
            const remainM = totalDist - numKm * 1000;
            if (remainM > 50) {
              const fromM = numKm * 1000;
              const idx   = [];
              dist.forEach((d, i) => { if (d >= fromM) idx.push(i); });
              if (idx.length) {
                let paceStr = "   -  ";
                if (vel.length) {
                  const vv = idx.map(i => vel[i]).filter(x => x > 0);
                  if (vv.length) paceStr = fmtPace(vv.reduce((a,b)=>a+b,0)/vv.length);
                }
                let hrStr = "  -  ";
                if (hr.length) {
                  const hv = idx.map(i => hr[i]).filter(x => x > 0);
                  if (hv.length) hrStr = `${Math.round(hv.reduce((a,b)=>a+b,0)/hv.length)} bpm`;
                }
                lines.push(`  ${(numKm + 1 + "*").padEnd(4)} ${paceStr.padEnd(9)} ${hrStr.padEnd(7)} (${Math.round(remainM)}m parcial)`);
              }
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_activity_streams: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_activity_intervals",
    "Get detailed interval/lap data for an activity: pace, HR, power, cadence per interval. Best tool for analyzing series and structured workouts.",
    { activity_id: z.string().describe("Activity ID e.g. i139521833") },
    async ({ activity_id }) => {
      try {
        const cleanId = activity_id.replace(/^i/, "");
        let raw;
        try { raw = await callIntervals(`/activity/${activity_id}/intervals`); }
        catch (_) { raw = await callIntervals(`/activity/${cleanId}/intervals`); }

        if (!raw || typeof raw !== "object") {
          return { content: [{ type: "text", text: "No hay datos de intervalos para esta actividad." }] };
        }

        const intervals = raw.icu_intervals || [];
        const groups    = raw.icu_groups    || [];

        if (!intervals.length && !groups.length) {
          return { content: [{ type: "text", text: `No se encontraron intervalos. Campos disponibles: ${Object.keys(raw).join(", ")}` }] };
        }

        const lines = [`🔁 INTERVALOS (${intervals.length} total)\n`];

        intervals.forEach((iv, i) => {
          const label    = iv.label || iv.name || `Intervalo ${i+1}`;
          const dist     = iv.distance ? `${(iv.distance/1000).toFixed(2)} km` : null;
          const dur      = iv.moving_time || iv.elapsed_time || iv.timer_time;
          const pace     = iv.average_speed || iv.avg_speed;
          const hr       = iv.average_heartrate || iv.avg_hr;
          const maxHr    = iv.max_heartrate || iv.max_hr;
          const watts    = iv.average_watts || iv.avg_watts;
          const cadence  = iv.average_cadence || iv.avg_cadence;
          const type     = iv.type || "";

          const parts = [
            `${i+1}. ${label}${type ? ` [${type}]` : ""}`,
            dist ? `   📏 ${dist}` : null,
            dur  ? `   ⏱ ${fmtDuration(dur)}` : null,
            pace ? `   🏃 ${fmtPace(pace)}` : null,
            hr   ? `   ❤️  FC media: ${fmt0(hr)} bpm${maxHr ? ` | máx: ${fmt0(maxHr)} bpm` : ""}` : null,
            watts   ? `   ⚡ ${fmt0(watts)} W` : null,
            cadence ? `   👟 ${fmt0(cadence)} spm` : null,
          ].filter(Boolean);

          lines.push(parts.join("\n"));
        });

        // Groups (series agrupadas)
        if (groups.length) {
          lines.push(`\n📊 GRUPOS/SERIES (${groups.length})`);
          groups.forEach((g, i) => {
            const count = g.count || g.reps || "";
            const name  = g.name || g.label || `Grupo ${i+1}`;
            lines.push(`  ${i+1}. ${name}${count ? ` × ${count}` : ""}`);
          });
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_activity_intervals: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_wellness",
    "Get wellness data: HRV, resting HR, sleep, weight, steps, calories, stress, SpO2, Body Battery, fatigue, mood, motivation, soreness",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 14 days ago)"),
      end_date:   z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    },
    async ({ start_date, end_date }) => {
      try {
        const range  = safeRange(start_date || daysAgo(14), end_date, 180);
        const params = new URLSearchParams({ oldest: range.oldest, newest: range.newest });
        const data   = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
        // No filter — show all entries that have ANY non-null value
        const entries = toArray(data, "wellness").filter(w =>
          Object.values(w).some(v => v != null && v !== w.id)
        );
        if (!entries.length) return { content: [{ type: "text", text: "No wellness data in range." }] };

        // Known display fields
        const lines = entries.map(w => {
          const known = [
            `📅 ${w.id}`,
            w.hrv          ? `   💓 HRV: ${w.hrv}` : null,
            w.restingHR    ? `   ❤️  FC reposo: ${w.restingHR} bpm` : null,
            w.sleepSecs    ? `   😴 Sueño: ${fmtSleep(w.sleepSecs)}` : null,
            w.vo2max       ? `   🫁 VO2max: ${w.vo2max}` : null,
            w.sleepScore   ? `   💤 Calidad sueño: ${w.sleepScore}/100` : null,
            w.sleepQuality != null ? `   💤 Calidad (1-5): ${w.sleepQuality}/5` : null,
            w.steps        ? `   👣 Pasos: ${w.steps.toLocaleString()}` : null,
            w.calories     ? `   🔥 Calorías: ${w.calories} kcal` : null,
            w.weight       ? `   ⚖️  Peso: ${w.weight} kg` : null,
            w.vo2max       ? `   🫁 VO2max: ${w.vo2max}` : null,
            w.rampRate     != null ? `   📈 Ramp rate CTL: ${Number(w.rampRate).toFixed(2)}/semana` : null,
            w.bodyBattery  ? `   🔋 Body Battery: ${w.bodyBattery}` : null,
            w.avgBodyBattery ? `   🔋 Body Battery media: ${w.avgBodyBattery}` : null,
            w.stress       ? `   😰 Estrés: ${w.stress}` : null,
            w.avgStress    ? `   😰 Estrés medio: ${w.avgStress}` : null,
            w.spO2         ? `   🫁 SpO2: ${w.spO2}%` : null,
            w.respiration  ? `   💨 Respiración: ${w.respiration} rpm` : null,
            w.menstrualCyclePhase ? `   🔴 Ciclo: ${w.menstrualCyclePhase}` : null,
            w.fatigue      != null ? `   😩 Fatiga: ${w.fatigue}/10` : null,
            w.mood         != null ? `   😊 Ánimo: ${w.mood}/10` : null,
            w.motivation   != null ? `   🔥 Motivación: ${w.motivation}/10` : null,
            w.soreness     != null ? `   💪 Agujetas: ${w.soreness}/10` : null,
            w.notes        ? `   📝 ${w.notes}` : null,
          ].filter(Boolean);

          // Dump any extra fields not in the known list
          const knownKeys = new Set(["id","hrv","restingHR","sleepSecs","sleepScore","sleepQuality","steps","calories","weight","vo2max","rampRate","ctlLoad","atlLoad","sportInfo","bodyBattery","avgBodyBattery","stress","avgStress","spO2","respiration","fatigue","mood","motivation","soreness","notes","ctl","atl","tsb","menstrualCyclePhase","updated","tempWeight","tempRestingHR"]);
          const extras = Object.entries(w)
            .filter(([k, v]) => !knownKeys.has(k) && v != null)
            .map(([k, v]) => `   📌 ${k}: ${v}`);
          if (extras.length) known.push(...extras);

          return known.join("\n");
        });
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_wellness: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_wellness_raw",
    "Dump ALL raw fields from a single wellness entry to discover available data. Use to debug missing fields like VO2max.",
    { date: z.string().optional().describe("Date YYYY-MM-DD (default: today)") },
    async ({ date }) => {
      try {
        const d      = date || today();
        const params = new URLSearchParams({ oldest: d, newest: d });
        const data   = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
        const entries = toArray(data, "wellness");
        if (!entries.length) return { content: [{ type: "text", text: `No wellness entry for ${d}` }] };
        const entry = entries[0];
        const lines = [`🔍 RAW WELLNESS — ${entry.id}\n`];
        Object.entries(entry)
          .filter(([, v]) => v != null)
          .forEach(([k, v]) => lines.push(`  ${k}: ${JSON.stringify(v)}`));
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_wellness_raw: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_fitness",
    "Get CTL (fitness), ATL (fatigue), TSB (form) training load curves. TSB = CTL - ATL.",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 42 days ago)"),
      end_date:   z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    },
    async ({ start_date, end_date }) => {
      try {
        const range  = safeRange(start_date || daysAgo(42), end_date, 180);
        const params = new URLSearchParams({ oldest: range.oldest, newest: range.newest });
        const data   = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
        const entries = toArray(data, "wellness");
        const withLoad = entries.filter(d => d.ctl != null || d.atl != null);
        if (!withLoad.length) {
          const sample = entries[entries.length - 1] || {};
          return { content: [{ type: "text", text: `⚠️ No CTL/ATL data. Campos disponibles: ${Object.keys(sample).join(", ")}` }] };
        }
        const latest = withLoad[withLoad.length - 1];
        // TSB = CTL - ATL (calculate if not in API response)
        const tsbLatest = latest.tsb != null ? latest.tsb : (latest.ctl != null && latest.atl != null ? latest.ctl - latest.atl : null);
        const header = [
          `📊 CARGA DE ENTRENAMIENTO`,
          `Último dato (${latest.id}):`,
          `   CTL (Forma crónica): ${fmt1(latest.ctl)}`,
          `   ATL (Fatiga aguda):  ${fmt1(latest.atl)}`,
          `   TSB (Frescura):      ${tsbLatest != null ? fmt1(tsbLatest) : "N/A"}`,
          latest.rampRate != null ? `   Ramp rate:           ${Number(latest.rampRate).toFixed(2)}/semana` : null,
          tsbLatest != null ? `   Estado: ${tsbLatest > 5 ? "🟢 Fresco" : tsbLatest > -10 ? "🟡 Óptimo" : tsbLatest > -25 ? "🟠 Cansado" : "🔴 Sobreentrenamiento"}` : null,
          `\nÚltimos ${Math.min(withLoad.length, 14)} días:`,
        ].filter(Boolean).join("\n");

        const rows = withLoad.slice(-14).map(d => {
          const tsb = d.tsb != null ? d.tsb : (d.ctl != null && d.atl != null ? d.ctl - d.atl : null);
          return `  ${d.id}  CTL ${fmt1(d.ctl).padStart(5)}  ATL ${fmt1(d.atl).padStart(5)}  TSB ${tsb != null ? fmt1(tsb).padStart(6) : "   N/A"}`;
        });

        return { content: [{ type: "text", text: header + "\n" + rows.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_fitness: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_weekly_stats",
    "Weekly training totals: km, duration, sessions, TSS, calories per week.",
    { weeks: z.number().optional().describe("Weeks to look back (default: 8, max: 12)") },
    async ({ weeks = 8 }) => {
      try {
        const w      = Math.min(weeks, 12);
        const params = new URLSearchParams({ oldest: daysAgo(w * 7), newest: today() });
        const data   = await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`);
        const acts   = toArray(data, "activities");
        if (!acts.length) return { content: [{ type: "text", text: "No activities found." }] };
        const map = {};
        for (const a of acts) {
          const ds = (a.start_date_local || a.date || "").split("T")[0];
          if (!ds) continue;
          const d = new Date(ds), day = d.getDay();
          const mon = new Date(d);
          mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
          const key = mon.toISOString().split("T")[0];
          if (!map[key]) map[key] = { sessions: 0, distance: 0, duration: 0, tss: 0, calories: 0 };
          map[key].sessions++;
          map[key].distance += a.distance || 0;
          map[key].duration += a.moving_time || a.movingTime || 0;
          map[key].tss      += a.tss || 0;
          map[key].calories += a.calories || 0;
        }
        const sorted = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
        const lines  = [`📊 WEEKLY STATS (${w} semanas)\n${"─".repeat(40)}`];
        for (const [week, s] of sorted) {
          lines.push([
            `📅 Semana ${week}`,
            `   🏃 ${s.sessions} sesiones  📏 ${(s.distance/1000).toFixed(1)} km  ⏱ ${fmtDuration(s.duration)}`,
            s.tss > 0      ? `   📊 TSS: ${fmt0(s.tss)}` : null,
            s.calories > 0 ? `   🔥 ${fmt0(s.calories)} kcal` : null,
          ].filter(Boolean).join("\n"));
        }
        const avgKm  = sorted.reduce((s,[,w]) => s + w.distance, 0) / sorted.length / 1000;
        const avgSes = sorted.reduce((s,[,w]) => s + w.sessions, 0) / sorted.length;
        lines.push(`\n📈 Media: ${avgKm.toFixed(1)} km/semana · ${avgSes.toFixed(1)} sesiones/semana`);
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
      }
    }
  );

  srv.tool("get_events",
    "Get planned workouts and events from the intervals.icu calendar",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: today)"),
      end_date:   z.string().optional().describe("End date YYYY-MM-DD (default: 21 days ahead)"),
    },
    async ({ start_date, end_date }) => {
      try {
        const params = new URLSearchParams({ oldest: start_date || today(), newest: end_date || daysAhead(21) });
        const data   = await callIntervals(`/athlete/${ATHLETE_ID}/events?${params}`);
        const events = toArray(data, "events");
        if (!events.length) return { content: [{ type: "text", text: "No planned events." }] };
        const lines = events.map(e => [
          `📅 ${(e.start_date_local || e.date || "").split("T")[0]} — ${e.name || "Event"} (${e.type || e.category || "Event"}) [ID:${e.id}]`,
          e.description ? `   📝 ${e.description}` : null,
          e.load        ? `   📊 Carga objetivo: ${e.load}` : null,
          e.moving_time ? `   ⏱ Duración: ${fmtDuration(e.moving_time)}` : null,
          e.distance    ? `   📏 Distancia: ${(e.distance/1000).toFixed(1)} km` : null,
        ].filter(Boolean).join("\n"));
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_events: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_event_by_id",
    "Get full details of a specific calendar event or planned workout by its ID.",
    { event_id: z.string().describe("Event ID (shown as [ID:xxx] in get_events)") },
    async ({ event_id }) => {
      try {
        const data = await callIntervals(`/athlete/${ATHLETE_ID}/events/${event_id}`);
        if (!data || typeof data !== "object") {
          return { content: [{ type: "text", text: `No event found with ID ${event_id}` }] };
        }
        const e = Array.isArray(data) ? data[0] : data;
        const lines = [
          `📅 EVENTO: ${(e.start_date_local || e.date || "").split("T")[0]} — ${e.name || "Event"}`,
          e.type || e.category ? `   Tipo: ${e.type || e.category}` : null,
          e.description        ? `   📝 ${e.description}` : null,
          e.load               ? `   📊 Carga objetivo: ${e.load}` : null,
          e.moving_time        ? `   ⏱ Duración: ${fmtDuration(e.moving_time)}` : null,
          e.distance           ? `   📏 Distancia: ${(e.distance/1000).toFixed(1)} km` : null,
          e.pace_target        ? `   🏃 Ritmo objetivo: ${e.pace_target}` : null,
          e.hr_target          ? `   ❤️  FC objetivo: ${e.hr_target}` : null,
          e.id                 ? `   🆔 ID: ${e.id}` : null,
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_event_by_id: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_records",
    "Get athlete personal records. Note: not available on FREE plan of intervals.icu.",
    {},
    async () => {
      return { content: [{ type: "text", text: "⚠️ El endpoint de récords no está disponible en el plan FREE de intervals.icu." }] };
    }
  );

  srv.tool("get_training_load",
    "Get detailed training load history: CTL, ATL, TSB, rampRate, fitness trend over the last months.",
    {
      weeks: z.number().optional().describe("Weeks of history (default: 16, max: 52)"),
    },
    async ({ weeks = 16 }) => {
      try {
        const safeWeeks = Math.min(weeks, 52);
        const params = new URLSearchParams({ oldest: daysAgo(safeWeeks * 7), newest: today() });
        const data   = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
        const entries = toArray(data, "wellness").filter(d => d.ctl != null || d.atl != null);
        if (!entries.length) return { content: [{ type: "text", text: "No training load data." }] };

        // Weekly summary of load
        const weeks_map = {};
        entries.forEach(d => {
          const dt  = new Date(d.id);
          const day = dt.getDay();
          const mon = new Date(dt);
          mon.setDate(dt.getDate() + (day === 0 ? -6 : 1 - day));
          const key = mon.toISOString().split("T")[0];
          if (!weeks_map[key]) weeks_map[key] = { entries: [] };
          weeks_map[key].entries.push(d);
        });

        const latest = entries[entries.length - 1];
        const tsbNow = latest.tsb != null ? latest.tsb : (latest.ctl - latest.atl);
        const lines = [
          `📊 CARGA DE ENTRENAMIENTO — ${safeWeeks} semanas`,
          ``,
          `Hoy (${latest.id}):`,
          `   CTL: ${fmt1(latest.ctl)} | ATL: ${fmt1(latest.atl)} | TSB: ${fmt1(tsbNow)}`,
          `   Estado: ${tsbNow > 5 ? "🟢 Fresco" : tsbNow > -10 ? "🟡 Óptimo" : tsbNow > -25 ? "🟠 Cansado" : "🔴 Sobreentrenamiento"}`,
          ``,
          `Tendencia semanal (fin de semana):`,
        ];

        Object.entries(weeks_map)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .forEach(([weekStart, { entries: wEntries }]) => {
            const last = wEntries[wEntries.length - 1];
            const tsb  = last.tsb != null ? last.tsb : (last.ctl - last.atl);
            const trend = tsb > 5 ? "🟢" : tsb > -10 ? "🟡" : tsb > -25 ? "🟠" : "🔴";
            lines.push(`  ${weekStart}  CTL ${fmt1(last.ctl).padStart(5)}  ATL ${fmt1(last.atl).padStart(5)}  TSB ${fmt1(tsb).padStart(6)} ${trend}`);
          });

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_training_load: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_sport_settings",
    "Get running sport settings: HR zones, pace zones, Critical Speed (CS), D prime, threshold pace.",
    {},
    async () => {
      try {
        const data    = await callIntervals(`/athlete/${ATHLETE_ID}/sport-settings`);
        const configs = Array.isArray(data) ? data : [data];

        // Find running config
        const runCfg = pickRunConfig(configs);

        const lines = [`⚙️ CONFIGURACIÓN RUNNING\n`];

        // If no running config, show what exists and calculate from known CS
        if (!runCfg) {
          const allTypes = configs.map((c, i) => `  Config ${i+1}: ${(c.types||[]).join(", ")}`).join("\n");
          lines.push(`ℹ️  No hay config de running en la API. Configs encontradas:\n${allTypes}\n`);
        }

        // Get threshold pace — from running config or fallback to any config with it
        const anyWithPace = configs.find(c => c.threshold_pace);
        const cs_source   = runCfg?.threshold_pace || anyWithPace?.threshold_pace || null;
        const lthr        = runCfg?.lthr || configs[0]?.lthr || null;
        const maxHR       = runCfg?.max_hr || configs[0]?.max_hr || null;
        const wPrime      = runCfg?.w_prime || null;

        lines.push(`🎯 UMBRALES`);
        if (lthr)      lines.push(`   LTHR: ${lthr} bpm`);
        if (maxHR)     lines.push(`   FC máxima: ${maxHR} bpm`);
        if (cs_source) lines.push(`   CS / Ritmo umbral: ${cs_source}`);
        if (wPrime)    lines.push(`   D': ${wPrime} m`);
        lines.push("");

        // Calculate pace zones from CS
        // Percentages from intervals.icu standard model confirmed from user's settings
        const PACE_ZONES = [
          { name: "Z1 (Recovery)",    pctMin: 0,     pctMax: 77.5  },
          { name: "Z2 (Endurance)",   pctMin: 78.5,  pctMax: 87.7  },
          { name: "Z3 (Tempo)",       pctMin: 88.7,  pctMax: 94.3  },
          { name: "Z4 (Threshold)",   pctMin: 95.3,  pctMax: 100   },
          { name: "Z5a (VO2max)",     pctMin: 101,   pctMax: 103.4 },
          { name: "Z5b (Anaerobic)",  pctMin: 104.4, pctMax: 111.5 },
          { name: "Z5c (Sprint)",     pctMin: 112.5, pctMax: 999   },
        ];

        // Parse CS — intervals stores threshold_pace as m/s (e.g. 4.0650406 = 4:06/km)
        const parseCS = (cs) => {
          if (!cs) return null;
          const val = parseFloat(String(cs));
          if (isNaN(val)) return null;
          // If value > 20, assume it's already in seconds/km — unlikely for running
          // If value < 20, it's m/s → convert to seconds/km
          if (val > 0 && val < 20) {
            return 1000 / val; // seconds per km
          }
          return val; // already in seconds/km
        };

        const secPerKm = (secs) => {
          const m = Math.floor(secs / 60);
          const s = Math.round(secs % 60);
          return `${m}:${String(s).padStart(2, "0")}`;
        };

        const csSource = runCfg?.threshold_pace || anyWithPace?.threshold_pace;
        const csSecs   = parseCS(csSource);

        if (csSecs) {
          lines.push(`🏃 ZONAS RITMO (calculadas desde CS = ${csSource})`);
          PACE_ZONES.forEach(z => {
            const fast = z.pctMax >= 999 ? "<" + secPerKm(csSecs / 1.125) : secPerKm(csSecs / (z.pctMax / 100));
            const slow = z.pctMin === 0 ? ">" + secPerKm(csSecs / 0.775) : secPerKm(csSecs / (z.pctMin / 100));
            if (z.pctMin === 0) {
              lines.push(`   ${z.name}: >${secPerKm(csSecs / (z.pctMax/100))} min/km`);
            } else if (z.pctMax >= 999) {
              lines.push(`   ${z.name}: <${secPerKm(csSecs / (z.pctMin/100))} min/km`);
            } else {
              lines.push(`   ${z.name}: ${secPerKm(csSecs / (z.pctMax/100))}–${secPerKm(csSecs / (z.pctMin/100))} min/km`);
            }
          });
        } else {
          lines.push(`🏃 ZONAS RITMO: CS no disponible en API.`);
          lines.push(`   Para activarlas: intervals.icu → Settings → Deportes → Running → Ritmo umbral`);
        }
        lines.push("");

        // Running HR zones — calculated from LTHR (same model as intervals.icu UI)
        // Confirmed from user's settings: Z1 0-133, Z2 134-148, Z3 149-163, Z4 164-178, Z5 179+
        const HR_ZONES = [
          { name: "Z1 Recovery",    pctMax: 0.76  },
          { name: "Z2 Endurance",   pctMax: 0.85  },
          { name: "Z3 Tempo",       pctMax: 0.93  },
          { name: "Z4 Threshold",   pctMax: 1.02  },
          { name: "Z5 Interval",    pctMax: 99    },
        ];
        const lthrVal = lthr || runCfg?.lthr || configs[0]?.lthr;
        if (Array.isArray(runCfg?.hr_zones) && runCfg.hr_zones.length) {
          lines.push(`\n❤️  ZONAS FC CONFIGURADAS EN INTERVALS (las que usan todos los análisis)`);
          zoneLabels(runCfg.hr_zones.map(Number)).forEach(l => lines.push(`   ${l} bpm`));
        }
        if (lthrVal) {
          lines.push(`\n❤️  ZONAS FC TEÓRICAS (calculadas desde LTHR = ${lthrVal} bpm, modelo 5 zonas)`);
          let prev = 0;
          HR_ZONES.forEach(z => {
            const upper = z.pctMax >= 99 ? maxHR || 193 : Math.round(lthrVal * z.pctMax);
            lines.push(`   ${z.name}: ${prev === 0 ? 0 : prev + 1}–${upper} bpm`);
            prev = upper;
          });
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_sport_settings: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_performance_data",
    "Get performance data: Critical Speed (CS), D prime, pace zones from running settings.",
    { sport: z.string().optional().describe("Sport: Run, Ride (default: Run)") },
    async ({ sport = "Run" }) => {
      try {
        const data    = await callIntervals(`/athlete/${ATHLETE_ID}/sport-settings`);
        const configs = Array.isArray(data) ? data : [data];
        const runCfg  = pickRunConfig(configs);
        const cfg     = runCfg || configs[0];

        const cs    = cfg?.threshold_pace;
        const wPrime= cfg?.w_prime;
        const lthr  = cfg?.lthr;

        const lines = [`📈 DATOS DE RENDIMIENTO — ${sport}\n`];

        if (cs) {
          const csSecs = 1000 / parseFloat(cs); // threshold_pace viene en m/s
          const mins   = Math.floor(csSecs / 60);
          const secs   = Math.round(csSecs % 60);
          lines.push(`🎯 Velocidad Crítica (CS): ${mins}:${String(secs).padStart(2,"0")} min/km`);
          lines.push(`   (valor API: ${cs} m/s)`);
        } else {
          lines.push(`🎯 CS: no configurado en la API`);
        }
        if (wPrime) lines.push(`🔋 D' (W'): ${wPrime} m`);
        if (lthr)   lines.push(`❤️  LTHR: ${lthr} bpm`);
        lines.push(`\nℹ️  Mejores marcas por distancia y predicción: usar get_best_efforts.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_performance_data: ${err.message}` }] };
      }
    }
  );

  srv.tool("create_event",
    "Create a workout or event in the intervals.icu calendar. Supports structured workouts with steps.",
    {
      date:          z.string().describe("Date YYYY-MM-DD"),
      name:          z.string().describe("Workout name"),
      type:          z.string().optional().describe("Run, Ride, Swim, WeightTraining, Rest (default: Run)"),
      description:   z.string().optional().describe("Workout description text"),
      load:          z.number().optional().describe("Target TSS/load"),
      duration_mins: z.number().optional().describe("Planned duration in minutes"),
      steps:         z.string().optional().describe("JSON array of workout steps. Each step: {type: 'warmup'|'steady'|'cooldown'|'rest', distance_m?: number, duration_secs?: number, pace_min?: number, pace_max?: number} where pace is seconds/km. E.g. '[{\"type\":\"warmup\",\"distance_m\":4000,\"pace_min\":300,\"pace_max\":330},{\"type\":\"steady\",\"distance_m\":11000,\"pace_min\":260,\"pace_max\":265},{\"type\":\"cooldown\",\"distance_m\":1000,\"pace_min\":340,\"pace_max\":360}]'"),
    },
    async ({ date, name, type = "Run", description, load, duration_mins, steps }) => {
      try {
        // Set correct start time: Saturday = 09:00, weekdays = 19:00
        const startTime = dayOfWeek(date) === 6 ? "09:00:00" : "19:00:00";
        const body = {
          start_date_local: `${date}T${startTime}`,
          name, type,
          category: "WORKOUT",
          description: description || "",
          ...(load          && { load }),
          ...(duration_mins && { moving_time: duration_mins * 60 }),
        };

        // Build structured workout doc if steps provided
        if (steps) {
          try {
            const parsedSteps = JSON.parse(steps);

            // intervals.icu workout_doc format
            const workoutSteps = parsedSteps.map((s) => {
              const step = {
                type: s.type === "warmup"   ? "Warmup"
                     : s.type === "cooldown" ? "Cooldown"
                     : s.type === "rest"     ? "Rest"
                     : "SteadyState",
              };

              // Length by distance or duration
              if (s.distance_m)    step.length = { value: s.distance_m, unit: "m" };
              else if (s.duration_secs) step.length = { value: s.duration_secs, unit: "s" };

              // Pace targets (seconds/km)
              if (s.pace_min || s.pace_max) {
                step.pace = {};
                if (s.pace_min) step.pace.minSecs = s.pace_min;
                if (s.pace_max) step.pace.maxSecs = s.pace_max;
              }

              return step;
            });

            body.icu_workout_doc = { steps: workoutSteps };
          } catch (e) {
            // If steps parsing fails, continue without structured workout
          }
        }

        const data = await callIntervals(`/athlete/${ATHLETE_ID}/events`, "POST", body);
        const id   = data.id || "ok";
        // intervals ignora a veces la duración al crear sesiones de fuerza → se fija con un PUT
        if (data.id && duration_mins && /weight|strength/i.test(type)) {
          try { await callIntervals(`/athlete/${ATHLETE_ID}/events/${data.id}`, "PUT", { moving_time: duration_mins * 60 }); } catch (_) {}
        }
        const hasStructure = !!body.icu_workout_doc;
        return { content: [{ type: "text", text: `✅ ${date} — ${name} (${type}) [ID:${id}]${hasStructure ? " · con estructura de pasos" : ""}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ create_event: ${err.message}` }] };
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

  // ═══════════════════════════════════════════════════════════════════════════
  // v5 — HERRAMIENTAS NUEVAS
  // ═══════════════════════════════════════════════════════════════════════════

  srv.tool("get_daily_briefing",
    "ONE-CALL morning report: today's HRV vs 30-day baseline (mean ± SD), resting HR, sleep (Xh XXmin), CTL/ATL/TSB, ramp rate, today's and tomorrow's planned workouts, last activity, week-to-date km, and automatic alerts. Use this instead of calling wellness+fitness+events+activities separately.",
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
        const L = [`☀️ INFORME — ${d}`, ``, `💓 RECUPERACIÓN`];
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

        const events = toArray(evData, "events");
        const evLine = (e) => `   • ${e.name || "Evento"} (${e.type || e.category || "?"})${e.moving_time ? ` · ${fmtDuration(e.moving_time)}` : ""}${e.distance ? ` · ${(e.distance/1000).toFixed(1)} km` : ""} [ID:${e.id}]${e.description ? `\n${e.description.split("\n").map(x => `     ${x}`).join("\n")}` : ""}`;
        const evToday = events.filter(e => (e.start_date_local || "").startsWith(d));
        const evTom   = events.filter(e => (e.start_date_local || "").startsWith(addDays(d, 1)));
        L.push(``, `📅 HOY`);
        L.push(evToday.length ? evToday.map(evLine).join("\n") : `   Sin entrenamiento planificado`);
        L.push(`📅 MAÑANA`);
        L.push(evTom.length ? evTom.map(e => `   • ${e.name || "Evento"} (${e.type || e.category || "?"})`).join("\n") : `   Sin entrenamiento planificado`);

        const acts = toArray(actData, "activities").sort((a, b) => String(b.start_date_local).localeCompare(String(a.start_date_local)));
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

  srv.tool("get_decoupling",
    "Aerobic decoupling (Pa:HR) for a whole run or a specific km segment (e.g. the marathon-pace block of a long run). Compares efficiency (speed/HR) between the two halves. <5% = coupled, 5-8% moderate drift, >8% high drift.",
    {
      activity_id: z.string().describe("Activity ID e.g. i139521833"),
      from_km: z.number().optional().describe("Inicio del tramo en km (ej: 20)"),
      to_km:   z.number().optional().describe("Fin del tramo en km (ej: 30)"),
    },
    async ({ activity_id, from_km, to_km }) => {
      try {
        const st = await fetchStreams(activity_id, "time,heartrate,velocity_smooth,distance");
        const r = computeDecoupling(st, from_km != null ? from_km * 1000 : null, to_km != null ? to_km * 1000 : null);
        if (!r) return { content: [{ type: "text", text: "⚠️ No hay datos suficientes de FC/ritmo en ese tramo (mínimo ~10 min)." }] };
        const L = [
          `🫀 DESACOPLAMIENTO Pa:HR — ${activity_id}${r.km ? ` · tramo ${r.km}` : ""}`,
          `   1ª mitad: ${r.first.pace} @ ${r.first.hr} bpm`,
          `   2ª mitad: ${r.second.pace} @ ${r.second.hr} bpm`,
          `   Desacoplamiento: ${fmt1(r.decoupling)}%`,
          `   ${r.rating}`,
        ];
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_decoupling: ${err.message}` }] };
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
        const parts = [rpe != null && `RPE ${rpe}`, feel != null && `feel ${feel}`, name && "nombre", (description != null || append_note) && "descripción"].filter(Boolean);
        return { content: [{ type: "text", text: `✅ Actividad ${activity_id} actualizada: ${parts.join(", ")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ update_activity: ${err.message}` }] };
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

  srv.tool("create_events_bulk",
    "Create a whole week (or more) of workouts in ONE call. Each event: date, name, type (Run/WeightTraining/…), description in intervals.icu workout text format, optional duration_mins, distance_km, load, time (HH:MM). Default time: Saturday 09:00, other days 19:00. Strength-session duration is fixed automatically.",
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
            category: "WORKOUT",
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
        return { content: [{ type: "text", text: `❌ create_events_bulk: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_gear",
    "List gear (shoes) with accumulated km, time and number of activities. Useful to track race-shoe mileage.",
    { include_retired: z.boolean().optional().describe("Incluir material retirado (default: false)") },
    async ({ include_retired = false }) => {
      try {
        const data = await callIntervals(`/athlete/${ATHLETE_ID}/gear`);
        const gear = toArray(data, "gear").filter(g => include_retired || !g.retired);
        if (!gear.length) return { content: [{ type: "text", text: "No hay material registrado en intervals.icu (Settings → Gear, o sincronizado desde Garmin/Strava)." }] };
        gear.sort((a, b) => (b.distance || 0) - (a.distance || 0));
        const L = [`👟 MATERIAL`];
        gear.forEach(g => {
          L.push(`   • ${g.name || "Sin nombre"}${g.type ? ` (${g.type})` : ""}${g.retired ? " [retirado]" : ""}`);
          L.push(`     ${fmt0((g.distance || 0) / 1000)} km${g.time ? ` · ${fmtDuration(g.time)}` : ""}${g.activities ? ` · ${g.activities} actividades` : ""}`);
        });
        return { content: [{ type: "text", text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_gear: ${err.message}` }] };
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

  // ═══════════════════════════════════════════════════════════════════════════
  // v6 — INDICADOR DE RITMO MARATÓN + PROYECCIÓN DE CARGA
  // ═══════════════════════════════════════════════════════════════════════════

  srv.tool("get_mp_trend",
    "Marathon-pace readiness indicator: finds every continuous segment run inside a grade-adjusted pace band (default 4:05-4:25/km) over the last N days and reports, per segment, pace, HR, HR normalised to the target pace, decoupling, elevation and the km where it started (fatigue context). Returns the trend of the HR cost of marathon pace. Slow (10-30 s): use in Sunday reviews, not daily.",
    {
      target_pace:   z.string().optional().describe("Ritmo objetivo m:ss/km para normalizar la FC (default: 4:16)"),
      pace_fast:     z.string().optional().describe("Límite rápido de la banda m:ss/km, en ritmo ajustado a pendiente (default: 4:05)"),
      pace_slow:     z.string().optional().describe("Límite lento de la banda m:ss/km, en ritmo ajustado a pendiente (default: 4:25)"),
      days:          z.number().optional().describe("Días hacia atrás (default: 90, máx: 180)"),
      min_km:        z.number().optional().describe("Longitud mínima del tramo en km (default: 2)"),
      include_treadmill: z.boolean().optional().describe("Incluir cinta/VirtualRun (default: false)"),
    },
    async ({ target_pace = "4:16", pace_fast = "4:05", pace_slow = "4:25", days = 90, min_km = 2, include_treadmill = false }) => {
      try {
        const vT = paceStrToMps(target_pace), vF = paceStrToMps(pace_fast), vS = paceStrToMps(pace_slow);
        if (!vT || !vF || !vS || vF <= vS) return { content: [{ type: "text", text: "❌ Ritmos no válidos (formato m:ss, pace_fast más rápido que pace_slow)." }] };
        // Tolerancia de 4 s/km en los bordes de la banda
        const vHi = 1000 / (1000 / vF - 4), vLo = 1000 / (1000 / vS + 4);
        const nDays = Math.min(days, 180);
        const params = new URLSearchParams({ oldest: daysAgo(nDays), newest: today() });
        const acts = toArray(await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`), "activities")
          .filter(a => (a.type === "Run" || (include_treadmill && a.type === "VirtualRun")) && (a.distance || 0) >= min_km * 1000 && !(a.trainer && !include_treadmill))
          .filter(a => { const sp = a.average_speed || 0; return sp === 0 || sp > vLo * 0.75; }) // descarta rodajes muy lentos sin opción de tramo
          .sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local)));

        const segs = [];
        const failed = [];
        const inBandSp = (sp) => sp >= vLo && sp <= vHi;
        const tOfSt = (st, x) => st.time.length ? st.time[x] : x;

        // Métricas de un tramo [start..last] a partir de los streams (GAP, FC sin retardo, desnivel, desacoplamiento)
        const enrich = (st, gv, start, last) => {
          const { hr, dist, alt } = st;
          const segM = (dist[last] || 0) - (dist[start] || 0);
          const secs = tOfSt(st, last) - tOfSt(st, start);
          if (segM <= 0 || secs <= 0) return null;
          const hrFrom = secs > 300 ? start + Math.min(90, Math.floor((last - start) / 4)) : start;
          const hrVals = []; for (let x = hrFrom; x <= last; x++) if (hr[x] > 60) hrVals.push(hr[x]);
          const gVals = []; for (let x = start; x <= last; x++) gVals.push(gv[x]);
          let up = 0;
          if (alt.length) { for (let x = start + 10; x <= last; x += 10) { const dz = (alt[x] || 0) - (alt[x - 10] || 0); if (dz > 0) up += dz; } }
          const dec = secs >= 1200 ? computeDecoupling({ ...st, vel: gv }, dist[start], dist[last]) : null;
          return { startKm: (dist[start] || 0) / 1000, km: segM / 1000, v: segM / secs, vg: mean(gVals) || segM / secs,
                   hr: hrVals.length >= 60 ? mean(hrVals) : null, up, dec: dec ? dec.decoupling : null };
        };

        const pushSeg = (a, m, src) => {
          if (!m || !m.hr) return;
          segs.push({ date: (a.start_date_local || "").split("T")[0], name: a.name || "", src,
                      startKm: m.startKm, km: m.km, pace: 1000 / m.v, gap: 1000 / m.vg, hr: m.hr,
                      hrNorm: m.hr * (vT / m.vg), dec: m.dec, up: m.up });
        };

        for (let i = 0; i < acts.length; i += 3) {
          const batch = acts.slice(i, i + 3);
          await Promise.all(batch.map(async (a) => {
            // ── 1) Intervalos de intervals (pasos del entreno estructurado o vueltas) ──
            let ivs = [], ivErr = null;
            try {
              let raw;
              try { raw = await callIntervals(`/activity/${a.id}/intervals`); }
              catch (e) { if (!/ 404/.test(e.message)) throw e; raw = await callIntervals(`/activity/${cleanId(a.id)}/intervals`); }
              ivs = (raw?.icu_intervals || []).filter(iv => (iv.distance || 0) > 0 && (iv.moving_time || iv.elapsed_time || 0) > 0);
            } catch (e) { if (!/ 404/.test(e.message)) ivErr = e; }
            ivs.sort((x, y) => (x.start_index ?? 0) - (y.start_index ?? 0));

            // Agrupar intervalos consecutivos dentro de la banda
            const groups = []; let cur = null, before = 0; const startDist = [];
            ivs.forEach(iv => {
              startDist.push(before); before += iv.distance || 0;
              const sp = iv.average_speed || (iv.distance / (iv.moving_time || iv.elapsed_time));
              if (inBandSp(sp)) { (cur = cur || []).push(iv); } else { if (cur) groups.push(cur); cur = null; }
            });
            if (cur) groups.push(cur);
            const cands = groups.map(g => {
              const dist = g.reduce((s, iv) => s + (iv.distance || 0), 0);
              const secs = g.reduce((s, iv) => s + (iv.moving_time || iv.elapsed_time || 0), 0);
              const hrW  = g.reduce((s, iv) => s + (iv.average_heartrate || 0) * (iv.moving_time || iv.elapsed_time || 0), 0);
              return { dist, secs, hr: secs ? hrW / secs : null, startIdx: g[0].start_index, endIdx: g[g.length - 1].end_index,
                       startKm: startDist[ivs.indexOf(g[0])] / 1000 };
            }).filter(c => c.dist >= min_km * 1000);

            let st = null, gv = null;
            const loadStreams = async () => {
              if (st) return st;
              try {
                st = await fetchStreams(a.id, "time,heartrate,velocity_smooth,distance,altitude");
                gv = gapVelocity(st.vel, st.dist, st.alt);
              } catch (_) { st = null; }
              return st;
            };

            if (cands.length) {
              await loadStreams();
              for (const c of cands) {
                const n = st ? Math.min(st.vel.length, st.dist.length) : 0;
                const hasIdx = st && c.startIdx != null && c.endIdx != null && c.endIdx < n && c.endIdx > c.startIdx;
                const m = hasIdx ? enrich(st, gv, c.startIdx, c.endIdx) : null;
                if (m) {
                  // Distancia y ritmo exactos del intervalo; GAP, FC sin retardo y desacoplamiento de los streams
                  pushSeg(a, { ...m, km: c.dist / 1000, v: c.dist / c.secs, hr: m.hr ?? c.hr }, "int");
                } else {
                  pushSeg(a, { startKm: c.startKm, km: c.dist / 1000, v: c.dist / c.secs, vg: c.dist / c.secs, hr: c.hr, up: 0, dec: null }, "int");
                }
              }
              return;
            }

            // ── 2) Respaldo: detección sobre los streams (carreras sin vueltas útiles) ──
            if (!await loadStreams()) { failed.push((a.start_date_local || "").split("T")[0]); return; }
            if (ivErr) failed.push(`${(a.start_date_local || "").split("T")[0]} (solo GPS)`);
            const n = Math.min(st.vel.length, st.dist.length);
            if (n < 300 || !st.hr.length) return;
            const rv = new Array(n); let acc = 0;
            for (let k = 0; k < n; k++) { acc += gv[k] || 0; if (k >= 60) acc -= gv[k - 60] || 0; rv[k] = acc / Math.min(k + 1, 60); }
            let k = 0;
            while (k < n) {
              if (!inBandSp(rv[k])) { k++; continue; }
              let start = k, last = k, gap = 0; k++;
              while (k < n) { if (inBandSp(rv[k])) { last = k; gap = 0; } else if (++gap > 45) break; k++; }
              if ((st.dist[last] || 0) - (st.dist[start] || 0) < min_km * 1000) continue;
              pushSeg(a, enrich(st, gv, start, last), "gps");
            }
          }));
        }
        segs.sort((x, y) => x.date.localeCompare(y.date) || x.startKm - y.startKm);
        const failNote = failed.length ? `\n⚠️ ${failed.length} actividad(es) no se pudieron leer completas: ${failed.join(", ")}. Repetir la consulta en unos minutos.` : "";
        if (!segs.length) return { content: [{ type: "text", text: failNote + `\nNo hay tramos de ≥${min_km} km entre ${pace_fast} y ${pace_slow}/km en los últimos ${nDays} días.` }] };

        const L = [`🎯 COSTE CARDÍACO DEL RITMO MARATÓN — banda ${pace_fast}-${pace_slow}/km · normalizado a ${target_pace}`,
                   `   ${segs.length} tramos en ${new Set(segs.map(s => s.date)).size} sesiones (últimos ${nDays} días)`, ``,
                   `fecha      | inicio | tramo  | ritmo | GAP  | FC  | FC@${target_pace} | desac | desn+`];
        segs.slice(-25).forEach(s => {
          const fat = s.startKm >= 15 ? "🔋" : "  ";
          const srcMark = s.src === "gps" ? "*" : " ";
          L.push(`${s.date}${srcMark}| ${fat}${s.startKm.toFixed(1).padStart(4)} | ${s.km.toFixed(1).padStart(4)}km | ${fmtSecs(s.pace)} | ${fmtSecs(s.gap)} | ${Math.round(s.hr)} | ${Math.round(s.hrNorm).toString().padStart(3)}     | ${s.dec != null ? fmt1(s.dec).padStart(4) + "%" : "   - "} | ${Math.round(s.up)}m`);
        });
        L.push(`   🔋 = tramo iniciado a partir del km 15 (con fatiga acumulada) · * = detectado por GPS (sin vueltas), menos preciso`);

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
        L.push(``, `📉 TENDENCIA`);
        if (nSessions >= 3 && span >= 21) {
          L.push(`   FC a ${target_pace}: ${slope <= 0 ? "▼" : "▲"} ${Math.abs(slope * 28).toFixed(1)} bpm cada 4 semanas ${slope < -0.5 / 28 ? "🟢 (mejorando)" : slope > 0.5 / 28 ? "🔴 (empeorando)" : "🟡 (estable)"}`);
        } else {
          L.push(`   ⚠️ Datos insuficientes para una tendencia fiable (${nSessions} sesiones en ${Math.round(span)} días; mínimo 3 sesiones en 21 días)`);
        }
        if (older.length && recent.length) L.push(`   Últimas 4 semanas: ${Math.round(wavg(recent))} bpm · antes: ${Math.round(wavg(older))} bpm`);
        if (fresh.length && tired.length) L.push(`   Últimas 4 semanas — fresco: ${Math.round(wavg(fresh))} bpm · con fatiga (km 15+): ${Math.round(wavg(tired))} bpm (${wavg(tired) >= wavg(fresh) ? "+" : ""}${Math.round(wavg(tired) - wavg(fresh))})`);
        if (decs.length) L.push(`   Desacoplamiento medio (tramos ≥20 min, últimas 4 semanas): ${fmt1(mean(decs))}%`);
        L.push(`   Km a ritmo maratón últimas 4 semanas: ${recent.reduce((a, s) => a + s.km, 0).toFixed(1)} km · tramo más largo: ${Math.max(...recent.map(s => s.km), 0).toFixed(1)} km`);
        L.push(``, `ℹ️ Tramos tomados de los intervalos de intervals (o del GPS si no hay vueltas). FC@objetivo = FC × velocidad objetivo / velocidad GAP. Contrastar siempre con calor y sueño del día.`);
        if (failNote) L.push(failNote);
        return { content: [{ type: "text", text: L.join("\n") }] };
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
  status: "ok", version: "6.5.0", transport: "streamable-http", sessions: sessions.size, auth: !!AUTH_TOKEN
}));

app.listen(PORT, () => {
  console.log(`✅ Intervals MCP v6.5 (Streamable HTTP) — port ${PORT} — athlete ${ATHLETE_ID} — ${AUTH_TOKEN ? "🔒 token activo" : "⚠️ SIN token: endpoint abierto"}`);
});
