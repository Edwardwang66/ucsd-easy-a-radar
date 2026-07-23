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

function clip(s, n) {
  return String(s == null ? '' : s).slice(0, n).trim();
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
    desc,
    '',
    '---',
    contact ? `**Contact:** ${contact}` : '**Contact:** _(not provided)_',
    page ? `**Page:** ${page}` : '',
    ua ? `**User agent:** \`${ua}\`` : '',
    '',
    '_Filed automatically from the in-app feedback form._',
  ].filter(Boolean).join('\n');

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
