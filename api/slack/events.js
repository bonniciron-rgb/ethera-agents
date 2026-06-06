const BOT_USER_ID = "U0B8R5AQRTL"; // ethera-agents

module.exports = async (req, res) => {
  const body = req.body || {};

  // Slack URL verification
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Ignore Slack's automatic retries (prevents duplicate replies)
  if (req.headers["x-slack-retry-num"]) return res.status(200).end();

  const event = body.event || {};
  const isOwn = event.bot_id || event.user === BOT_USER_ID;       // loop guard
  const mentionsBot = event.text && event.text.includes(`<@${BOT_USER_ID}>`);

  if (event.type === "message" && !isOwn && mentionsBot) {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: event.channel,
        thread_ts: event.ts,
        text: ":wave: ethera-agents is online and reading the channel — round-trip OK.",
      }),
    });
  }

  return res.status(200).end();
};
