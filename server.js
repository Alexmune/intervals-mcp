import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY    = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID;
const PORT       = process.env.PORT || 3000;
const BASE_URL   = "https://intervals.icu/api/v1";

if (!API_KEY || !ATHLETE_ID) {
  console.error("❌ Missing INTERVALS_API_KEY or INTERVALS_ATHLETE_ID");
  process.exit(1);
}

// ─── Intervals API helper ─────────────────────────────────────────────────────
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
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intervals API ${res.status}: ${text}`);
  }
  const text = await res.text();
  if (!text || text.trim() === "") return {};
  return JSON.parse(text);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const today    = () => new Date().toISOString().split("T")[0];
const daysAgo  = (n) => new Date(Date.now() - n * 86400000).toISOString().split("T")[0];
const daysAhead= (n) => new Date(Date.now() + n * 86400000).toISOString().split("T")[0];

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

// ─── MCP Server factory ───────────────────────────────────────────────────────
function createServer() {
  const srv = new McpServer({ name: "intervals-mcp", version: "4.0.0" });

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
    "Deep detail for a specific activity: laps, zones, cadence, power. Use ID from get_activities [ID:xxx].",
    { activity_id: z.string().describe("Activity ID e.g. i139521833") },
    async ({ activity_id }) => {
      try {
        const params = new URLSearchParams({
          oldest: daysAgo(60),
          newest: today(),
          fields: "id,name,type,start_date_local,distance,moving_time,average_speed,average_heartrate,max_heartrate,average_cadence,average_watts,total_elevation_gain,calories,tss,perceived_exertion,description,icu_zone_times,laps"
        });
        const data = await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`);
        const acts = toArray(data, "activities");
        const idClean = String(activity_id).replace(/^i/, "");
        const a = acts.find(x => String(x.id) === activity_id || String(x.id) === idClean);
        if (!a) {
          return { content: [{ type: "text", text: `⚠️ Actividad ${activity_id} no encontrada en los últimos 60 días.` }] };
        }
        const lines = [
          `📊 ${(a.start_date_local||"").split("T")[0]} — ${a.name||"Activity"} (${a.type||"Run"})`,
          ``,
          `📏 MÉTRICAS`,
          `   Distancia:   ${((a.distance||0)/1000).toFixed(2)} km`,
          `   Duración:    ${fmtDuration(a.moving_time||a.movingTime)}`,
          (a.average_speed||a.averageSpeed) ? `   Ritmo medio: ${fmtPace(a.average_speed||a.averageSpeed)}` : null,
          (a.total_elevation_gain||a.totalElevationGain) ? `   Desnivel+:   ${fmt0(a.total_elevation_gain||a.totalElevationGain)} m` : null,
          a.calories ? `   Calorías:    ${fmt0(a.calories)} kcal` : null,
          a.tss ? `   TSS:         ${fmt0(a.tss)}` : null,
          ``,
          `❤️  FC`,
          (a.average_heartrate||a.averageHeartrate) ? `   Media:  ${fmt0(a.average_heartrate||a.averageHeartrate)} bpm` : null,
          (a.max_heartrate||a.maxHeartrate)         ? `   Máxima: ${fmt0(a.max_heartrate||a.maxHeartrate)} bpm` : null,
        ].filter(v => v != null);
        if (a.average_cadence||a.averageCadence) lines.push(`\n👟 Cadencia: ${fmt0(a.average_cadence||a.averageCadence)} spm`);
        if (a.average_watts||a.averageWatts)     lines.push(`⚡ Potencia: ${fmt0(a.average_watts||a.averageWatts)} W`);
        if (a.perceived_exertion)                lines.push(`😓 RPE: ${a.perceived_exertion}/10`);
        if (a.description)                       lines.push(`📝 ${a.description}`);
        const zt = a.icu_zone_times || [];
        if (zt.length) {
          lines.push(`\n📊 TIEMPO EN ZONAS`);
          const zn = ["Z1 (≤133)","Z2 (134-148)","Z3 (149-163)","Z4 (164-178)","Z5 (>178)"];
          zt.forEach((s, i) => { const m = Math.round((s||0)/60); if (m > 0 && i < 5) lines.push(`   ${zn[i]}: ${m} min`); });
        }
        const laps = a.laps || [];
        if (laps.length) {
          lines.push(`\n🔁 LAPS (${laps.length})`);
          laps.slice(0,20).forEach((l,i) => {
            const sp = l.average_speed||l.averageSpeed;
            const hr = l.average_heartrate||l.averageHeartrate;
            lines.push(`  ${i+1}: ${((l.distance||0)/1000).toFixed(2)}km | ${fmtDuration(l.moving_time||l.elapsed_time||0)}${sp?` | ${fmtPace(sp)}`:""}${hr?` | ${fmt0(hr)}bpm`:""}`);
          });
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_activity_detail: ${err.message}` }] };
      }
    }
  );

  srv.tool("get_activity_streams",
    "Get per-second stream data: HR, cadence, pace, altitude, power. Calculates time in HR zones.",
    {
      activity_id:  z.string().describe("Activity ID e.g. i139521833"),
      stream_types: z.string().optional().describe("Comma-separated stream types (default: time,heartrate,cadence,velocity_smooth,altitude,distance)"),
    },
    async ({ activity_id, stream_types }) => {
      try {
        const cleanId = activity_id.replace(/^i/, "");
        const types   = stream_types || "time,heartrate,cadence,velocity_smooth,altitude,distance,watts";
        const params  = new URLSearchParams({ types });

        let raw;
        try { raw = await callIntervals(`/activity/${activity_id}/streams?${params}`); }
        catch (_) { raw = await callIntervals(`/activity/${cleanId}/streams?${params}`); }

        // API returns a LIST of stream objects: [{type, name, data, valueType}, ...]
        const streams = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        if (!streams.length) return { content: [{ type: "text", text: "No hay streams para esta actividad." }] };

        // Index streams by type
        const byType = {};
        streams.forEach(s => { if (s.type) byType[s.type] = s.data || []; });

        const availableTypes = streams.map(s => s.type || s.name).join(", ");
        const lines = [`📈 Streams disponibles: ${availableTypes}\n`];

        const time = byType.time || [];
        const hr   = byType.heartrate || byType.heart_rate || [];
        const vel  = byType.velocity_smooth || byType.speed || byType.velocity || [];
        const cad  = byType.cadence || [];
        const alt  = byType.altitude || [];
        const pwr  = byType.watts || byType.power || [];

        if (time.length) lines.push(`⏱ ${time.length} puntos · duración ${fmtDuration(time[time.length-1]||0)}`);

        if (hr.length) {
          const v = hr.filter(x => x > 0);
          if (v.length) {
            const avg = Math.round(v.reduce((a,b)=>a+b,0)/v.length);
            const max = Math.max(...v), min = Math.min(...v);
            lines.push(`\n❤️  FRECUENCIA CARDÍACA`);
            lines.push(`   Media: ${avg} bpm | Máx: ${max} bpm | Mín: ${min} bpm`);
            // Zonas de Alex: Z1 ≤133, Z2 134-148, Z3 149-163, Z4 164-178, Z5 >178
            const z = [0,0,0,0,0];
            v.forEach(x => {
              if      (x <= 133) z[0]++;
              else if (x <= 148) z[1]++;
              else if (x <= 163) z[2]++;
              else if (x <= 178) z[3]++;
              else               z[4]++;
            });
            const tot = v.length;
            const zn  = ["Z1 (≤133)","Z2 (134-148)","Z3 (149-163)","Z4 (164-178)","Z5 (>178)"];
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
            const avg = v.reduce((a,b)=>a+b,0)/v.length;
            const maxPace = fmtPace(Math.min(...v));
            lines.push(`\n🏃 RITMO`);
            lines.push(`   Medio: ${fmtPace(avg)}`);
            if (maxPace) lines.push(`   Mejor km: ${maxPace}`);
          }
        }

        if (cad.length) {
          const v = cad.filter(x => x > 0);
          if (v.length) {
            const avg = Math.round(v.reduce((a,b)=>a+b,0)/v.length);
            const max = Math.max(...v);
            lines.push(`\n👟 CADENCIA`);
            lines.push(`   Media: ${avg} spm | Máx: ${max} spm`);
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
            const avg = Math.round(v.reduce((a,b)=>a+b,0)/v.length);
            lines.push(`\n⚡ POTENCIA: media ${avg} W | máx ${Math.max(...v)} W`);
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
            w.sleepSecs    ? `   😴 Sueño: ${(w.sleepSecs/3600).toFixed(1)}h` : null,
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
        const RUN_TYPES = ["run","walk","hike","trail","track","treadmill","virtualrun"];
        const runCfg = configs.find(c =>
          (c.types || []).some(t => RUN_TYPES.some(r => t.toLowerCase().includes(r)))
        );

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
        if (lthrVal) {
          lines.push(`\n❤️  ZONAS FC (calculadas desde LTHR = ${lthrVal} bpm)`);
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
        const RUN_TYPES = ["run","walk","hike","trail","track","treadmill","virtualrun"];
        const runCfg  = configs.find(c => (c.types||[]).some(t => RUN_TYPES.some(r => t.toLowerCase().includes(r))));
        const cfg     = runCfg || configs[0];

        const cs    = cfg?.threshold_pace;
        const wPrime= cfg?.w_prime;
        const lthr  = cfg?.lthr;

        const lines = [`📈 DATOS DE RENDIMIENTO — ${sport}\n`];

        if (cs) {
          const csSecs = 1000 / (parseFloat(cs) * 60);
          const mins   = Math.floor(csSecs / 60);
          const secs   = Math.round(csSecs % 60);
          lines.push(`🎯 Velocidad Crítica (CS): ${mins}:${String(secs).padStart(2,"0")} min/km`);
          lines.push(`   (valor API: ${cs} m/s)`);
        } else {
          lines.push(`🎯 CS: no configurado en la API`);
        }
        if (wPrime) lines.push(`🔋 D' (W'): ${wPrime} m`);
        if (lthr)   lines.push(`❤️  LTHR: ${lthr} bpm`);
        lines.push(`\nℹ️  La curva de pace completa (MMP) está disponible en intervals.icu → Rendimiento → Curvas.`);
        lines.push(`   Los endpoints de curvas de rendimiento no están disponibles en la API pública.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ get_performance_data: ${err.message}` }] };
      }
    }
  );

  srv.tool("create_event",
    "Create a workout or event in the intervals.icu calendar",
    {
      date:          z.string().describe("Date YYYY-MM-DD"),
      name:          z.string().describe("Workout name"),
      type:          z.string().optional().describe("Run, Ride, Swim, WeightTraining, Rest (default: Run)"),
      description:   z.string().optional().describe("Workout structure, zones, paces, notes"),
      load:          z.number().optional().describe("Target TSS/load"),
      duration_mins: z.number().optional().describe("Planned duration in minutes"),
    },
    async ({ date, name, type = "Run", description, load, duration_mins }) => {
      try {
        const body = {
          start_date_local: `${date}T08:00:00`,
          name, type,
          description: description || "",
          ...(load          && { load }),
          ...(duration_mins && { moving_time: duration_mins * 60 }),
        };
        const data = await callIntervals(`/athlete/${ATHLETE_ID}/events`, "POST", body);
        return { content: [{ type: "text", text: `✅ ${date} — ${name} (${type}) [ID:${data.id || "ok"}]` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
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

// Session store for stateful MCP connections
const sessions = new Map();

function getOrCreateTransport(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId).transport;
  }
  return null;
}

// ── POST /sse — new MCP Streamable HTTP transport ─────────────────────────────
app.post("/sse", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = getOrCreateTransport(sessionId);

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
app.get("/sse", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    const transport = getOrCreateTransport(sessionId);
    if (!transport) {
      res.status(400).json({ error: "No active session. Send POST /sse first." });
      return;
    }
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("GET /sse error:", err.message);
    if (!res.headersSent) res.status(500).end();
  }
});

// ── DELETE /sse — close session ───────────────────────────────────────────────
app.delete("/sse", async (req, res) => {
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
  status: "ok", version: "4.0.0", transport: "streamable-http", sessions: sessions.size
}));

app.listen(PORT, () => {
  console.log(`✅ Intervals MCP v4 (Streamable HTTP) — port ${PORT} — athlete ${ATHLETE_ID}`);
});
