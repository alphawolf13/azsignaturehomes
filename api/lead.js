/* Lead relay for the azsignaturehomes.com forms.

   The forms used to post straight to the GHL inbound webhook, so its URL sat in the page
   source (and in this public repo) and bots posted to it directly, signing up strangers'
   email addresses. Now every form posts here. A lead only reaches GHL when Cloudflare
   Turnstile confirms a person sent it. The webhook URL lives only in Vercel's environment.

   Vercel environment variables (Production):
     TURNSTILE_SECRET   secret key of the Turnstile widget for azsignaturehomes.com
     GHL_WEBHOOK_URL    inbound webhook URL of "22 - Website Lead Intake (inbound webhook)"
   Neither value belongs in this file. */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const HOSTS = ["azsignaturehomes.com", "www.azsignaturehomes.com"];

/* The only fields passed on to GHL, matching what workflow 22 already maps. */
const FIELDS = ["firstName", "lastName", "email", "phone", "intent", "neighborhood",
                "message", "source", "type", "pageUrl", "consent"];

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false });
  }

  const secret = process.env.TURNSTILE_SECRET;
  const hook = process.env.GHL_WEBHOOK_URL;
  if (!secret || !hook) return res.status(500).json({ ok: false, error: "not-configured" });

  const body = typeof req.body === "string"
    ? Object.fromEntries(new URLSearchParams(req.body))
    : (req.body || {});

  /* Hidden trap field: a person never fills it. Answer as if it worked so the bot learns nothing. */
  if (body.company) return res.status(200).json({ ok: true });

  const token = clean(body["cf-turnstile-response"], 2048);
  if (!token) return res.status(400).json({ ok: false, error: "no-check" });

  const ip = clean(String(req.headers["x-forwarded-for"] || "").split(",")[0], 64);
  let check;
  try {
    const r = await fetch(VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret: secret, response: token, remoteip: ip })
    });
    check = await r.json();
  } catch (e) {
    return res.status(502).json({ ok: false, error: "check-unreachable" });
  }
  if (!check.success || (check.hostname && HOSTS.indexOf(check.hostname) === -1)) {
    return res.status(403).json({ ok: false, error: "check-failed" });
  }

  const lead = {};
  FIELDS.forEach(function (k) {
    if (k in body) lead[k] = clean(body[k], k === "message" ? 2000 : 300);
  });
  if (!lead.firstName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    return res.status(400).json({ ok: false, error: "invalid" });
  }

  try {
    const g = await fetch(hook, { method: "POST", body: new URLSearchParams(lead) });
    if (!g.ok) return res.status(502).json({ ok: false, error: "crm-" + g.status });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "crm-unreachable" });
  }
  return res.status(200).json({ ok: true });
};
