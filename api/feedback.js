// POST /api/feedback — receives a visitor bug report / improvement idea and files it
// as a GitHub issue on the project repo. Runs as a Vercel Node serverless function.
//
// Requires ONE environment variable in the Vercel project:
//   GH_FEEDBACK_TOKEN  — a GitHub fine-grained PAT scoped to THIS repo only,
//                        with "Issues: Read and write" permission. Nothing else.
// Optional:
//   FEEDBACK_REPO      — "owner/name" override (default below).

const REPO = process.env.FEEDBACK_REPO || 'Edwardwang66/ucsd-easy-a-radar';
const MAX_DESC = 4000;
const MAX_CONTACT = 200;
const MIN_ELAPSED_MS = 2000; // a real human takes >2s to read + type

// --- rate limiting (best-effort, no external store) ---
// Vercel reuses a warm instance's module memory across invocations, so a client
// looping requests is throttled by whichever instance serves it. This is a
// circuit breaker, not a perfect cross-instance limiter: the global hourly cap
// bounds worst-case issue creation even when requests fan out to several
// instances, keeping the shared token well under GitHub's abuse thresholds.
const IP_WINDOW_MS = 60_000;        // per-IP sliding window
const IP_MAX = 5;                   // requests per IP per window
const GLOBAL_WINDOW_MS = 3_600_000; // global cap window (1h)
const GLOBAL_MAX = 30;              // issues created site-wide per window

const ipHits = new Map();           // ip -> number[] of recent request timestamps (ms)
let globalWindowStart = 0;
let globalCount = 0;

function clip(s, n) {
  return String(s == null ? '' : s).slice(0, n).trim();
}

// Neutralize GitHub @mentions and #refs in untrusted text so the feedback form
// can't be used to ping people or spam issue cross-references. A zero-width space
// after the sigil stops GitHub from linkifying it; the text still reads the same.
function defang(s) {
  return String(s == null ? '' : s).replace(/([@#])(?=[\w-])/g, '$1​');
}

function clientIp(req) {
  // On Vercel these headers are set by the edge proxy; the first x-forwarded-for
  // hop is the real client as seen by Vercel. Never trust a client-supplied value.
  const xr = req.headers['x-real-ip'];
  if (xr) return String(xr).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Records this request and returns true if the IP is over its per-window budget.
function ipRateLimited(ip) {
  const now = Date.now();
  const cutoff = now - IP_WINDOW_MS;
  const hits = (ipHits.get(ip) || []).filter((t) => t > cutoff);
  hits.push(now);
  ipHits.set(ip, hits);
  // Opportunistic cleanup so the map can't grow without bound under a spray of IPs.
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (!v.length || v[v.length - 1] <= cutoff) ipHits.delete(k);
    }
  }
  return hits.length > IP_MAX;
}

// Returns true if the site-wide issue-creation cap for the current window is hit.
function globalCapReached() {
  const now = Date.now();
  if (now - globalWindowStart >= GLOBAL_WINDOW_MS) {
    globalWindowStart = now;
    globalCount = 0;
  }
  return globalCount >= GLOBAL_MAX;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Vercel auto-parses JSON bodies; fall back to manual parse just in case.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // --- per-IP throttle (before any GitHub call, so a flood costs nothing) ---
  if (ipRateLimited(clientIp(req))) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, error: 'Too many requests — please wait a minute and try again.' });
  }

  // --- spam gates (best-effort, no external store) ---
  if (clip(body.website, 50)) {
    // honeypot field filled → bot. Pretend success so the bot doesn't retry.
    return res.status(200).json({ ok: true });
  }
  const elapsed = Number(body.elapsed) || 0;
  if (elapsed && elapsed < MIN_ELAPSED_MS) {
    return res.status(200).json({ ok: true }); // too fast to be human
  }

  const type = body.type === 'idea' ? 'idea' : 'bug';
  const desc = clip(body.description, MAX_DESC);
  const contact = clip(body.contact, MAX_CONTACT);
  const page = clip(body.page, 300);

  if (desc.length < 4) {
    return res.status(400).json({ ok: false, error: 'Description is too short.' });
  }

  const token = process.env.GH_FEEDBACK_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  const kind = type === 'idea' ? '💡 Idea' : '🐞 Bug';
  const firstLine = desc.split('\n')[0];
  const title = `[${type === 'idea' ? 'Idea' : 'Bug'}] ${clip(firstLine, 70)}`;
  const ua = clip(req.headers['user-agent'], 300);

  const issueBody = [
    `**Type:** ${kind}`,
    '',
    '**Report:**',
    '',
    defang(desc),
    '',
    '---',
    contact ? `**Contact:** ${defang(contact)}` : '**Contact:** _(not provided)_',
    page ? `**Page:** ${defang(page)}` : '',
    ua ? `**User agent:** \`${defang(ua).replace(/`/g, "'")}\`` : '',
    '',
    '_Filed automatically from the in-app feedback form._',
  ].filter(Boolean).join('\n');

  // --- global hourly cap: bounds total issue creation even across instances ---
  if (globalCapReached()) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ ok: false, error: 'Receiving a lot of feedback right now — please try again later.' });
  }
  globalCount++; // count optimistically; a failed create still spends budget (conservative)

  try {
    const gh = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'easy-a-radar-feedback',
      },
      body: JSON.stringify({
        title,
        body: issueBody,
        labels: ['feedback', type === 'idea' ? 'enhancement' : 'bug'],
      }),
    });

    if (!gh.ok) {
      const detail = await gh.text().catch(() => '');
      console.error('GitHub issue create failed', gh.status, detail);
      return res.status(502).json({ ok: false, error: 'Could not file the report.' });
    }

    const issue = await gh.json();
    return res.status(200).json({ ok: true, number: issue.number });
  } catch (err) {
    console.error('feedback error', err);
    return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
};
