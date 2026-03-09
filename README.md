# Copilot Adoption Tracker

A single-page web app for tracking Microsoft Copilot adoption progress across your customers. Data lives in a GitHub Gist and is accessible via a REST API, a Claude Desktop MCP server, and a Copilot Studio MCP endpoint.

---

## What it does

- Track every customer's Copilot rollout across pillars (Copilot 365, Copilot Studio, etc.)
- Mark each checklist item as **Done**, **Blocked**, **Unblocking**, **Missed**, or **Not Started**
- Sync data to **GitHub Gist** or **OneDrive** with one click
- Share a read-only view via a `?gist=<id>` URL parameter
- Query everything through a **REST API** (Cloudflare Worker) or **AI agents** (Claude Desktop / Copilot Studio)

---

## Architecture

```
index.html              ← Web UI (no build step, runs in browser)
    ↕ GitHub Gist API
cloudflare-worker/      ← Public REST API + MCP over HTTP (Copilot Studio)
mcp-server/             ← MCP over stdio (Claude Desktop)
```

---

## Quick start

### 1. Open the web app

Open `index.html` in a browser — no server required. Everything runs client-side.

### 2. Connect GitHub Gist (to save your data)

1. Create a [GitHub Personal Access Token](https://github.com/settings/tokens) with `gist` scope
2. In the app go to **Cloud Sync → GitHub Gist**
3. Enter your PAT — the app auto-creates a Gist on first save
4. Click **Save** — your data is now persisted and shareable

### 3. Share a read-only link

```
index.html?gist=<YOUR_GIST_ID>
```

Anyone with this link can view (but not edit) your tracker.

---

## REST API (Cloudflare Worker)

Exposes your Gist data as a public REST API. See [`cloudflare-worker/README.md`](cloudflare-worker/README.md) for full setup.

```bash
cd cloudflare-worker
npm install -g wrangler
wrangler login
wrangler deploy
```

| Route | Description |
|-------|-------------|
| `GET /summary` | Dashboard totals |
| `GET /customers` | All customers with adoption % |
| `GET /customers/:name` | Single customer full detail |
| `GET /blocked` | All blocked items |
| `GET /pending` | All not-started items |
| `GET /search?q=` | Search by name / AE / CSAM / SE / ATS |
| `GET /filter?min=&max=` | Filter by adoption % range |
| `GET /pillar/:name` | Pillar summary across customers |
| `POST /mcp` | MCP JSON-RPC endpoint (Copilot Studio) |

---

## Claude Desktop — MCP Server (stdio)

Let Claude Desktop query your tracker with natural language. See [`mcp-server/README.md`](mcp-server/README.md) for full setup.

```bash
cd mcp-server
npm install
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "copilot-tracker": {
      "command": "node",
      "args": ["/FULL/PATH/TO/mcp-server/server.js"],
      "env": {
        "GIST_ID": "your_gist_id",
        "GH_PAT":  "your_github_pat"
      }
    }
  }
}
```

Restart Claude Desktop. Then try:

> *"Which customers are below 20% adoption?"*
> *"What's blocked for Contoso?"*
> *"Show me the Copilot Studio pillar across all accounts."*

---

## Copilot Studio — MCP over HTTP

Connect your deployed Cloudflare Worker to a Copilot Studio agent.

1. Deploy the Cloudflare Worker (see above)
2. In [Copilot Studio](https://copilotstudio.microsoft.com) open your agent
3. Go to **Tools → Add a tool → Model Context Protocol (MCP)**
4. Enter:
   - **Server URL:** `https://copilot-tracker-api.<your-subdomain>.workers.dev/mcp`
   - **Authentication:** None
5. Click **Save** — 8 tools are auto-discovered

Paste this as the agent's system prompt:

```
You are a Copilot Adoption Tracker assistant. Always call the relevant tool
before answering. Present data in clear tables or bullet lists. Be concise
and business-focused.
```

---

## OneDrive sync

1. Register an Azure app with `Files.ReadWrite` permission
2. In the app go to **Cloud Sync → OneDrive**
3. Enter your Azure Client ID and sign in
4. Autosave keeps your data synced every 30 seconds

---

## MCP tools (all integrations)

| Tool | Description |
|------|-------------|
| `get_summary` | Overall dashboard totals |
| `list_customers` | All customers with metadata and adoption % |
| `get_customer` | Full detail for one customer — pillars and item statuses |
| `get_blocked_items` | Every blocked item across all customers |
| `get_pending_items` | Every not-started item across all customers |
| `search_customers` | Search by name, AE, CSAM, SE, or ATS |
| `get_customers_by_status` | Filter by adoption % range |
| `get_pillar_summary` | Progress for a specific pillar across all customers |

---

## Environment variables

| Variable | Where | Description |
|----------|-------|-------------|
| `GIST_ID` | Worker / MCP server | GitHub Gist ID |
| `GH_PAT` | Worker / MCP server | GitHub PAT (required for private Gists) |

---

## Full API reference

See [`API.md`](API.md) for the complete GitHub Gist API, OneDrive API, data schema, localStorage keys, and npm scripts.
