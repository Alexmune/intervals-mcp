import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

function today()     { return new Date().toISOString().split("T")[0]; }
function daysAgo(n)  { return new Date(Date.now() - n * 86400000).toISOString().split("T")[0]; }
function daysAhead(n){ return new Date(Date.now() + n * 86400000).toISOString().split("T")[0]; }

function safeRange(oldest, newest, maxDays = 60) {
  const end   = newest || today();
  const start = oldest || daysAgo(maxDays);
  const diffDays = (new Date(end) - new Date(start)) / 86400000;
  return diffDays > maxDays
    ? { oldest: daysAgo(maxDays), newest: end }
    : { oldest: start, newest: end };
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
  if (!secs) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  return `${m}min ${String(s).padStart(2, "0")}s`;
}

const fmt1 = (v) => (v != null && !isNaN(v)) ? Number(v).toFixed(1) : "N/A";
const fmt0 = (v) => (v != null && !isNaN(v)) ? Math.round(Number(v)).toString() : "N/A";

// ─── MCP Server factory — new instance per SSE connection ────────────────────
function createServer() {
const server = new McpServer({ name: "intervals-mcp", version: "2.0.0" });

// ── get_athlete_profile ───────────────────────────────────────────────────────
server.tool(
  "get_athlete_profile",
  "Get athlete profile: name, weight, FTP, max HR, LTHR, running threshold pace, VO2max",
  {},
  async () => {
    try {
      const raw  = await callIntervals(`/athlete/${ATHLETE_ID}`);
      const data = raw.athlete || raw;
      const lines = [
        `👤 Athlete: ${data.name || data.username || "N/A"}`,
        data.city      ? `📍 Location: ${data.city}` : null,
        data.country   ? `🌍 Country: ${data.country}` : null,
        data.sex       ? `⚧  Sex: ${data.sex}` : null,
        data.dob       ? `🎂 DOB: ${data.dob}` : null,
        data.weight    ? `⚖️  Weight: ${data.weight} kg` : null,
        data.ftp       ? `⚡ Cycling FTP: ${data.ftp} W` : null,
        data.lthr      ? `❤️  LTHR: ${data.lthr} bpm` : null,
        data.maxHR     ? `💓 Max HR: ${data.maxHR} bpm` : null,
        data.restingHR ? `🛌 Resting HR: ${data.restingHR} bpm` : null,
        data.runningFTP ? `🏃 Running threshold pace: ${data.runningFTP}` : null,
        data.swimFTP   ? `🏊 Swim FTP: ${data.swimFTP}` : null,
        data.vo2max    ? `🫁 VO2max: ${data.vo2max}` : null,
      ].filter(Boolean);
      if (lines.length <= 3) {
        return { content: [{ type: "text", text: `⚠️ Limited profile. Raw:\n${JSON.stringify(data, null, 2)}` }] };
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ get_athlete_profile: ${err.message}` }] };
    }
  }
);

// ── get_activities ────────────────────────────────────────────────────────────
server.tool(
  "get_activities",
  "Get recent activities with full metrics: distance, pace, HR, power, TSS, calories. Returns activity IDs for use in get_activity_detail.",
  {
    oldest: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
    newest: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    limit:  z.number().optional().describe("Max activities to return (default: 20)"),
  },
  async ({ oldest, newest, limit = 20 }) => {
    try {
      const range  = safeRange(oldest || daysAgo(30), newest, 60);
      const params = new URLSearchParams({ oldest: range.oldest, newest: range.newest });
      const data   = await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`);
      const acts   = toArray(data, "activities").slice(0, limit);
      if (acts.length === 0) {
        return { content: [{ type: "text", text: `No activities between ${range.oldest} and ${range.newest}.` }] };
      }
      const summary = acts.map((a) => {
        const startDate  = (a.start_date_local || a.startDateLocal || a.date || "").split("T")[0];
        const movingTime = a.moving_time || a.movingTime || a.elapsed_time || 0;
        const distance   = a.distance || 0;
        const avgHR      = a.average_heartrate || a.averageHeartrate || null;
        const avgWatts   = a.average_watts || a.averageWatts || null;
        const avgSpeed   = a.average_speed || a.averageSpeed || null;
        const elevation  = a.total_elevation_gain || a.totalElevationGain || null;
        const tss        = a.tss || null;
        const calories   = a.calories || null;
        const rpe        = a.perceived_exertion || a.perceivedExertion || null;
        const actId      = a.id || a.activity_id || null;
        return [
          `📅 ${startDate} — ${a.name || "Activity"} (${a.type || "Unknown"})${actId ? ` [ID:${actId}]` : ""}`,
          `   ⏱ ${fmtDuration(movingTime)}`,
          distance > 0 ? `   📏 ${(distance / 1000).toFixed(2)} km` : null,
          avgHR        ? `   ❤️  ${fmt0(avgHR)} bpm avg` : null,
          avgWatts     ? `   ⚡ ${fmt0(avgWatts)} W avg` : null,
          avgSpeed     ? `   🏃 ${fmtPace(avgSpeed)}` : null,
          elevation    ? `   ⛰️  ${fmt0(elevation)} m D+` : null,
          tss          ? `   📊 TSS ${fmt0(tss)}` : null,
          calories     ? `   🔥 ${fmt0(calories)} kcal` : null,
          rpe          ? `   😓 RPE ${rpe}/10` : null,
        ].filter(Boolean).join("\n");
      });
      return { content: [{ type: "text", text: summary.join("\n\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ get_activities: ${err.message}` }] };
    }
  }
);

// ── get_activity_detail ───────────────────────────────────────────────────────
server.tool(
  "get_activity_detail",
  "Deep detail for a specific activity: lap splits, HR zones, pace zones. Use ID from get_activities [ID:xxx].",
  {
    activity_id: z.string().describe("Activity ID from get_activities output"),
  },
  async ({ activity_id }) => {
    try {
      const data = await callIntervals(`/athlete/${ATHLETE_ID}/activities/${activity_id}`);
      const a    = data.activity || data;
      const lines = [
        `📊 ACTIVITY DETAIL`,
        `📅 ${(a.start_date_local || "").split("T")[0]} — ${a.name || "Activity"} (${a.type || ""})`,
        `⏱ Duration: ${fmtDuration(a.moving_time || a.movingTime)}`,
        `📏 Distance: ${((a.distance || 0) / 1000).toFixed(2)} km`,
        a.average_heartrate ? `❤️  Avg HR: ${fmt0(a.average_heartrate)} bpm  Max HR: ${fmt0(a.max_heartrate)} bpm` : null,
        a.average_speed  ? `🏃 Avg Pace: ${fmtPace(a.average_speed)}` : null,
        a.average_watts  ? `⚡ Avg Power: ${fmt0(a.average_watts)} W  Max: ${fmt0(a.max_watts)} W` : null,
        a.total_elevation_gain ? `⛰️  Elevation: ${fmt0(a.total_elevation_gain)} m` : null,
        a.tss            ? `📊 TSS: ${fmt0(a.tss)}` : null,
        a.calories       ? `🔥 Calories: ${fmt0(a.calories)} kcal` : null,
        a.perceived_exertion ? `😓 RPE: ${a.perceived_exertion}/10` : null,
        a.description    ? `📝 Notes: ${a.description}` : null,
      ].filter(Boolean);

      // Laps
      const laps = a.laps || a.splits || [];
      if (laps.length > 0) {
        lines.push(`\n🔁 SPLITS (${laps.length} laps)`);
        laps.forEach((lap, i) => {
          const lapSpeed = lap.average_speed || lap.averageSpeed;
          lines.push([
            `  Lap ${i + 1}:`,
            `${((lap.distance || 0) / 1000).toFixed(2)} km`,
            fmtDuration(lap.moving_time || lap.elapsed_time),
            lapSpeed ? fmtPace(lapSpeed) : null,
            lap.average_heartrate ? `FC ${fmt0(lap.average_heartrate)} bpm` : null,
          ].filter(Boolean).join(" | "));
        });
      }

      // HR Zones
      const hrZones = a.hrZones || a.heart_rate_zones || a.zones?.hr || [];
      if (hrZones.length > 0) {
        lines.push(`\n❤️  HR ZONES`);
        hrZones.forEach((z) => {
          lines.push(`  Z${z.zone || z.id}: ${Math.round((z.time || z.secs || 0) / 60)} min`);
        });
      }

      // Pace Zones
      const paceZones = a.paceZones || a.pace_zones || a.zones?.pace || [];
      if (paceZones.length > 0) {
        lines.push(`\n🏃 PACE ZONES`);
        paceZones.forEach((z) => {
          lines.push(`  Z${z.zone || z.id}: ${Math.round((z.time || z.secs || 0) / 60)} min`);
        });
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ get_activity_detail: ${err.message}` }] };
    }
  }
);

// ── get_wellness ──────────────────────────────────────────────────────────────
server.tool(
  "get_wellness",
  "Get wellness data: HRV, resting HR, sleep duration & score, weight, fatigue, mood, motivation, soreness",
  {
    start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 14 days ago)"),
    end_date:   z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
  },
  async ({ start_date, end_date }) => {
    try {
      const range  = safeRange(start_date || daysAgo(14), end_date, 60);
      const params = new URLSearchParams({ oldest: range.oldest, newest: range.newest });
      const data   = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
      const entries = toArray(data, "wellness");
      const withData = entries.filter(w =>
        w.hrv || w.restingHR || w.sleepSecs || w.weight ||
        w.fatigue != null || w.mood != null || w.motivation != null
      );
      if (withData.length === 0) {
        return { content: [{ type: "text", text: "No wellness metrics recorded in this range." }] };
      }
      const summary = withData.map((w) => [
        `📅 ${w.id}`,
        w.hrv          ? `   💓 HRV: ${w.hrv}` : null,
        w.restingHR    ? `   ❤️  Resting HR: ${w.restingHR} bpm` : null,
        w.sleepSecs    ? `   😴 Sleep: ${(w.sleepSecs / 3600).toFixed(1)}h` : null,
        w.sleepScore   ? `   💤 Sleep score: ${w.sleepScore}/100` : null,
        w.weight       ? `   ⚖️  Weight: ${w.weight} kg` : null,
        w.fatigue  != null ? `   😩 Fatigue: ${w.fatigue}/10` : null,
        w.mood     != null ? `   😊 Mood: ${w.mood}/10` : null,
        w.motivation != null ? `   🔥 Motivation: ${w.motivation}/10` : null,
        w.soreness != null ? `   💪 Soreness: ${w.soreness}/10` : null,
        w.notes    ? `   📝 ${w.notes}` : null,
      ].filter(Boolean).join("\n"));
      return { content: [{ type: "text", text: summary.join("\n\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ get_wellness: ${err.message}` }] };
    }
  }
);

// ── get_fitness ───────────────────────────────────────────────────────────────
server.tool(
  "get_fitness",
  "Get CTL (fitness), ATL (fatigue) and TSB (form/freshness) training load curves",
  {
    start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 42 days ago)"),
    end_date:   z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
  },
  async ({ start_date, end_date }) => {
    try {
      const range  = safeRange(start_date || daysAgo(42), end_date, 60);
      const params = new URLSearchParams({ oldest: range.oldest, newest: range.newest });
      const data   = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
      const entries = toArray(data, "wellness");
      const withLoad = entries.filter(d => d.ctl != null || d.atl != null || d.tsb != null);
      if (withLoad.length === 0) {
        const sample = entries[entries.length - 1] || {};
        return { content: [{ type: "text", text: `⚠️ No CTL/ATL/TSB found. Fields in last entry: ${Object.keys(sample).join(", ")}\n\nEnable Training Load in intervals.icu Settings.` }] };
      }
      const latest = withLoad[withLoad.length - 1];
      const recent = withLoad.slice(-10);
      const header = [
        `📊 TRAINING LOAD`,
        `${"─".repeat(42)}`,
        `Latest (${latest.id}):  CTL ${fmt1(latest.ctl)}  ATL ${fmt1(latest.atl)}  TSB ${fmt1(latest.tsb)}`,
        `\nLast ${recent.length} days:`,
      ].join("\n");
      const rows = recent.map(d =>
        `  ${d.id}  CTL ${fmt1(d.ctl).padStart(5)}  ATL ${fmt1(d.atl).padStart(5)}  TSB ${fmt1(d.tsb).padStart(6)}`
      );
      return { content: [{ type: "text", text: header + "\n" + rows.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ get_fitness: ${err.message}` }] };
    }
  }
);

// ── get_weekly_stats ──────────────────────────────────────────────────────────
server.tool(
  "get_weekly_stats",
  "Aggregated weekly training stats: total km, duration, TSS, sessions per week. Great for load trend analysis.",
  {
    weeks: z.number().optional().describe("Weeks to look back (default: 8, max: 12)"),
  },
  async ({ weeks = 8 }) => {
    try {
      const safeWeeks = Math.min(weeks, 12);
      const params = new URLSearchParams({ oldest: daysAgo(safeWeeks * 7), newest: today() });
      const data   = await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`);
      const acts   = toArray(data, "activities");
      if (acts.length === 0) {
        return { content: [{ type: "text", text: "No activities found." }] };
      }
      const map = {};
      for (const a of acts) {
        const dateStr = (a.start_date_local || a.startDateLocal || a.date || "").split("T")[0];
        if (!dateStr) continue;
        const d    = new Date(dateStr);
        const day  = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        const mon  = new Date(d);
        mon.setDate(d.getDate() + diff);
        const key = mon.toISOString().split("T")[0];
        if (!map[key]) map[key] = { sessions: 0, distance: 0, duration: 0, tss: 0, calories: 0 };
        map[key].sessions++;
        map[key].distance += a.distance || 0;
        map[key].duration += a.moving_time || a.movingTime || 0;
        map[key].tss      += a.tss || 0;
        map[key].calories += a.calories || 0;
      }
      const sorted = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
      const lines  = [`📊 WEEKLY STATS (${safeWeeks} weeks)\n${"─".repeat(44)}`];
      for (const [week, s] of sorted) {
        lines.push([
          `📅 Week ${week}`,
          `   🏃 ${s.sessions} sessions  📏 ${(s.distance / 1000).toFixed(1)} km  ⏱ ${fmtDuration(s.duration)}`,
          s.tss > 0      ? `   📊 TSS: ${fmt0(s.tss)}` : null,
          s.calories > 0 ? `   🔥 Calories: ${fmt0(s.calories)} kcal` : null,
        ].filter(Boolean).join("\n"));
      }
      const avgKm  = sorted.reduce((s, [, w]) => s + w.distance, 0) / sorted.length / 1000;
      const avgSes = sorted.reduce((s, [, w]) => s + w.sessions, 0) / sorted.length;
      lines.push(`\n📈 Avg: ${avgKm.toFixed(1)} km/week · ${avgSes.toFixed(1)} sessions/week`);
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ get_weekly_stats: ${err.message}` }] };
    }
  }
);

// ── get_events ────────────────────────────────────────────────────────────────
server.tool(
  "get_events",
  "Get planned workouts and events from the intervals.icu calendar",
  {
    start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: today)"),
    end_date:   z.string().optional().describe("End date YYYY-MM-DD (default: 21 days ahead)"),
  },
  async ({ start_date, end_date }) => {
    try {
      const params = new URLSearchParams({
        oldest: start_date || today(),
        newest: end_date   || daysAhead(21),
      });
      const data   = await callIntervals(`/athlete/${ATHLETE_ID}/events?${params}`);
      const events = toArray(data, "events");
      if (events.length === 0) {
        return { content: [{ type: "text", text: "No planned events found." }] };
      }
      const summary = events.map((e) => {
        const date = (e.start_date_local || e.startDateLocal || e.date || "").split("T")[0];
        return [
          `📅 ${date} — ${e.name || "Event"} (${e.type || e.category || "Event"}) [ID:${e.id}]`,
          e.description ? `   📝 ${e.description}` : null,
          e.load        ? `   📊 Target load: ${e.load}` : null,
          e.moving_time ? `   ⏱ Duration: ${fmtDuration(e.moving_time)}` : null,
        ].filter(Boolean).join("\n");
      });
      return { content: [{ type: "text", text: summary.join("\n\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ get_events: ${err.message}` }] };
    }
  }
);

// ── create_event ──────────────────────────────────────────────────────────────
server.tool(
  "create_event",
  "Create a workout or event in the intervals.icu calendar",
  {
    date:          z.string().describe("Date YYYY-MM-DD"),
    name:          z.string().describe("Workout name"),
    type:          z.string().optional().describe("Sport: Run, Ride, Swim, WeightTraining, Rest, Walk. Default: Run"),
    description:   z.string().optional().describe("Workout structure, zones, target paces, notes"),
    load:          z.number().optional().describe("Target TSS/training load"),
    duration_mins: z.number().optional().describe("Planned duration in minutes"),
  },
  async ({ date, name, type = "Run", description, load, duration_mins }) => {
    try {
      const body = {
        start_date_local: `${date}T08:00:00`,
        name,
        type,
        description: description || "",
        ...(load          && { load }),
        ...(duration_mins && { moving_time: duration_mins * 60 }),
      };
      const data = await callIntervals(`/athlete/${ATHLETE_ID}/events`, "POST", body);
      const id   = data.id || data.event?.id || "ok";
      return { content: [{ type: "text", text: `✅ Created: ${date} — ${name} (${type}) [ID:${id}]` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ create_event: ${err.message}` }] };
    }
  }
);

// ── update_wellness ───────────────────────────────────────────────────────────
server.tool(
  "update_wellness",
  "Update wellness data for a specific day: HRV, resting HR, sleep, weight, fatigue, mood, motivation, soreness, notes",
  {
    date:        z.string().describe("Date YYYY-MM-DD"),
    hrv:         z.number().optional(),
    resting_hr:  z.number().optional(),
    sleep_secs:  z.number().optional().describe("Sleep in seconds (7h = 25200)"),
    sleep_score: z.number().optional().describe("Sleep quality 0-100"),
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
      return { content: [{ type: "text", text: `❌ update_wellness: ${err.message}` }] };
    }
  }
);

// ── delete_event ──────────────────────────────────────────────────────────────
server.tool(
  "delete_event",
  "Delete a planned event from the calendar by its ID (shown as [ID:xxx] in get_events)",
  {
    event_id: z.string().describe("Event ID to delete"),
  },
  async ({ event_id }) => {
    try {
      await callIntervals(`/athlete/${ATHLETE_ID}/events/${event_id}`, "DELETE");
      return { content: [{ type: "text", text: `✅ Event ${event_id} deleted.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ delete_event: ${err.message}` }] };
    }
  }
);

  return server;
} // end createServer()

// ─── Express + SSE ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS — allow Claude.ai and any origin to connect
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});

const transports = {};

app.get("/sse", async (req, res) => {
  // Proper SSE headers — disable buffering so Railway doesn't buffer the stream
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    console.log(`SSE session closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });
  console.log(`New SSE connection: ${transport.sessionId}`);
  const mcpServer = createServer();
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
  await transport.handlePostMessage(req, res);
});

app.get("/health", (_, res) => res.json({
  status: "ok", server: "intervals-mcp", version: "2.0.0", athlete: ATHLETE_ID,
}));

app.listen(PORT, () => {
  console.log(`✅ Intervals MCP v2 — port ${PORT} — athlete ${ATHLETE_ID}`);
});
