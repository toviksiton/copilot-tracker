# Copilot Adoption Tracker — MCP Server

Exposes your tracker data as MCP tools so **Claude Desktop** (and any MCP-compatible client) can query customers, adoption stats, blocked items, and more — all pulling live data from your GitHub Gist.

## Setup

### 1. Install dependencies

```bash
cd mcp-server
npm install
```

### 2. Get your Gist ID

Open the app → **Cloud Sync → GitHub Gist** → copy the ID shown (e.g. `26c16609f1785eb9098b3ad16277690`).

### 3. Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add:

```json
{
  "mcpServers": {
    "copilot-tracker": {
      "command": "node",
      "args": ["/FULL/PATH/TO/mcp-server/server.js"],
      "env": {
        "GIST_ID": "YOUR_GIST_ID_HERE",
        "GH_PAT":  "YOUR_GITHUB_PAT_HERE"
      }
    }
  }
}
```

> **Note:** `GH_PAT` is only required if your Gist is private. For a public Gist (the default) you can omit it or leave it blank.

Restart Claude Desktop. You'll see a 🔌 icon indicating the MCP server is connected.

---

## Available Tools

| Tool | Description |
|---|---|
| `get_summary` | Dashboard totals: customers, avg adoption %, blocked items, last saved |
| `list_customers` | All customers with metadata and adoption % |
| `get_customer` | Full detail for one customer — all pillars and item statuses |
| `get_blocked_items` | Every blocked item across all customers |
| `get_pending_items` | Every not-started item across all customers |
| `search_customers` | Filter by name, AE, CSAM, SE, or ATS (partial match) |
| `get_customers_by_status` | Filter by adoption % range (e.g. below 20%) |
| `get_pillar_summary` | Adoption progress for one pillar across all customers |

---

## Example prompts in Claude

- *"What's the overall adoption rate across all customers?"*
- *"Show me all customers with CSAM Maya"*
- *"Which items are blocked for AMODCS?"*
- *"List customers below 10% adoption"*
- *"How is Copilot Studio adoption going across all accounts?"*
- *"Who is the AE for NICE and what's their adoption progress?"*

---

## Data freshness

The server caches data for **30 seconds**. Any change saved in the app will be visible within 30 s of the next tool call — no restart needed.
