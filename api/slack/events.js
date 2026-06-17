import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadCursor, saveCursor, fetchChannelHistory, formatHistoryForPrompt } from "../../lib/memory.js";

// ─── Identity + scope ──────────────────────────────────────────────────────
const BOT_USER_ID = process.env.BOT_SLACK_USER_ID || "U0B8R5AQRTL";
const RON_USER_ID = process.env.RON_SLACK_USER_ID || "U0B29L66W59"; // Ron Bonnici — non-secret, also in Confluence persona briefs. Env var optional override.
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || ""; // Step 1: signature verify
const SPACE_KEY = "LLO"; // Lucida Origem

const anthropic = new Anthropic();

const CONF = process.env.CONFLUENCE_BASE_URL; // https://ronbonnici.atlassian.net/wiki
const AUTH = "Basic " + Buffer.from(`${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_API_TOKEN}`).toString("base64");

// Surface misconfiguration at cold start instead of failing silently on the
// first tool call. Logged once per container; doesn't throw — the bot can
// still reply on Slack-only requests.
if (!CONF || !process.env.CONFLUENCE_EMAIL || !process.env.CONFLUENCE_API_TOKEN) {
  console.warn("[ethera-agents] Confluence env incomplete — confluence_* tools and persona briefs will fail.");
}

const SHARED = `You operate in the Lucida Origem / OnPoint team Slack (#panpm). Brands: Step Up Idiomas, CasaMinder, Ethera. You can read and write the Lucida Origem (LO) Confluence space via your confluence_* tools — the live sprint/strategy board is page 220364812 and the 30-day strategy is page 223608837. Read the board for current context before answering when relevant. Reply concisely, Slack-style. Coordination protocol: post TOP-LEVEL only (never threads), tag every reply as "[ROLE] -> [TO]: <topic>". You may draft, plan, analyse, and update LO Confluence (reversible). Never claim to have published externally, deployed to prod, sent client messages, or spent money — those need Ron's ✅. One step at a time.`;

const ROLES = {
  PM: { label: "PM", briefPageId: "229474306", system: `You are the PM agent — sprint/project management. ${SHARED} Focus: sprint coordination, MoSCoW priorities (P0→P3), blockers, keeping the board (220364812) current.` },
  PA: { label: "PA", system: `You are the PA agent — assistant & ops support. ${SHARED} Focus: briefs, report analysis (SEO/GA4), specs, scheduling, compliance (Step Up off-peak price never public).` },
  MK: { label: "MK", briefPageId: "229507074", system: `You are the Marketing/Content agent. ${SHARED} Focus: campaign briefs, content calendars, copy drafts (EN/PT), channel mix across Step Up / CasaMinder / Ethera.` },
  DS: { label: "DS", briefPageId: "229539841", system: `You are the Design agent. ${SHARED} Focus: visual direction, brand consistency across the three brands, asset specs, design QA notes.` },
};
const DEFAULT = { label: "ethera-agents", system: `You are ethera-agents, the team ops assistant. ${SHARED}` };

const TOOLS = [
  { name: "confluence_search",      description: "Search pages in the LO Confluence space by text.", input_schema: { type: "object", properties: { query:   { type: "string" } }, required: ["query"]   } },
  { name: "confluence_read_page",   description: "Read a Confluence page's text by id.",             input_schema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] } },
  { name: "confluence_create_page", description: "Create a new page in the LO space (content_html = Confluence storage HTML).", input_schema: { type: "object", properties: { title: { type: "string" }, content_html: { type: "string" }, parent_id: { type: "string" } }, required: ["title", "content_html"] } },
  { name: "confluence_update_page", description: "Replace a page's body by id (reversible via history).",                       input_schema: { type: "object", properties: { page_id: { type: "string" }, content_html: { type: "string" } },                          required: ["page_id", "content_html"] } },
];

async function conf(path, opts = {}) {
  const r = await fetch(`${CONF}${path}`, { ...opts, headers: { Authorization: AUTH, "Content-Type": "application/json", Accept: "application/json", ...(opts.headers || {}) } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`Confluence ${r.status}: ${typeof j === "string" ? j : JSON.stringify(j)}`);
  return j;
}
const stripHtml = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);

async function runTool(name, input) {
  if (name === "confluence_search") {
    const cql = encodeURIComponent(`space="${SPACE_KEY}" AND text~"${(input.query || "").replace(/"/g, '\\"')}"`);
    const d = await conf(`/rest/api/content/search?cql=${cql}&limit=10`);
    return (d.results || []).map((p) => `${p.id} — ${p.title}`).join("\n") || "No matches.";
  }
  if (name === "confluence_read_page") {
    const d = await conf(`/rest/api/content/${input.page_id}?expand=body.storage,version`);
    return `Title: ${d.title}\nVersion: ${d.version?.number}\n\n${stripHtml(d.body?.storage?.value)}`;
  }
  if (name === "confluence_create_page") {
    const body = { type: "page", title: input.title, space: { key: SPACE_KEY }, body: { storage: { value: input.content_html, representation: "storage" } } };
    if (input.parent_id) body.ancestors = [{ id: input.parent_id }];
    const d = await conf(`/rest/api/content`, { method: "POST", body: JSON.stringify(body) });
    return `Created ${d.id}: ${CONF}/spaces/${SPACE_KEY}/pages/${d.id}`;
  }
  if (name === "confluence_update_page") {
    const cur = await conf(`/rest/api/content/${input.page_id}?expand=version`);
    const body = { id: input.page_id, type: "page", title: cur.title, version: { number: (cur.version?.number || 1) + 1 }, body: { storage: { value: input.content_html, representation: "storage" } } };
    const d = await conf(`/rest/api/content/${input.page_id}`, { method: "PUT", body: JSON.stringify(body) });
    return `Updated ${d.id} to v${d.version?.number}.`;
  }
  return "Unknown tool.";
}

async function think(system, prompt) {
  const messages = [{ role: "user", content: prompt || "Introduce yourself to the team." }];
  let lastError = null;
  // Per-persona iteration cap. Bumped from 10 → 20: research/MK/DS tasks
  // routinely chain search → read several pages → draft, which blows
  // through 10. Still bounded so a runaway loop can't burn the budget.
  const MAX = 20;
  for (let i = 0; i < MAX; i++) {
    const r = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, system, tools: TOOLS, messages });
    const toolUses = r.content.filter((c) => c.type === "tool_use");
    if (toolUses.length === 0) {
      return r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "(no reply)";
    }
    messages.push({ role: "assistant", content: r.content });
    const results = [];
    for (const tu of toolUses) {
      let out;
      try { out = await runTool(tu.name, tu.input); }
      catch (e) { out = "Error: " + e.message; lastError = `${tu.name} → ${e.message}`; }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: String(out).slice(0, 6000) });
    }
    messages.push({ role: "user", content: results });
  }
  // Tool budget hit — force a final text answer (no tools) from what it has
  try {
    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 1000, system, tools: TOOLS,
      tool_choice: { type: "none" }, messages,
    });
    const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (text) return text + (lastError ? `\n\n_(tool note: ${lastError})_` : "");
  } catch (_) {}
  return `I couldn't finish within my tool budget.${lastError ? ` Last tool error: ${lastError}` : " No tool errors logged — try a narrower request."}`;
}

function pickRole(text) {
  const t = (text || "").toUpperCase();
  if (t.includes("[PM]")) return { ...ROLES.PM, key: "PM" };
  if (t.includes("[PA]")) return { ...ROLES.PA, key: "PA" };
  if (t.includes("[MK]")) return { ...ROLES.MK, key: "MK" };
  if (t.includes("[DS]")) return { ...ROLES.DS, key: "DS" };
  return { ...DEFAULT, key: "AGENT" };
}

// Confluence persona briefs — fetched once per cold start, cached in module
// memory. Fail-open: if the brief can't load, the role still runs on its
// inline system prompt.
const BRIEF_CACHE = new Map();
async function loadBrief(pageId) {
  if (!pageId) return "";
  if (BRIEF_CACHE.has(pageId)) return BRIEF_CACHE.get(pageId);
  try {
    const d = await conf(`/rest/api/content/${pageId}?expand=body.storage`);
    const text = stripHtml(d.body?.storage?.value);
    BRIEF_CACHE.set(pageId, text);
    return text;
  } catch {
    BRIEF_CACHE.set(pageId, "");
    return "";
  }
}

// ─── Vercel raw-body read for Slack signature verification ─────────────────
// Vercel's Node runtime parses JSON bodies before handing them to us. The
// Slack signature is computed over the RAW request body, so we need to read
// the stream directly before parsing. `req.body` (parsed JSON) is also
// available — we read both.
async function readRawBody(req) {
  if (req.rawBody) return req.rawBody.toString("utf8");
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Constant-time HMAC compare. Returns false on any length / hash mismatch.
function verifySlackSignature({ rawBody, timestamp, signature, secret }) {
  if (!secret) return false;                       // misconfigured deploy
  if (!timestamp || !signature) return false;
  // Reject anything older than 5 minutes (replay window per Slack docs).
  const fiveMinutes = 5 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
  } catch {
    return false;
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // 1. Read raw body BEFORE parsing — needed for signature verify.
  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch { return res.status(400).end(); }

  let body;
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { return res.status(400).end(); }

  // 2. URL verification (no signature yet — Slack ping during app config).
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 3. Slack signature verify on every other request.
  const ok = verifySlackSignature({
    rawBody,
    timestamp: req.headers["x-slack-request-timestamp"],
    signature: req.headers["x-slack-signature"],
    secret:    SLACK_SIGNING_SECRET,
  });
  if (!ok) {
    console.warn("[ethera-agents] slack signature rejected");
    return res.status(401).json({ error: "invalid-signature" });
  }

  // 4. Slack retry-storm guard.
  if (req.headers["x-slack-retry-num"]) return res.status(200).end();

  const event = body.event || {};
  const isOwn = event.bot_id || event.user === BOT_USER_ID;
  const mentionsBot = event.text && event.text.includes(`<@${BOT_USER_ID}>`);

  // 5. Per CSO DOD: triggered by Ron only. Any other user is ignored
  //    silently (still returns 200 so Slack doesn't retry).
  const triggeredByRon = RON_USER_ID && event.user === RON_USER_ID;
  if (event.type === "message" && !isOwn && mentionsBot && triggeredByRon) {
    const role = pickRole(event.text);
    const ask = event.text
      .replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "")
      .replace(/\[(PM|PA)\]/gi, "")
      .trim();

    // Ground on #panpm history since last cursor (fail-open).
    const cursor = await loadCursor(event.channel);
    const history = await fetchChannelHistory(event.channel, cursor);
    const ctx = formatHistoryForPrompt(history);
    const prompt = ctx
      ? `Recent #panpm activity (chronological):\n${ctx}\n\n---\nRon just asked:\n${ask}`
      : ask;

    const brief = await loadBrief(role.briefPageId);
    const system = brief ? `${role.system}\n\n--- Persona brief (Confluence ${role.briefPageId}) ---\n${brief}` : role.system;
    const reply = await think(system, prompt);
    // Advance cursor so next invocation only sees newer messages.
    if (event.ts) await saveCursor(event.channel, event.ts);
    // CSO protocol: TOP-LEVEL posts only, never in thread. Output tagged
    // [ROLE] -> [Ron]: <topic> on the first line so threads-of-threads
    // can't accidentally form.
    const text = `[${role.key}] -> [Ron]: ${reply}`;
    await postToSlack(event.channel, text);
  } else if (event.type === "message" && !isOwn && mentionsBot && !triggeredByRon) {
    console.warn(`[ethera-agents] mention from non-Ron user ${event.user} ignored (DOD: Ron-only trigger).`);
  }
  return res.status(200).end();
}

async function postToSlack(channel, text) {
  // Per CSO coordination-reset protocol (20:11 BST 2026-06-16): all
  // coordination is TOP-LEVEL. We deliberately do NOT pass thread_ts.
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, text }),
  });
}
