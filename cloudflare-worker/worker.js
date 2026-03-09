/**
 * Copilot Adoption Tracker — Cloudflare Worker API
 *
 * Exposes the tracker data from a GitHub Gist as a public REST API.
 * The GitHub PAT is stored as a Worker Secret (never exposed to clients).
 *
 * Environment variables (set via wrangler secret or dashboard):
 *   GIST_ID  — GitHub Gist ID (required)
 *   GH_PAT   — GitHub Personal Access Token (optional; required for private gists)
 *
 * Routes:
 *   GET /                          → API index / health check
 *   GET /data                      → raw tracker JSON
 *   GET /summary                   → dashboard totals
 *   GET /customers                 → all customers (metadata + adoption %)
 *   GET /customers/:name           → single customer full detail
 *   GET /blocked                   → all blocked items
 *   GET /pending                   → all pending (not-started) items
 *   GET /search?q=<query>          → search customers by name / AE / CSAM / SE / ATS
 *   GET /filter?min=<n>&max=<n>    → customers by adoption % range
 *   GET /pillar/:name              → pillar summary across all customers
 */

// ── Cache (in-memory, per isolate, 30 s TTL) ─────────────────────────────────
const CACHE_TTL = 30_000;
let _cache = null;
let _cacheTime = 0;

const GH_FILE = 'copilot-tracker-data.json';

const STATUS_LABELS = {
  done:    'Done / Will Happen',
  missed:  "Didn't Happen",
  blocked: 'Blocked',
  unblock: 'Unblocking',
  pending: 'Not Started',
};

// ── Fetch data from Gist ──────────────────────────────────────────────────────
async function fetchData(env) {
  const { GIST_ID, GH_PAT } = env;
  if (!GIST_ID) throw new ApiError(500, 'GIST_ID is not configured on the Worker.');

  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'copilot-tracker-worker/1.0',
  };
  if (GH_PAT) headers.Authorization = `token ${GH_PAT}`;

  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers });
  if (res.status === 404) throw new ApiError(404, 'Gist not found — check GIST_ID.');
  if (res.status === 401) throw new ApiError(401, 'GitHub auth failed — check GH_PAT.');
  if (!res.ok) throw new ApiError(502, `GitHub API returned ${res.status}.`);

  const gist = await res.json();
  const file = gist.files[GH_FILE];
  if (!file) throw new ApiError(404, `File "${GH_FILE}" not found in Gist ${GIST_ID}.`);

  const rawRes = file.truncated
    ? await fetch(file.raw_url, { headers })
    : null;

  const content = rawRes ? await rawRes.text() : file.content;

  _cache = JSON.parse(content);
  _cacheTime = now;
  return _cache;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function custStats(customer) {
  let done = 0, total = 0, blocked = 0, missed = 0, pending = 0;
  for (const cat of customer.categories || []) {
    for (const item of cat.items || []) {
      total++;
      if (item.status === 'done')         done++;
      else if (item.status === 'blocked') blocked++;
      else if (item.status === 'missed')  missed++;
      else                                pending++;
    }
  }
  return { done, total, blocked, missed, pending, pct: total ? Math.round(done / total * 100) : 0 };
}

function formatCustomer(c, full = false) {
  const s = custStats(c);
  const out = {
    id:            c.id,
    name:          c.name,
    adoptionPct:   s.pct,
    itemsDone:     s.done,
    itemsTotal:    s.total,
    itemsBlocked:  s.blocked,
    itemsMissed:   s.missed,
    itemsPending:  s.pending,
    users:         c.users,
    copilotUsers:  c.copilotUsers,
    renewalDate:   c.renewalDate,
    aopDate:       c.aopDate,
    aeName:        c.aeName,
    atsName:       c.atsName,
    csamName:      c.csamName,
    seName:        c.seName,
    createdAt:     c.createdAt,
  };
  if (full) {
    out.pillars = (c.categories || []).map(cat => ({
      id:    cat.id,
      title: cat.title,
      icon:  cat.icon,
      items: (cat.items || []).map(i => ({
        id:     i.id,
        label:  i.label,
        status: STATUS_LABELS[i.status] || i.status,
      })),
    }));
  }
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=30',
    },
  });
}

function err(status, message) {
  return json({ error: message }, status);
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'GET') return err(405, 'Method not allowed. Use GET.');

    try {
      // ── GET / ── health / index ──────────────────────────────────────────
      if (path === '/') {
        return json({
          app:     'Copilot Adoption Tracker API',
          version: '1.0',
          routes: {
            'GET /data':                 'Raw tracker JSON',
            'GET /summary':              'Dashboard totals',
            'GET /customers':            'All customers',
            'GET /customers/:name':      'Single customer full detail',
            'GET /blocked':              'All blocked items',
            'GET /pending':              'All pending items',
            'GET /search?q=':           'Search customers',
            'GET /filter?min=&max=':    'Filter by adoption % range',
            'GET /pillar/:name':         'Pillar summary across customers',
          },
        });
      }

      const data      = await fetchData(env);
      const customers = data.customers || [];

      // ── GET /data ────────────────────────────────────────────────────────
      if (path === '/data') {
        // Strip logo binary data to keep response lean
        const slim = {
          ...data,
          customers: customers.map(c => ({ ...c, logo: c.logo ? '[omitted]' : null, logoDataUrl: undefined })),
        };
        return json(slim);
      }

      // ── GET /summary ─────────────────────────────────────────────────────
      if (path === '/summary') {
        let totalItems = 0, done = 0, blocked = 0, missed = 0, pending = 0;
        for (const c of customers) {
          const s = custStats(c);
          totalItems += s.total;
          done       += s.done;
          blocked    += s.blocked;
          missed     += s.missed;
          pending    += s.pending;
        }
        const avgPct = customers.length
          ? Math.round(customers.reduce((sum, c) => sum + custStats(c).pct, 0) / customers.length)
          : 0;
        return json({
          totalCustomers: customers.length,
          averageAdoptionPct: avgPct,
          totalItems,
          itemsDone: done,
          itemsBlocked: blocked,
          itemsMissed: missed,
          itemsPending: pending,
          lastSaved: data._saved || null,
        });
      }

      // ── GET /customers ───────────────────────────────────────────────────
      if (path === '/customers') {
        return json(customers.map(c => formatCustomer(c, false)));
      }

      // ── GET /customers/:name ─────────────────────────────────────────────
      const customerMatch = path.match(/^\/customers\/(.+)$/);
      if (customerMatch) {
        const q = decodeURIComponent(customerMatch[1]).toLowerCase();
        const c = customers.find(c => c.name.toLowerCase().includes(q));
        if (!c) return err(404, `No customer matching "${q}".`);
        return json(formatCustomer(c, true));
      }

      // ── GET /blocked ─────────────────────────────────────────────────────
      if (path === '/blocked') {
        const result = [];
        for (const c of customers) {
          for (const cat of c.categories || []) {
            const blocked = (cat.items || []).filter(i => i.status === 'blocked');
            if (blocked.length) result.push({
              customer: c.name,
              pillar:   cat.title,
              items:    blocked.map(i => i.label),
            });
          }
        }
        return json(result);
      }

      // ── GET /pending ─────────────────────────────────────────────────────
      if (path === '/pending') {
        const result = [];
        for (const c of customers) {
          for (const cat of c.categories || []) {
            const pending = (cat.items || []).filter(i => i.status === 'pending');
            if (pending.length) result.push({
              customer: c.name,
              pillar:   cat.title,
              items:    pending.map(i => i.label),
            });
          }
        }
        return json(result);
      }

      // ── GET /search?q= ───────────────────────────────────────────────────
      if (path === '/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase().trim();
        if (!q) return err(400, 'Missing query param: ?q=<search term>');
        const fields = ['name', 'aeName', 'atsName', 'csamName', 'seName'];
        const hits = customers.filter(c =>
          fields.some(f => (c[f] || '').toLowerCase().includes(q))
        );
        return json(hits.map(c => formatCustomer(c, false)));
      }

      // ── GET /filter?min=&max= ────────────────────────────────────────────
      if (path === '/filter') {
        const min = parseFloat(url.searchParams.get('min') ?? '0');
        const max = parseFloat(url.searchParams.get('max') ?? '100');
        if (isNaN(min) || isNaN(max)) return err(400, 'min and max must be numbers between 0–100.');
        const hits = customers
          .map(c => ({ ...formatCustomer(c, false) }))
          .filter(c => c.adoptionPct >= min && c.adoptionPct <= max);
        return json(hits);
      }

      // ── GET /pillar/:name ────────────────────────────────────────────────
      const pillarMatch = path.match(/^\/pillar\/(.+)$/);
      if (pillarMatch) {
        const q = decodeURIComponent(pillarMatch[1]).toLowerCase();
        const result = [];
        for (const c of customers) {
          for (const cat of c.categories || []) {
            if (!cat.title.toLowerCase().includes(q)) continue;
            const done    = (cat.items || []).filter(i => i.status === 'done').length;
            const blocked = (cat.items || []).filter(i => i.status === 'blocked').length;
            const total   = (cat.items || []).length;
            result.push({
              customer: c.name,
              pillar:   cat.title,
              done, blocked, total,
              pct:      total ? Math.round(done / total * 100) : 0,
              items:    (cat.items || []).map(i => ({
                label:  i.label,
                status: STATUS_LABELS[i.status] || i.status,
              })),
            });
          }
        }
        if (!result.length) return err(404, `No pillar matching "${q}".`);
        return json(result);
      }

      return err(404, 'Route not found. GET / for available routes.');

    } catch (e) {
      if (e instanceof ApiError) return err(e.status, e.message);
      console.error(e);
      return err(500, 'Internal server error.');
    }
  },
};
