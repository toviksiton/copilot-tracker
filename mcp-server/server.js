#!/usr/bin/env node
/**
 * Copilot Adoption Tracker — MCP Server
 *
 * Reads live data from your GitHub Gist and exposes it as MCP tools
 * so Claude Desktop (and any other MCP client) can query it.
 *
 * Environment variables:
 *   GIST_ID  — your GitHub Gist ID (required)
 *   GH_PAT   — GitHub Personal Access Token (optional; needed only for private gists)
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Config ────────────────────────────────────────────
const GIST_ID = process.env.GIST_ID || '';
const GH_PAT  = process.env.GH_PAT  || '';
const GH_FILE = 'copilot-tracker-data.json';
const CACHE_TTL = 30_000; // refresh data every 30 s

// ── Data fetching (with TTL cache) ────────────────────
let _cache     = null;
let _cacheTime = 0;

async function fetchData() {
  if (!GIST_ID) throw new Error('GIST_ID environment variable is not set.');

  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'copilot-tracker-mcp/1.0',
  };
  if (GH_PAT) headers.Authorization = `token ${GH_PAT}`;

  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} — check GIST_ID and GH_PAT.`);

  const gist = await res.json();
  const file = gist.files[GH_FILE];
  if (!file) throw new Error(`File "${GH_FILE}" not found in Gist ${GIST_ID}.`);

  const content = file.truncated
    ? await (await fetch(file.raw_url, { headers })).text()
    : file.content;

  _cache     = JSON.parse(content);
  _cacheTime = now;
  return _cache;
}

// ── Helpers ───────────────────────────────────────────
const STATUS_LABELS = {
  done:    'Done / Will Happen',
  missed:  "Didn't Happen",
  blocked: 'Blocked',
  unblock: 'Unblocking',
  pending: 'Not Started',
};

function custStats(customer) {
  let done = 0, total = 0, blocked = 0, missed = 0, pending = 0;
  for (const cat of customer.categories || []) {
    for (const item of cat.items || []) {
      total++;
      if (item.status === 'done')    done++;
      else if (item.status === 'blocked') blocked++;
      else if (item.status === 'missed')  missed++;
      else                                pending++;
    }
  }
  return { done, total, blocked, missed, pending, pct: total ? Math.round(done / total * 100) : 0 };
}

/** Return a clean customer object — no logos, optional category detail */
function formatCustomer(c, includeCategories = false) {
  const SKIP = new Set(['logo', 'logoDataUrl']);
  const out  = {};
  for (const [k, v] of Object.entries(c)) {
    if (!SKIP.has(k) && k !== 'categories') out[k] = v;
  }
  const s = custStats(c);
  out.adoption_pct    = `${s.pct}%`;
  out.items_done      = s.done;
  out.items_pending   = s.pending;
  out.items_blocked   = s.blocked;
  out.items_missed    = s.missed;
  out.items_total     = s.total;

  if (includeCategories) {
    out.pillars = (c.categories || []).map(cat => ({
      icon:  cat.icon,
      title: cat.title,
      items: cat.items.map(i => ({
        label:  i.label,
        status: STATUS_LABELS[i.status] || i.status,
      })),
    }));
  }
  return out;
}

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function err(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

// ── MCP Server ────────────────────────────────────────
const server = new Server(
  { name: 'copilot-tracker', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool list ─────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_summary',
      description:
        'Get the overall dashboard summary: total customers, average adoption %, ' +
        'total items, blocked count, and last-saved timestamp.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_customers',
      description:
        'List all customers with their key metadata (name, AE, CSAM, SE, users, ' +
        'renewal date) and adoption percentage. Does not include individual item details.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_customer',
      description:
        'Get full details for a specific customer including all Copilot pillars ' +
        'and the status of every item (Done, Blocked, Pending, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Customer name — partial, case-insensitive match (e.g. "nice" matches "NICE").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_blocked_items',
      description:
        'Return every item that is currently Blocked across all customers, ' +
        'grouped by customer and pillar.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_pending_items',
      description:
        'Return every item that is still Not Started (pending) across all customers, ' +
        'grouped by customer and pillar.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'search_customers',
      description:
        'Search customers by any field: name, AE name, CSAM, SE, ATS, etc. ' +
        'Returns matching customers with their adoption stats.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term — matches name, aeName, csamName, seName, atsName (case-insensitive).',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_customers_by_status',
      description:
        'Filter customers whose adoption percentage is above or below a threshold.',
      inputSchema: {
        type: 'object',
        properties: {
          min_pct: {
            type: 'number',
            description: 'Minimum adoption % (0-100). Returns customers at or above this value.',
          },
          max_pct: {
            type: 'number',
            description: 'Maximum adoption % (0-100). Returns customers at or below this value.',
          },
        },
      },
    },
    {
      name: 'get_pillar_summary',
      description:
        'Show adoption progress for a specific Copilot pillar (e.g. "Copilot 365", ' +
        '"Copilot Studio") across all customers.',
      inputSchema: {
        type: 'object',
        properties: {
          pillar: {
            type: 'string',
            description: 'Pillar/category name — partial, case-insensitive match.',
          },
        },
        required: ['pillar'],
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    const data      = await fetchData();
    const customers = data.customers || [];

    // ── get_summary ──────────────────────────────────
    if (name === 'get_summary') {
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
      return text({
        total_customers:      customers.length,
        average_adoption_pct: `${avgPct}%`,
        total_items:          totalItems,
        items_done:           done,
        items_blocked:        blocked,
        items_missed:         missed,
        items_pending:        pending,
        last_saved:           data._saved || 'unknown',
      });
    }

    // ── list_customers ───────────────────────────────
    if (name === 'list_customers') {
      return text(customers.map(c => formatCustomer(c, false)));
    }

    // ── get_customer ─────────────────────────────────
    if (name === 'get_customer') {
      const q = (args.name || '').toLowerCase();
      const c = customers.find(c => c.name.toLowerCase().includes(q));
      if (!c) return text(`No customer found matching "${args.name}".`);
      return text(formatCustomer(c, true));
    }

    // ── get_blocked_items ────────────────────────────
    if (name === 'get_blocked_items') {
      const result = [];
      for (const c of customers) {
        for (const cat of c.categories || []) {
          const blocked = cat.items.filter(i => i.status === 'blocked');
          if (blocked.length) result.push({
            customer: c.name,
            pillar:   cat.title,
            items:    blocked.map(i => i.label),
          });
        }
      }
      return text(result.length ? result : 'No blocked items found.');
    }

    // ── get_pending_items ────────────────────────────
    if (name === 'get_pending_items') {
      const result = [];
      for (const c of customers) {
        for (const cat of c.categories || []) {
          const pending = cat.items.filter(i => i.status === 'pending');
          if (pending.length) result.push({
            customer: c.name,
            pillar:   cat.title,
            items:    pending.map(i => i.label),
          });
        }
      }
      return text(result.length ? result : 'No pending items found.');
    }

    // ── search_customers ─────────────────────────────
    if (name === 'search_customers') {
      const q      = (args.query || '').toLowerCase();
      const fields = ['name', 'aeName', 'atsName', 'csamName', 'seName'];
      const hits   = customers.filter(c =>
        fields.some(f => c[f] && String(c[f]).toLowerCase().includes(q))
      );
      return text(hits.length ? hits.map(c => formatCustomer(c, false)) : `No customers match "${args.query}".`);
    }

    // ── get_customers_by_status ──────────────────────
    if (name === 'get_customers_by_status') {
      const min = args.min_pct ?? 0;
      const max = args.max_pct ?? 100;
      const hits = customers
        .map(c => ({ ...formatCustomer(c, false), _pct: custStats(c).pct }))
        .filter(c => c._pct >= min && c._pct <= max)
        .sort((a, b) => b._pct - a._pct)
        .map(({ _pct, ...rest }) => rest);
      return text(hits.length ? hits : `No customers with adoption between ${min}% and ${max}%.`);
    }

    // ── get_pillar_summary ───────────────────────────
    if (name === 'get_pillar_summary') {
      const q      = (args.pillar || '').toLowerCase();
      const result = [];
      for (const c of customers) {
        const cat = (c.categories || []).find(cat => cat.title.toLowerCase().includes(q));
        if (!cat) continue;
        const total   = cat.items.length;
        const done    = cat.items.filter(i => i.status === 'done').length;
        const blocked = cat.items.filter(i => i.status === 'blocked').length;
        result.push({
          customer:     c.name,
          pillar:       cat.title,
          adoption_pct: `${total ? Math.round(done / total * 100) : 0}%`,
          done, blocked,
          total,
          items: cat.items.map(i => ({ label: i.label, status: STATUS_LABELS[i.status] || i.status })),
        });
      }
      return text(result.length ? result : `No pillar matching "${args.pillar}" found.`);
    }

    return err(`Unknown tool: ${name}`);

  } catch (e) {
    return err(e.message);
  }
});

// ── Start ─────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
