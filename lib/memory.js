// lib/memory.js
//
// Persistent memory for ethera-agents (Step 2 of the activation plan).
//
// Two stores, both Upstash Redis REST (same pattern as Ethera stepup-wa):
//
//   1. Channel cursors — `slack:cursor:{channel}` holds the ts of the last
//      message we processed. On each invocation we read it, fetch the
//      Slack history between cursor → now, ground the model on that
//      context, then advance the cursor to the latest ts.
//
//   2. Per-persona scratch — `agent:{role}:scratch` holds a small JSON
//      blob the persona can read/write across invocations (last summary,
//      open todos, etc.). Bounded size; old entries trimmed.
//
// Both stores fail OPEN — a Redis hiccup never blocks a reply. The bot
// just runs cursor-less for that invocation.

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const CURSOR_KEY = (channel) => `slack:cursor:${channel}`;
const SCRATCH_KEY = (role)   => `agent:${role}:scratch`;

// How many minutes of #panpm history to ground the model with by default.
// 6h covers an overnight gap; longer windows risk leaking outside the
// current coordination thread.
const DEFAULT_LOOKBACK_MINUTES = 360;

async function redisCmd(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(REDIS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + REDIS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cmd),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result ?? null;
  } catch {
    return null;
  }
}

export async function loadCursor(channel) {
  if (!channel) return null;
  const raw = await redisCmd(["GET", CURSOR_KEY(channel)]);
  return raw || null;
}

export async function saveCursor(channel, ts) {
  if (!channel || !ts) return;
  await redisCmd(["SET", CURSOR_KEY(channel), String(ts)]);
}

export async function loadScratch(role) {
  if (!role) return null;
  const raw = await redisCmd(["GET", SCRATCH_KEY(role)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function saveScratch(role, blob) {
  if (!role) return;
  const json = JSON.stringify(blob).slice(0, 8000);
  await redisCmd(["SET", SCRATCH_KEY(role), json]);
}

// ─── Slack history fetcher ─────────────────────────────────────────────────
// Reads `conversations.history` for the given channel between `sinceTs` and
// now. Bounded so a single trigger can't accidentally pull a multi-day
// transcript and burn the model's context window.
//
// Returns an array of { ts, user, text } newest-first (Slack's default
// order). Caller is responsible for compacting/summarising before passing
// to the model.

const SLACK_API = "https://slack.com/api";
const MAX_MESSAGES = 50;     // hard cap regardless of window
const MAX_AGE_HOURS = 24;    // hard cap regardless of cursor

export async function fetchChannelHistory(channel, sinceTs) {
  if (!process.env.SLACK_BOT_TOKEN || !channel) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const minTs = nowSec - (MAX_AGE_HOURS * 3600);
  // Cursor `sinceTs` is a string like "1781701684.120489" — take the
  // float seconds part. Fall back to default lookback when missing.
  const cursorSec = sinceTs ? Number(String(sinceTs).split(".")[0]) : nowSec - (DEFAULT_LOOKBACK_MINUTES * 60);
  const oldest = String(Math.max(cursorSec, minTs));

  const url = `${SLACK_API}/conversations.history?channel=${encodeURIComponent(channel)}&oldest=${oldest}&limit=${MAX_MESSAGES}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (!res.ok) return [];
    const j = await res.json();
    if (!j?.ok || !Array.isArray(j.messages)) return [];
    return j.messages
      .filter((m) => m && !m.bot_id && m.text)
      .map((m) => ({
        ts:   m.ts,
        user: m.user || "unknown",
        text: String(m.text || "").slice(0, 1500),
      }));
  } catch {
    return [];
  }
}

// Compact a history array into a single string for the model prompt.
// Newest first → reverse to chronological so the model reads forward.
export function formatHistoryForPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const chrono = [...messages].reverse();
  const lines = chrono.map((m) => `[${m.ts} ${m.user}]: ${m.text}`);
  return lines.join("\n").slice(0, 12000);
}
