import Anthropic from "@anthropic-ai/sdk";

const BOT_USER_ID = "U0B8R5AQRTL";
const anthropic = new Anthropic();

const SHARED = `You operate in the Lucida Origem / OnPoint team Slack (#panpm). Brands: Step Up Idiomas (English school, Montijo), CasaMinder (property care, Setúbal), Ethera (marketing CRM). Reply concisely, Slack-style. You may draft, plan, analyse, summarise and report — all reversible. Never claim to have published, deployed, sent, or spent anything; those need Ron's ✅ — present the recommendation and flag it for approval instead. Work one step at a time.`;

const ROLES = {
  PM: { label: "PM 🤖", system: `You are the PM agent — sprint/project management. ${SHARED} Focus: sprint coordination, MoSCoW priorities (P0 bug → P1 must → P2 should → P3 could), tracking blockers, keeping the Confluence board current. Sign off "— PM 🤖".` },
  PA: { label: "PA", system: `You are the PA agent — assistant & operations support. ${SHARED} Focus: briefs, report analysis (SEO/GA4), content/build specs, scheduling, admin, compliance (e.g. Step Up off-peak price never shown publicly). Sign off "— PA".` },
};
const DEFAULT = { label: "ethera-agents", system: `You are ethera-agents, the team operations assistant. ${SHARED} Sign off "— ethera-agents".` };

function pickRole(text) {
  const t = (text || "").toUpperCase();
  if (t.includes("[PM]")) return ROLES.PM;
  if (t.includes("[PA]")) return ROLES.PA;
  return DEFAULT;
}

export default async function handler(req, res) {
  const body = req.body || {};
  if (body.type === "url_verification") return res.status(200).json({ challenge: body.challenge });
  if (req.headers["x-slack-retry-num"]) return res.status(200).end();

  const event = body.event || {};
  const isOwn = event.bot_id || event.user === BOT_USER_ID;       // loop guard
  const mentionsBot = event.text && event.text.includes(`<@${BOT_USER_ID}>`); // trigger gate

  if (event.type === "message" && !isOwn && mentionsBot) {
    const role = pickRole(event.text);
    const prompt = event.text
      .replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "")
      .replace(/\[(PM|PA)\]/gi, "")
      .trim();
    const reply = await think(role.system, prompt);
    await postToSlack(event.channel, event.ts, `*${role.label}*\n${reply}`);
  }
  return res.status(200).end();
}

async function think(system, prompt) {
  const r = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    system,
    messages: [{ role: "user", content: prompt || "Introduce yourself to the team." }],
  });
  return r.content.filter(c => c.type === "text").map(c => c.text).join("\n") || "(no reply)";
}

async function postToSlack(channel, thread_ts, text) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, thread_ts, text }),
  });
}
