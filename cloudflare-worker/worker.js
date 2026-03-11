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

// ── MCP Tools definition ──────────────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: 'get_summary',
    description: 'Get the overall dashboard summary: total customers, average adoption %, blocked count, and last-saved timestamp.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_customers',
    description: 'List all customers with their key metadata (name, AE, CSAM, users, renewal date) and adoption %.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_customer',
    description: 'Get full details for a specific customer including all Copilot pillars and the status of every item.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Customer name (partial match, case-insensitive)' } },
      required: ['name'],
    },
  },
  {
    name: 'get_blocked_items',
    description: 'Return blocked items. Pass an optional customer name to filter to one customer (e.g. "what is blocked for AMDOCS?"). Omit customer to get all blocked items across every customer.',
    inputSchema: { type: 'object', properties: { customer: { type: 'string', description: 'Optional customer name filter (partial match, case-insensitive)' } }, required: [] },
  },
  {
    name: 'get_pending_items',
    description: 'Return not-started items. Pass an optional customer name to filter to one customer. Omit customer to get all pending items across every customer.',
    inputSchema: { type: 'object', properties: { customer: { type: 'string', description: 'Optional customer name filter (partial match, case-insensitive)' } }, required: [] },
  },
  {
    name: 'search_customers',
    description: 'Search customers by any field: name, AE name, CSAM, SE, ATS. Returns matching customers with adoption stats.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search term (partial match, case-insensitive)' } },
      required: ['query'],
    },
  },
  {
    name: 'get_customers_by_status',
    description: 'Filter customers whose adoption percentage falls within a given range.',
    inputSchema: {
      type: 'object',
      properties: {
        min_pct: { type: 'number', description: 'Minimum adoption % (0-100)' },
        max_pct: { type: 'number', description: 'Maximum adoption % (0-100)' },
      },
      required: ['min_pct', 'max_pct'],
    },
  },
  {
    name: 'get_pillar_summary',
    description: 'Show adoption progress for a specific Copilot pillar (e.g. "Copilot 365", "Copilot Studio") across all customers.',
    inputSchema: {
      type: 'object',
      properties: { pillar: { type: 'string', description: 'Pillar name (partial match)' } },
      required: ['pillar'],
    },
  },
];

// ── Fuzzy customer finder ─────────────────────────────────────────────────────
// 1. exact substring  2. anagram (sorted chars equal)  3. best Levenshtein
function findCustomer(customers, query) {
  const q = query.toLowerCase().replace(/\s+/g, '');

  // 1. substring
  let match = customers.find(c => c.name.toLowerCase().includes(q));
  if (match) return match;

  // 2. anagram / sorted-char equality (catches AMDOCS ↔ AMODCS)
  const sortedQ = q.split('').sort().join('');
  match = customers.find(c => c.name.toLowerCase().replace(/\s+/g, '').split('').sort().join('') === sortedQ);
  if (match) return match;

  // 3. Levenshtein — pick best if distance ≤ 3
  function lev(a, b) {
    const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = i;
      for (let j = 1; j <= b.length; j++) {
        const val = a[i - 1] === b[j - 1] ? dp[j - 1] : 1 + Math.min(dp[j - 1], dp[j], prev);
        dp[j - 1] = prev; prev = val;
      }
      dp[b.length] = prev;
    }
    return dp[b.length];
  }
  let best = null, bestDist = Infinity;
  for (const c of customers) {
    const d = lev(q, c.name.toLowerCase().replace(/\s+/g, ''));
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return bestDist <= 3 ? best : null;
}

// ── MCP tool executor ─────────────────────────────────────────────────────────
async function executeTool(name, args, env) {
  const data      = await fetchData(env);
  const customers = data.customers || [];

  if (name === 'get_summary') {
    let totalItems = 0, done = 0, blocked = 0, missed = 0, pending = 0;
    for (const c of customers) {
      const s = custStats(c);
      totalItems += s.total; done += s.done; blocked += s.blocked; missed += s.missed; pending += s.pending;
    }
    const avgPct = customers.length
      ? Math.round(customers.reduce((sum, c) => sum + custStats(c).pct, 0) / customers.length) : 0;
    return { totalCustomers: customers.length, averageAdoptionPct: avgPct, totalItems, itemsDone: done, itemsBlocked: blocked, itemsMissed: missed, itemsPending: pending, lastSaved: data._saved || null };
  }

  if (name === 'list_customers') {
    return customers.map(c => formatCustomer(c, false));
  }

  if (name === 'get_customer') {
    const c = findCustomer(customers, args.name || '');
    if (!c) return { error: `No customer matching "${args.name}". Available: ${customers.map(c => c.name).join(', ')}` };
    return formatCustomer(c, true);
  }

  if (name === 'get_blocked_items') {
    const filter = args.customer ? (args.customer + '').toLowerCase() : null;
    const result = [];
    for (const c of customers) {
      if (filter && !findCustomer([c], filter)) continue;
      for (const cat of c.categories || []) {
        const blocked = (cat.items || []).filter(i => i.status === 'blocked');
        if (blocked.length) result.push({ customer: c.name, pillar: cat.title, items: blocked.map(i => i.label) });
      }
    }
    return result;
  }

  if (name === 'get_pending_items') {
    const filter = args.customer ? (args.customer + '').toLowerCase() : null;
    const result = [];
    for (const c of customers) {
      if (filter && !findCustomer([c], filter)) continue;
      for (const cat of c.categories || []) {
        const pending = (cat.items || []).filter(i => i.status === 'pending');
        if (pending.length) result.push({ customer: c.name, pillar: cat.title, items: pending.map(i => i.label) });
      }
    }
    return result;
  }

  if (name === 'search_customers') {
    const q = (args.query || '').toLowerCase();
    const fields = ['name', 'aeName', 'atsName', 'csamName', 'seName'];
    return customers.filter(c => fields.some(f => (c[f] || '').toLowerCase().includes(q))).map(c => formatCustomer(c, false));
  }

  if (name === 'get_customers_by_status') {
    const min = args.min_pct ?? 0, max = args.max_pct ?? 100;
    return customers.map(c => formatCustomer(c, false)).filter(c => c.adoptionPct >= min && c.adoptionPct <= max);
  }

  if (name === 'get_pillar_summary') {
    const q = (args.pillar || '').toLowerCase();
    const result = [];
    for (const c of customers)
      for (const cat of c.categories || []) {
        if (!cat.title.toLowerCase().includes(q)) continue;
        const done    = (cat.items || []).filter(i => i.status === 'done').length;
        const blocked = (cat.items || []).filter(i => i.status === 'blocked').length;
        const total   = (cat.items || []).length;
        result.push({ customer: c.name, pillar: cat.title, done, blocked, total, pct: total ? Math.round(done / total * 100) : 0, items: (cat.items || []).map(i => ({ label: i.label, status: STATUS_LABELS[i.status] || i.status })) });
      }
    if (!result.length) return { error: `No pillar matching "${args.pillar}".` };
    return result;
  }

  return { error: `Unknown tool: ${name}` };
}

// ── MCP JSON-RPC handler ──────────────────────────────────────────────────────
async function handleMcp(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405, headers: corsHeaders });

  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }), { status: 400, headers: corsHeaders }); }

  const { method, params, id } = body;
  const ok  = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', result, id }), { headers: corsHeaders });
  const rpcErr = (code, message) => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }), { headers: corsHeaders });

  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'copilot-tracker', version: '1.0' },
      });
    }

    if (method === 'notifications/initialized') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (method === 'tools/list') {
      return ok({ tools: MCP_TOOLS });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      try {
        const result = await executeTool(name, args, env);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        // MCP spec: tool errors must be isError:true content, NOT a JSON-RPC error
        return ok({ content: [{ type: 'text', text: e.message || 'Tool execution error' }], isError: true });
      }
    }

    return rpcErr(-32601, `Method not found: ${method}`);
  } catch (e) {
    return rpcErr(-32000, e.message || 'Internal error');
  }
}

// ── Clerk authentication helpers ─────────────────────────────────────────────

const AUTH_CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function clerkJwksUrl(publishableKey) {
  const b64     = publishableKey.replace(/^pk_(test|live)_/, '');
  const decoded = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const domain  = decoded.replace(/\$$/, '');
  return `https://${domain}/.well-known/jwks.json`;
}

async function verifyClerkToken(token, env) {
  if (!token || !env.CLERK_PUBLISHABLE_KEY) return null;
  try {
    const [hB64, pB64, sB64] = token.split('.');
    if (!hB64 || !pB64 || !sB64) return null;
    const header  = JSON.parse(atob(hB64.replace(/-/g,'+').replace(/_/g,'/')));
    const payload = JSON.parse(atob(pB64.replace(/-/g,'+').replace(/_/g,'/')));
    if (payload.exp < Date.now() / 1000) return null;
    const jwksRes = await fetch(clerkJwksUrl(env.CLERK_PUBLISHABLE_KEY), { cf: { cacheTtl: 3600 } });
    const { keys } = await jwksRes.json();
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key  = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const data = new TextEncoder().encode(`${hB64}.${pB64}`);
    const sig  = Uint8Array.from(atob(sB64.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const ok   = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    return ok ? payload : null;
  } catch { return null; }
}

async function getClerkUser(userId, env) {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    return res.ok ? res.json() : null;
  } catch { return null; }
}

// POST /auth/request — register on first login, return existing record on repeat visits
async function handleAuthRequest(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: AUTH_CORS });
  const token   = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  const payload = await verifyClerkToken(token, env);
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: AUTH_CORS });

  const userId = payload.sub;
  let record   = await env.PERMISSIONS_KV.get(`user:${userId}`, 'json');

  if (!record) {
    const clerkUser = await getClerkUser(userId, env);
    const email     = clerkUser?.email_addresses?.[0]?.email_address || '';
    const name      = [clerkUser?.first_name, clerkUser?.last_name].filter(Boolean).join(' ') || email;
    const provider  = clerkUser?.external_accounts?.[0]?.provider || 'email';
    const isAdmin   = !!(env.ADMIN_EMAIL && email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase());
    record = {
      clerkId: userId, email, name, provider,
      isAdmin,
      status:      isAdmin ? 'approved' : 'pending',
      access:      isAdmin ? 'use'      : 'readonly',
      aiChat:      isAdmin,
      requestedAt: new Date().toISOString(),
      reviewedAt:  isAdmin ? new Date().toISOString() : null,
    };
    await env.PERMISSIONS_KV.put(`user:${userId}`, JSON.stringify(record));
  }
  return new Response(JSON.stringify(record), { headers: AUTH_CORS });
}

// GET /auth/me — return current user's record (without registering)
async function handleAuthMe(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: AUTH_CORS });
  const token   = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  const payload = await verifyClerkToken(token, env);
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: AUTH_CORS });
  const record = await env.PERMISSIONS_KV.get(`user:${payload.sub}`, 'json');
  return new Response(JSON.stringify(record || { status: 'unknown' }), { headers: AUTH_CORS });
}

// GET /admin/users — list all registered users (admin only)
async function handleAdminUsers(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: AUTH_CORS });
  const token   = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  const payload = await verifyClerkToken(token, env);
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: AUTH_CORS });
  const admin = await env.PERMISSIONS_KV.get(`user:${payload.sub}`, 'json');
  if (!admin?.isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: AUTH_CORS });
  const list  = await env.PERMISSIONS_KV.list({ prefix: 'user:' });
  const users = await Promise.all(list.keys.map(k => env.PERMISSIONS_KV.get(k.name, 'json')));
  return new Response(JSON.stringify(users.filter(Boolean)), { headers: AUTH_CORS });
}

// POST /admin/users/:id — update a user's permissions (admin only)
async function handleAdminUpdateUser(request, userId, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: AUTH_CORS });
  const token   = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  const payload = await verifyClerkToken(token, env);
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: AUTH_CORS });
  const admin = await env.PERMISSIONS_KV.get(`user:${payload.sub}`, 'json');
  if (!admin?.isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: AUTH_CORS });
  const update = await request.json().catch(() => ({}));
  const record = await env.PERMISSIONS_KV.get(`user:${userId}`, 'json');
  if (!record) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: AUTH_CORS });
  const updated = { ...record, ...update, reviewedAt: new Date().toISOString() };
  await env.PERMISSIONS_KV.put(`user:${userId}`, JSON.stringify(updated));
  return new Response(JSON.stringify(updated), { headers: AUTH_CORS });
}

// ── Anthropic AI proxy ────────────────────────────────────────────────────────
async function handleAiProxy(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // If Clerk is configured, verify the token and check aiChat permission
  if (env.CLERK_PUBLISHABLE_KEY) {
    const token   = (request.headers.get('Authorization') || '').replace('Bearer ', '');
    const payload = await verifyClerkToken(token, env);
    if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const record = await env.PERMISSIONS_KV.get(`user:${payload.sub}`, 'json');
    if (!record?.aiChat) return new Response(JSON.stringify({ error: 'AI chat access not granted.' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY secret is not configured on the Worker.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = await request.text();

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body,
  });

  // Stream the response straight back to the browser
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...corsHeaders,
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    },
  });
}

// ── Default intelligence system prompt (mirrors index.html) ──────────────────
const DEFAULT_INTEL_PROMPT = `You are a Microsoft sales intelligence assistant helping a CSM extract structured insights from informal field notes or WhatsApp messages.

Your job:
1. Identify the customer name mentioned.
2. Identify the main topic or use case discussed.
3. Identify ANY competitors to Microsoft products. Be smart — examples:
   - n8n, Zapier, Make, Integromat → Copilot Studio / Power Automate
   - ServiceNow, Salesforce, HubSpot → Copilot Studio / Dynamics 365
   - Google Workspace, Google Docs, Gmail, Google Meet → Microsoft 365 / Copilot 365
   - Slack → Microsoft Teams
   - Zoom → Microsoft Teams
   - Notion, Confluence, Coda → SharePoint / Microsoft 365
   - AWS, GCP → Azure
   - ChatGPT, OpenAI API, Gemini, Cohere, Mistral, Perplexity → Copilot 365 / Azure OpenAI
   - GitHub Actions, Jenkins, GitLab CI → Azure DevOps / GitHub
   - Jira, Linear, Monday.com, Asana → Azure DevOps / Microsoft Planner
   - Workday, SAP SuccessFactors, BambooHR → Dynamics 365 HR
   - Snowflake, Databricks, Tableau → Microsoft Fabric / Power BI
   - Crowdstrike, Okta, Palo Alto → Microsoft Security / Entra
   - Docusign → Microsoft Syntex / Purview
   - Intercom, Zendesk → Copilot Studio / Dynamics 365 Customer Service
   - Dropbox, Box → OneDrive / SharePoint
4. Identify relevant Microsoft products (from: Copilot 365, Copilot Studio, Microsoft Teams, Azure OpenAI, Microsoft 365, SharePoint, Dynamics 365, Azure DevOps, Microsoft Fabric, Microsoft Security, OneDrive, Power Automate, Power BI).
5. Generate a short intelligence summary (2-3 sentences).
6. Extract 1-3 actionable items for the CSM.

Return ONLY valid JSON, no markdown:
{
  "customer": "customer name or null",
  "topic": "short topic/use-case label",
  "competitors": [{"name": "competitor", "vsProduct": "Microsoft product", "risk": "high|medium|low"}],
  "ourProducts": ["product1"],
  "summary": "2-3 sentence summary",
  "actionItems": ["action 1"],
  "icon": "single relevant emoji"
}`;

// ── Parse URL-encoded form body (Twilio sends application/x-www-form-urlencoded)
function parseFormBody(text) {
  const params = {};
  for (const [k, v] of new URLSearchParams(text)) params[k] = v;
  return params;
}

// ── Verify Twilio request signature ──────────────────────────────────────────
async function verifyTwilioSignature(authToken, signature, url, params) {
  // Build the string: URL + sorted key/value pairs
  const sortedStr = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sortedStr));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return computed === signature;
}

// ── Save full data payload back to Gist ──────────────────────────────────────
async function saveDataToGist(env, data) {
  const { GIST_ID, GH_PAT } = env;
  if (!GIST_ID || !GH_PAT) throw new Error('GIST_ID and GH_PAT required for saving');
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${GH_PAT}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'copilot-tracker-worker/1.0',
    },
    body: JSON.stringify({ files: { [GH_FILE]: { content: JSON.stringify(data, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`Gist PATCH failed: ${res.status}`);
  _cache = data;
  _cacheTime = Date.now();
}

// ── TwiML response helper ─────────────────────────────────────────────────────
function twiml(msg) {
  const safe = msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${safe}</Message>` : ''}</Response>`,
    { headers: { 'Content-Type': 'text/xml' } }
  );
}

// ── WhatsApp webhook (Twilio) ─────────────────────────────────────────────────
async function handleWhatsApp(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const bodyText = await request.text();
  const params   = parseFormBody(bodyText);

  // Verify Twilio signature when auth token is configured
  if (env.TWILIO_AUTH_TOKEN) {
    const sig   = request.headers.get('X-Twilio-Signature') || '';
    const valid = await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, sig, request.url, params);
    if (!valid) return new Response('Forbidden', { status: 403 });
  }

  const messageBody = (params.Body || '').trim();
  const profileName = params.ProfileName || params.From || '';
  if (!messageBody) return twiml('');

  // Load current tracker data
  let data;
  try { data = await fetchData(env); }
  catch (e) { return twiml(`⚠️ Could not load tracker data: ${e.message}`); }

  if (!env.ANTHROPIC_API_KEY) return twiml('⚠️ AI not configured on the Worker.');

  // Use custom prompt from Gist settings if set
  const systemPrompt = data?.settings?.intelPrompt || DEFAULT_INTEL_PROMPT;

  // Call Claude
  let parsed;
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: messageBody }],
      }),
    });
    const aiData = await aiRes.json();
    const text   = aiData.content?.[0]?.text || '';
    const match  = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in AI response');
    parsed = JSON.parse(match[0]);
  } catch (e) {
    return twiml(`⚠️ AI analysis failed: ${e.message}`);
  }

  // Try to match customer to existing record
  const customers = data.customers || [];
  let customerId  = null;
  if (parsed.customer) {
    const lower = parsed.customer.toLowerCase();
    const found = customers.find(c =>
      c.name?.toLowerCase().includes(lower) || lower.includes(c.name?.toLowerCase())
    );
    if (found) customerId = found.id;
  }

  // Append intelligence entry
  if (!data.intelligence) data.intelligence = [];
  const entry = {
    id:          'intel-' + Date.now(),
    createdAt:   new Date().toISOString(),
    source:      'whatsapp',
    from:        profileName,
    rawNote:     messageBody,
    customer:    parsed.customer  || null,
    customerId,
    topic:       parsed.topic     || null,
    competitors: parsed.competitors  || [],
    ourProducts: parsed.ourProducts  || [],
    summary:     parsed.summary   || '',
    actionItems: parsed.actionItems || [],
    icon:        parsed.icon      || '💬',
  };
  data.intelligence.unshift(entry);

  // Save back to Gist
  try { await saveDataToGist(env, data); }
  catch (e) { return twiml(`⚠️ Saved failed: ${e.message}`); }

  // Reply to sender with confirmation
  const competes = (entry.competitors || []).map(c => `${c.name}`).join(', ');
  const reply = `✅ Intel logged\nCustomer: ${entry.customer || '?'}\nTopic: ${entry.topic || '?'}${competes ? `\nCompete: ${competes}` : ''}`;
  return twiml(reply);
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // MCP endpoint (POST JSON-RPC)
    if (path === '/mcp') return handleMcp(request, env);

    // AI proxy endpoint
    if (path === '/ai') return handleAiProxy(request, env);

    // WhatsApp webhook (Twilio)
    if (path === '/whatsapp') return handleWhatsApp(request, env);

    // Auth / permissions endpoints
    if (path === '/auth/request') return handleAuthRequest(request, env);
    if (path === '/auth/me')      return handleAuthMe(request, env);
    if (path === '/admin/users')  return handleAdminUsers(request, env);
    const adminUserMatch = path.match(/^\/admin\/users\/(.+)$/);
    if (adminUserMatch) return handleAdminUpdateUser(request, adminUserMatch[1], env);

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
