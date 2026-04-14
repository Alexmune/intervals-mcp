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
    "Get athlete profile: name, weight, FTP, max HR, LTHR, running threshold pace, VO2max",
    {},
    async () => {
      try {
        const raw  = await callIntervals(`/athlete/${ATHLETE_ID}`);
        const data = raw.athlete || raw;
        const lines = [
          `👤 ${data.name || data.username || "N/A"}`,
          data.city       ? `📍 ${data.city}` : null,
          data.sex        ? `⚧  ${data.sex}` : null,
          data.dob        ? `🎂 ${data.dob}` : null,
          data.weight     ? `⚖️  ${data.weight} kg` : null,
          data.lthr       ? `❤️  LTHR: ${data.lthr} bpm` : null,
          data.maxHR      ? `💓 Max HR: ${data.maxHR} bpm` : null,
          data.restingHR  ? `🛌 Resting HR: ${data.restingHR} bpm` : null,
          data.runningFTP ? `🏃 Running FTP: ${data.runningFTP}` : null,
          data.vo2max     ? `🫁 VO2max: ${data.vo2max}` : null,
        ].filter(Boolean);
        if (lines.length <= 2) return { content: [{ type: "text", text: `Raw: ${JSON.stringify(data, null, 2)}` }] };
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
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
    "Deep detail for one activity: splits, HR zones, pace zones. Use ID from get_activities [ID:xxx].",
    { activity_id: z.string().describe("Activity ID") },
    async ({ activity_id }) => {
      try {
        const data = await callIntervals(`/athlete/${ATHLETE_ID}/activities/${activity_id}`);
        const a    = data.activity || data;
        const lines = [
          `📊 ${(a.start_date_local || "").split("T")[0]} — ${a.name} (${a.type})`,
          `⏱ ${fmtDuration(a.moving_time)}  📏 ${((a.distance || 0) / 1000).toFixed(2)} km`,
          a.average_heartrate ? `❤️  Avg ${fmt0(a.average_heartrate)} / Max ${fmt0(a.max_heartrate)} bpm` : null,
          a.average_speed     ? `🏃 ${fmtPace(a.average_speed)}` : null,
          a.tss               ? `📊 TSS ${fmt0(a.tss)}` : null,
          a.calories          ? `🔥 ${fmt0(a.calories)} kcal` : null,
          a.perceived_exertion ? `😓 RPE ${a.perceived_exertion}/10` : null,
          a.description       ? `📝 ${a.description}` : null,
        ].filter(Boolean);
        const laps = a.laps || a.splits || [];
        if (laps.length) {
          lines.push(`\n🔁 SPLITS`);
          laps.forEach((l, i) => {
            const sp = l.average_speed || l.averageSpeed;
            lines.push(`  Lap ${i+1}: ${((l.distance||0)/1000).toFixed(2)} km | ${fmtDuration(l.moving_time||l.elapsed_time)}${sp ? ` | ${fmtPace(sp)}` : ""}${l.average_heartrate ? ` | ${fmt0(l.average_heartrate)} bpm` : ""}`);
          });
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
      }
    }
  );

  srv.tool("get_wellness",
    "Get wellness: HRV, resting HR, sleep, weight, fatigue, mood, motivation, soreness",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 14 days ago)"),
      end_date:   z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    },
    async ({ start_date, end_date }) => {
      try {
        const range  = safeRange(start_date || daysAgo(14), end_date, 60);
        const params = new URLSearchParams({ oldest: range.oldest, newest: range.newest });
        const data   = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
        const entries = toArray(data, "wellness").filter(w =>
          w.hrv || w.restingHR || w.sleepSecs || w.weight ||
          w.fatigue != null || w.mood != null || w.motivation != null
        );
        if (!entries.length) return { content: [{ type: "text", text: "No wellness data in range." }] };
        const lines = entries.map(w => [
          `📅 ${w.id}`,
          w.hrv        ? `   💓 HRV: ${w.hrv}` : null,
          w.restingHR  ? `   ❤️  Resting HR: ${w.restingHR} bpm` : null,
          w.sleepSecs  ? `   😴 Sleep: ${(w.sleepSecs/3600).toFixed(1)}h` : null,
          w.sleepScore ? `   💤 Sleep score: ${w.sleepScore}/100` : null,
          w.weight     ? `   ⚖️  ${w.weight} kg` : null,
          w.fatigue    != null ? `   😩 Fatigue: ${w.fatigue}/10` : null,
          w.mood       != null ? `   😊 Mood: ${w.mood}/10` : null,
          w.motivation != null ? `   🔥 Motivation: ${w.motivation}/10` : null,
          w.soreness   != null ? `   💪 Soreness: ${w.soreness}/10` : null,
          w.notes      ? `   📝 ${w.notes}` : null,
        ].filter(Boolean).join("\n"));
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
      }
    }
  );

  srv.tool("get_fitness",
    "Get CTL (fitness), ATL (fatigue), TSB (form) training load curves",
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
        if (!withLoad.length) {
          const sample = entries[entries.length - 1] || {};
          return { content: [{ type: "text", text: `⚠️ No CTL/ATL/TSB. Fields: ${Object.keys(sample).join(", ")}` }] };
        }
        const latest = withLoad[withLoad.length - 1];
        const rows   = withLoad.slice(-10).map(d =>
          `  ${d.id}  CTL ${fmt1(d.ctl).padStart(5)}  ATL ${fmt1(d.atl).padStart(5)}  TSB ${fmt1(d.tsb).padStart(6)}`
        );
        const header = `📊 TRAINING LOAD\nLatest (${latest.id}): CTL ${fmt1(latest.ctl)} | ATL ${fmt1(latest.atl)} | TSB ${fmt1(latest.tsb)}\n\nLast ${rows.length} days:\n`;
        return { content: [{ type: "text", text: header + rows.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
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
          `📅 ${(e.start_date_local || e.date || "").split("T")[0]} — ${e.name || "Event"} (${e.type || "Event"}) [ID:${e.id}]`,
          e.description ? `   📝 ${e.description}` : null,
          e.load        ? `   📊 Load: ${e.load}` : null,
          e.moving_time ? `   ⏱ ${fmtDuration(e.moving_time)}` : null,
        ].filter(Boolean).join("\n"));
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }] };
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
