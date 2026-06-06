import Anthropic from "@anthropic-ai/sdk";

const BOT_USER_ID = "U0B8R5AQRTL";
const SPACE_KEY = "LLO"; // Lucida Origem
const anthropic = new Anthropic();

const CONF = process.env.CONFLUENCE_BASE_URL; // https://ronbonnici.atlassian.net/wiki
const AUTH = "Basic " + Buffer.from(`${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_API_TOKEN}`).toString("base64");

const SHARED = `You operate in the Lucida Origem / OnPoint team Slack (#panpm). Brands: Step Up Idiomas, CasaMinder, Ethera. You can read and write the Lucida Origem (LO) Confluence space via your confluence_* tools — the live sprint/strategy board is page 220364812 and the 30-day strategy is page 223608837. Read the board for current context before answering when relevant. Reply concisely, Slack-style. You may draft, plan, analyse, and update LO Confluence (reversible). Never claim to have published externally, deployed to prod, sent client messages, or spent money — those need Ron's ✅. One step at a time.`;

const ROLES = {
  PM: { label: "PM 🤖", system: `You are the PM agent — sprint/project management. ${SHARED} Focus: sprint coordination, MoSCoW priorities (P0→P3), blockers, keeping the board (220364812) current. Sign "— PM 🤖".` },
  PA: { label: "PA", system: `You are the PA agent — assistant & ops support. ${SHARED} Focus: briefs, report analysis (SEO/GA4), specs, scheduling, compliance (Step Up off-peak price never public). Sign "— PA".` },
};
const DEFAULT = { label: "ethera-agents", system: `You are ethera-agents, the team ops assistant. ${SHARED} Sign "— ethera-agents".` };

const TOOLS = [
  { name: "confluence_search", description: "Search pages in the LO Confluence space by text.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "confluence_read_page", description: "Read a Confluence page's text by id.", input_schema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] } },
  { name: "confluence_create_page", description: "Create a new page in the LO space (content_html = Confluence storage HTML).", input_schema: { type: "object", properties: { title: { type: "string" }, content_html: { type: "string" }, parent_id: { type: "string" } }, required: ["title", "content_html"] } },
  { name: "confluence_update_page", description: "Replace a page's body by id (reversible via history).", input_schema: { type: "object", properties: { page_id: { type: "string" }, content_html: { type: "string" } }, required: ["page_id", "content_html"] } },
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
  const MAX = 10;
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

function pickRole(text) { const t = (text || "").toUpperCase(); if (t.includes("[PM]")) return ROLES.PM; if (t.includes("[PA]")) return ROLES.PA; return DEFAULT; }

export default async function handler(req, res) {
  const body = req.body || {};
  if (body.type === "url_verification") return res.status(200).json({ challenge: body.challenge });
  if (req.headers["x-slack-retry-num"]) return res.status(200).end();

  const event = body.event || {};
  const isOwn = event.bot_id || event.user === BOT_USER_ID;
  const mentionsBot = event.text && event.text.includes(`<@${BOT_USER_ID}>`);
  if (event.type === "message" && !isOwn && mentionsBot) {
    const role = pickRole(event.text);
    const prompt = event.text.replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "").replace(/\[(PM|PA)\]/gi, "").trim();
    const reply = await think(role.system, prompt);
    await postToSlack(event.channel, event.ts, `*${role.label}*\n${reply}`);
  }
  return res.status(200).end();
}

async function postToSlack(channel, thread_ts, text) {
  await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, body: JSON.stringify({ channel, thread_ts, text }) });
}
