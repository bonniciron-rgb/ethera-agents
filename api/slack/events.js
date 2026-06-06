import Anthropic from "@anthropic-ai/sdk";

const BOT_USER_ID = "U0B8R5AQRTL";
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

export default async function handler(req, res) {
  const body = req.body || {};
  if (body.type === "url_verification") return res.status(200).json({ challenge: body.challenge });
  if (req.headers["x-slack-retry-num"]) return res.status(200).end(); // ignore retries → no dupes

  const event = body.event || {};
  const isOwn = event.bot_id || event.user === BOT_USER_ID;
  const mentionsBot = event.text && event.text.includes(`<@${BOT_USER_ID}>`);

  if (event.type === "message" && !isOwn && mentionsBot) {
    const ask = event.text.replace(new RegExp(`<@${BOT_USER_ID}>`, "g"), "").trim();
    const reply = await think(ask);
    await postToSlack(event.channel, event.ts, reply);
  }
  return res.status(200).end();
}

async function think(prompt) {
  const r = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system:
      "You are ethera-agents, the AI operations assistant in the Lucida Origem / OnPoint team Slack (#panpm). Brands: Step Up Idiomas (English school), CasaMinder (property care), Ethera (marketing CRM). Reply concisely and usefully. You may draft, plan, summarise and report — all reversible. Never claim to have published, deployed, sent, or spent anything; those need Ron's approval. Sign off as \"— ethera-agents\".",
    messages: [{ role: "user", content: prompt || "Say hello to the team." }],
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
