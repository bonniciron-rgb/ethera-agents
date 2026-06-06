module.exports = (req, res) => {
  const body = req.body || {};

  // Slack URL verification — echo the challenge
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Acknowledge all other events quickly
  return res.status(200).end();
};
