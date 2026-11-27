const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const DAY = 864e5;
const ukToday = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD

// Monday of the week containing the given YYYY-MM-DD date
function weekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}

const clean = (s, max) =>
  String(s || "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const week = weekStart(ukToday());
      const raw = (await redis.hgetall("lb:" + week)) || {};
      const players = Object.values(raw)
        .map(parse)
        .map((p) => ({
          username: p.u,
          university: p.c,
          total: Object.values(p.days).reduce((a, b) => a + b, 0),
          days: Object.keys(p.days).length,
        }))
        .sort(
          (a, b) =>
            b.total - a.total ||
            b.days - a.days ||
            a.username.localeCompare(b.username)
        )
        .slice(0, 100);
      return res.status(200).json({ week, players });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const u = clean(b.username, 20);
      const c = clean(b.university, 40);
      const score = Number(b.score);
      const date = String(b.date || "");

      if (u.length < 2 || c.length < 2)
        return res.status(400).json({ error: "Please enter a username and a university." });
      if (!Number.isInteger(score) || score < 0 || score > 75 || score % 5 !== 0)
        return res.status(400).json({ error: "Invalid score." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return res.status(400).json({ error: "Invalid date." });
      const diff =
        Math.abs(new Date(date + "T00:00:00Z") - new Date(ukToday() + "T00:00:00Z")) / DAY;
      if (!(diff <= 1))
        return res.status(400).json({ error: "That quiz date isn’t valid." });

      const key = "lb:" + weekStart(date);
      const field = (u + "|" + c).toLowerCase();
      const cur = await redis.hget(key, field);
      const p = cur ? parse(cur) : { u, c, days: {} };

      // first submission for a given day counts; later ones are ignored
      if (p.days[date] === undefined) {
        p.days[date] = score;
        p.u = u;
        p.c = c;
        await redis.hset(key, { [field]: JSON.stringify(p) });
        await redis.expire(key, 60 * 60 * 24 * 28);
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
