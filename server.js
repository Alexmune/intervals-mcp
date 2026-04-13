import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID;
const PORT = process.env.PORT || 3000;
const BASE_URL = "https://intervals.icu/api/v1";

if (!API_KEY || !ATHLETE_ID) {
  console.error("❌ Missing INTERVALS_API_KEY or INTERVALS_ATHLETE_ID environment variables");
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
    throw new Error(`Intervals API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "intervals-mcp",
  version: "1.0.0",
});

// ── Tool: get_activities ──────────────────────────────────────────────────────
server.tool(
  "get_activities",
  "Get recent activities from intervals.icu with full metrics (distance, pace, HR, power, TSS, etc.)",
  {
    oldest: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
    newest: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    limit: z.number().optional().describe("Max number of activities (default: 20)"),
  },
  async ({ oldest, newest, limit = 20 }) => {
    const today = new Date().toISOString().split("T")[0];
    const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const params = new URLSearchParams({
      oldest: oldest || thirtyAgo,
      newest: newest || today,
    });
    const data = await callIntervals(`/athlete/${ATHLETE_ID}/activities?${params}`);
    const activities = Array.isArray(data) ? data.slice(0, limit) : [];
    if (activities.length === 0) return { content: [{ type: "text", text: "No activities found in this range." }] };

    const summary = activities.map((a) => {
      const lines = [
        `📅 ${a.start_date_local?.split("T")[0]} — ${a.name} (${a.type})`,
        `   ⏱ Duration: ${Math.round((a.moving_time || 0) / 60)} min`,
        a.distance ? `   📏 Distance: ${(a.distance / 1000).toFixed(2)} km` : null,
        a.average_heartrate ? `   ❤️  Avg HR: ${Math.round(a.average_heartrate)} bpm` : null,
        a.average_watts ? `   ⚡ Avg Power: ${Math.round(a.average_watts)} W` : null,
        a.average_speed ? `   🏃 Avg Pace: ${(1000 / a.average_speed / 60).toFixed(2)} min/km` : null,
        a.total_elevation_gain ? `   ⛰️  Elevation: ${Math.round(a.total_elevation_gain)} m` : null,
        a.tss ? `   📊 TSS: ${Math.round(a.tss)}` : null,
        a.calories ? `   🔥 Calories: ${Math.round(a.calories)} kcal` : null,
        a.perceived_exertion ? `   😓 RPE: ${a.perceived_exertion}/10` : null,
      ].filter(Boolean);
      return lines.join("\n");
    });

    return { content: [{ type: "text", text: summary.join("\n\n") }] };
  }
);

// ── Tool: get_wellness ────────────────────────────────────────────────────────
server.tool(
  "get_wellness",
  "Get wellness data: HRV, resting HR, sleep, weight, fatigue, mood, motivation",
  {
    start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 14 days ago)"),
    end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
  },
  async ({ start_date, end_date }) => {
    const today = new Date().toISOString().split("T")[0];
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
    const params = new URLSearchParams({
      oldest: start_date || twoWeeksAgo,
      newest: end_date || today,
    });
    const data = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
    const entries = Array.isArray(data) ? data : [];
    if (entries.length === 0) return { content: [{ type: "text", text: "No wellness data found." }] };

    const summary = entries.map((w) => {
      const lines = [
        `📅 ${w.id}`,
        w.hrv ? `   💓 HRV: ${w.hrv}` : null,
        w.restingHR ? `   ❤️  Resting HR: ${w.restingHR} bpm` : null,
        w.sleepSecs ? `   😴 Sleep: ${(w.sleepSecs / 3600).toFixed(1)}h` : null,
        w.sleepScore ? `   💤 Sleep score: ${w.sleepScore}` : null,
        w.weight ? `   ⚖️  Weight: ${w.weight} kg` : null,
        w.fatigue != null ? `   😩 Fatigue: ${w.fatigue}/10` : null,
        w.mood != null ? `   😊 Mood: ${w.mood}/10` : null,
        w.motivation != null ? `   🔥 Motivation: ${w.motivation}/10` : null,
        w.soreness != null ? `   💪 Soreness: ${w.soreness}/10` : null,
        w.notes ? `   📝 Notes: ${w.notes}` : null,
      ].filter(Boolean);
      return lines.join("\n");
    });

    return { content: [{ type: "text", text: summary.join("\n\n") }] };
  }
);

// ── Tool: get_fitness ─────────────────────────────────────────────────────────
server.tool(
  "get_fitness",
  "Get CTL (fitness), ATL (fatigue) and TSB (form/freshness) curves",
  {
    start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 42 days ago)"),
    end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
  },
  async ({ start_date, end_date }) => {
    const today = new Date().toISOString().split("T")[0];
    const sixWeeksAgo = new Date(Date.now() - 42 * 86400000).toISOString().split("T")[0];
    const params = new URLSearchParams({
      oldest: start_date || sixWeeksAgo,
      newest: end_date || today,
    });
    const data = await callIntervals(`/athlete/${ATHLETE_ID}/wellness?${params}`);
    const entries = Array.isArray(data) ? data : [];
    if (entries.length === 0) return { content: [{ type: "text", text: "No fitness data found." }] };

    const recent = entries.slice(-7);
    const summary = recent.map((d) => {
      const lines = [
        `📅 ${d.id}`,
        d.ctl != null ? `   📈 CTL (Fitness): ${d.ctl?.toFixed(1)}` : null,
        d.atl != null ? `   📉 ATL (Fatigue): ${d.atl?.toFixed(1)}` : null,
        d.tsb != null ? `   ⚖️  TSB (Form): ${d.tsb?.toFixed(1)}` : null,
      ].filter(Boolean);
      return lines.join("\n");
    });

    const latest = entries[entries.length - 1];
    const header = `📊 FITNESS SUMMARY (last 6 weeks)\n${"─".repeat(40)}\nLatest values:\n   CTL: ${latest?.ctl?.toFixed(1) ?? "N/A"} | ATL: ${latest?.atl?.toFixed(1) ?? "N/A"} | TSB: ${latest?.tsb?.toFixed(1) ?? "N/A"}\n\nLast 7 days:\n`;

    return { content: [{ type: "text", text: header + summary.join("\n\n") }] };
  }
);

// ── Tool: get_events ──────────────────────────────────────────────────────────
server.tool(
  "get_events",
  "Get planned workouts and events from the intervals.icu calendar",
  {
    start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: today)"),
    end_date: z.string().optional().describe("End date YYYY-MM-DD (default: 14 days from now)"),
  },
  async ({ start_date, end_date }) => {
    const today = new Date().toISOString().split("T")[0];
    const twoWeeksOut = new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0];
    const params = new URLSearchParams({
      oldest: start_date || today,
      newest: end_date || twoWeeksOut,
    });
    const data = await callIntervals(`/athlete/${ATHLETE_ID}/events?${params}`);
    const events = Array.isArray(data) ? data : [];
    if (events.length === 0) return { content: [{ type: "text", text: "No planned events found." }] };

    const summary = events.map((e) => {
      const lines = [
        `📅 ${e.start_date_local?.split("T")[0]} — ${e.name} (${e.type || "Event"})`,
        e.description ? `   📝 ${e.description}` : null,
        e.load ? `   📊 Target TSS/Load: ${e.load}` : null,
      ].filter(Boolean);
      return lines.join("\n");
    });

    return { content: [{ type: "text", text: summary.join("\n\n") }] };
  }
);

// ── Tool: create_event ────────────────────────────────────────────────────────
server.tool(
  "create_event",
  "Create a workout or event in the intervals.icu calendar",
  {
    date: z.string().describe("Date YYYY-MM-DD"),
    name: z.string().describe("Workout name"),
    type: z.string().optional().describe("Type: Run, Ride, Swim, WeightTraining, Rest, etc."),
    description: z.string().optional().describe("Full workout description with details, zones, structure"),
    load: z.number().optional().describe("Target TSS/load for the session"),
    duration_mins: z.number().optional().describe("Planned duration in minutes"),
  },
  async ({ date, name, type = "Run", description, load, duration_mins }) => {
    const body = {
      start_date_local: `${date}T08:00:00`,
      name,
      type,
      description: description || "",
      load_target: load || null,
      moving_time: duration_mins ? duration_mins * 60 : null,
    };
    const data = await callIntervals(`/athlete/${ATHLETE_ID}/events`, "POST", body);
    return {
      content: [{ type: "text", text: `✅ Workout created successfully!\n📅 ${date} — ${name}\n🆔 ID: ${data.id || "created"}` }],
    };
  }
);

// ── Tool: update_wellness ─────────────────────────────────────────────────────
server.tool(
  "update_wellness",
  "Update wellness data for a day (HRV, sleep, fatigue, mood, notes, weight)",
  {
    date: z.string().describe("Date YYYY-MM-DD"),
    hrv: z.number().optional().describe("HRV value"),
    resting_hr: z.number().optional().describe("Resting heart rate"),
    sleep_secs: z.number().optional().describe("Sleep duration in seconds"),
    sleep_score: z.number().optional().describe("Sleep quality score"),
    weight: z.number().optional().describe("Weight in kg"),
    fatigue: z.number().optional().describe("Fatigue 1-10"),
    mood: z.number().optional().describe("Mood 1-10"),
    motivation: z.number().optional().describe("Motivation 1-10"),
    soreness: z.number().optional().describe("Muscle soreness 1-10"),
    notes: z.string().optional().describe("Personal notes for the day"),
  },
  async ({ date, hrv, resting_hr, sleep_secs, sleep_score, weight, fatigue, mood, motivation, soreness, notes }) => {
    const body = {
      id: date,
      ...(hrv != null && { hrv }),
      ...(resting_hr != null && { restingHR: resting_hr }),
      ...(sleep_secs != null && { sleepSecs: sleep_secs }),
      ...(sleep_score != null && { sleepScore: sleep_score }),
      ...(weight != null && { weight }),
      ...(fatigue != null && { fatigue }),
      ...(mood != null && { mood }),
      ...(motivation != null && { motivation }),
      ...(soreness != null && { soreness }),
      ...(notes && { notes }),
    };
    await callIntervals(`/athlete/${ATHLETE_ID}/wellness/${date}`, "PUT", body);
    return { content: [{ type: "text", text: `✅ Wellness updated for ${date}` }] };
  }
);

// ── Tool: get_athlete_profile ─────────────────────────────────────────────────
server.tool(
  "get_athlete_profile",
  "Get athlete profile: zones, FTP, max HR, thresholds",
  {},
  async () => {
    const data = await callIntervals(`/athlete/${ATHLETE_ID}`);
    const lines = [
      `👤 Athlete: ${data.name || "N/A"}`,
      data.city ? `📍 Location: ${data.city}` : null,
      data.sex ? `⚧ Sex: ${data.sex}` : null,
      data.dob ? `🎂 DOB: ${data.dob}` : null,
      data.weight ? `⚖️  Weight: ${data.weight} kg` : null,
      data.ftp ? `⚡ FTP: ${data.ftp} W` : null,
      data.lthr ? `❤️  LTHR: ${data.lthr} bpm` : null,
      data.maxHR ? `💓 Max HR: ${data.maxHR} bpm` : null,
      data.runningFTP ? `🏃 Running FTP pace: ${data.runningFTP}` : null,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool: delete_event ────────────────────────────────────────────────────────
server.tool(
  "delete_event",
  "Delete a planned event or workout from the calendar",
  {
    event_id: z.number().describe("Event ID to delete (get it from get_events)"),
  },
  async ({ event_id }) => {
    await callIntervals(`/athlete/${ATHLETE_ID}/events/${event_id}`, "DELETE");
    return { content: [{ type: "text", text: `✅ Event ${event_id} deleted successfully.` }] };
  }
);

// ─── Express + SSE transport ──────────────────────────────────────────────────
const app = express();
const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.get("/health", (_, res) => res.json({ status: "ok", server: "intervals-mcp" }));

app.listen(PORT, () => {
  console.log(`✅ Intervals MCP Server running on port ${PORT}`);
  console.log(`   Athlete ID: ${ATHLETE_ID}`);
  console.log(`   SSE endpoint: http://localhost:${PORT}/sse`);
});
