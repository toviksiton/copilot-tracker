# Copilot Adoption Tracker — API Reference

## Table of Contents

1. [GitHub Gist API](#1-github-gist-api)
2. [Microsoft Graph / OneDrive API](#2-microsoft-graph--onedrive-api)
3. [MCP Server Tools](#3-mcp-server-tools)
4. [Data Schema](#4-data-schema)
5. [URL Parameters](#5-url-parameters)
6. [Configuration & Environment Variables](#6-configuration--environment-variables)
7. [npm Scripts](#7-npm-scripts)

---

## 1. GitHub Gist API

The app uses GitHub's REST API to store and sync tracker data as a public/private Gist.

**Base URL:** `https://api.github.com`

**Common Headers:**
```
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
Authorization: token {GH_PAT}   ← optional for public Gists, required for write
```

**File name stored in Gist:** `copilot-tracker-data.json`

---

### GET — Auto-discover Gists

```
GET https://api.github.com/users/{GH_OWNER}/gists?per_page=30
```

Finds the most recently updated Gist named `copilot-tracker-data.json` for a given GitHub user.

| Parameter | Type | Description |
|-----------|------|-------------|
| `GH_OWNER` | path | GitHub username (default: `toviksiton`) |
| `per_page` | query | Results per page (max 100, default used: 30) |

**Response:** Array of Gist objects. The app picks the one whose `files` object contains `copilot-tracker-data.json`, sorted by `updated_at` descending.

---

### GET — Fetch Gist metadata

```
GET https://api.github.com/gists/{GIST_ID}
```

Returns the Gist metadata including the `raw_url` of the file content.

| Parameter | Type | Description |
|-----------|------|-------------|
| `GIST_ID` | path | The Gist ID (40-character hex string) |

**Response fields used:**
```json
{
  "files": {
    "copilot-tracker-data.json": {
      "raw_url": "https://gist.githubusercontent.com/..."
    }
  },
  "updated_at": "2026-03-09T08:13:32Z"
}
```

---

### GET — Fetch raw Gist content

```
GET {raw_url}?t={timestamp}
```

Downloads the actual JSON content of the tracker data file. The `t` query param busts the CDN cache.

| Parameter | Type | Description |
|-----------|------|-------------|
| `raw_url` | path | Value of `files["copilot-tracker-data.json"].raw_url` from metadata call |
| `t` | query | `Date.now()` — cache-buster |

**Response:** Raw JSON — see [Data Schema](#4-data-schema).

---

### PATCH — Update Gist

```
PATCH https://api.github.com/gists/{GIST_ID}
```

Saves updated tracker data to an existing Gist. **Requires `GH_PAT`.**

| Parameter | Type | Description |
|-----------|------|-------------|
| `GIST_ID` | path | The Gist ID to update |

**Request body:**
```json
{
  "files": {
    "copilot-tracker-data.json": {
      "content": "{...serialized JSON string...}"
    }
  }
}
```

---

### POST — Create new Gist

```
POST https://api.github.com/gists
```

Creates a new public Gist to store tracker data for the first time. **Requires `GH_PAT`.**

**Request body:**
```json
{
  "description": "Copilot Adoption Tracker data",
  "public": true,
  "files": {
    "copilot-tracker-data.json": {
      "content": "{...serialized JSON string...}"
    }
  }
}
```

---

## 2. Microsoft Graph / OneDrive API

Used for OneDrive sync. Authentication is handled via **MSAL.js** (OAuth 2.0, implicit/PKCE flow).

**Base URL:** `https://graph.microsoft.com/v1.0`

**Auth header:** `Authorization: Bearer {access_token}`

**Scopes required:** `Files.ReadWrite`

**File stored at:** `/me/drive/root:/copilot-tracker-data.json`

---

### PUT — Save to OneDrive

```
PUT https://graph.microsoft.com/v1.0/me/drive/root:/{OD_FILE_NAME}:/content
```

Writes the tracker JSON file to the signed-in user's OneDrive root.

| Parameter | Type | Description |
|-----------|------|-------------|
| `OD_FILE_NAME` | path | Filename — `copilot-tracker-data.json` |

**Request body:** Raw JSON string (Content-Type: `application/json`)

---

### GET — Load from OneDrive

```
GET https://graph.microsoft.com/v1.0/me/drive/root:/{OD_FILE_NAME}:/content
```

Downloads the tracker JSON file from OneDrive.

**Response:** Raw JSON — see [Data Schema](#4-data-schema).

---

### GET — Load shared OneDrive/SharePoint file

```
GET https://api.onedrive.com/v1.0/shares/u!{base64_encoded_url}/root/content
```

Loads data from a publicly shared OneDrive link (read-only, no auth required).

| Parameter | Type | Description |
|-----------|------|-------------|
| `base64_encoded_url` | path | URL-safe base64 of the share link, prefixed with `u!` |

---

## 3. MCP Server Tools

The MCP server (`mcp-server/server.js`) exposes these tools to Claude Desktop via the Model Context Protocol over **stdio**.

**Data source:** GitHub Gist (configured via `GIST_ID` env var)
**Cache TTL:** 30 seconds

---

### `get_summary`

Returns dashboard-level totals.

**Parameters:** none

**Returns:**
```json
{
  "totalCustomers": 12,
  "averageAdoptionPct": 63,
  "totalBlockedItems": 4,
  "lastSaved": "2026-03-09T08:13:32.660Z"
}
```

---

### `list_customers`

Returns all customers with their metadata and overall adoption percentage.

**Parameters:** none

**Returns:** Array of customer summaries:
```json
[
  {
    "name": "AMODCS",
    "adoptionPct": 72,
    "users": 1500,
    "copilotUsers": 250,
    "renewalDate": "2026-09-30",
    "aeName": "John Doe",
    "csamName": "Maya Patel"
  }
]
```

---

### `get_customer`

Returns full detail for one customer, including all pillars and item statuses.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Customer name (partial match, case-insensitive) |

**Returns:** Customer object with nested categories and items with human-readable statuses (`Done`, `Blocked`, `Not Started`, etc.).

---

### `get_blocked_items`

Returns every blocked item across all customers, grouped by customer and pillar.

**Parameters:** none

**Returns:**
```json
[
  {
    "customer": "AMODCS",
    "pillar": "Copilot 365",
    "item": "Licenses",
    "status": "Blocked"
  }
]
```

---

### `get_pending_items`

Returns every not-started item across all customers, grouped by customer and pillar.

**Parameters:** none

**Returns:** Same shape as `get_blocked_items` but filtered to `status: "Not Started"`.

---

### `search_customers`

Filters customers by a search string matched against name, AE, CSAM, SE, or ATS fields.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Search term (partial match, case-insensitive) |

**Returns:** Array of matching customer summaries (same shape as `list_customers`).

---

### `get_customers_by_status`

Filters customers whose adoption percentage falls within a given range.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `min_pct` | number | yes | Minimum adoption % (0–100) |
| `max_pct` | number | yes | Maximum adoption % (0–100) |

**Returns:** Array of matching customer summaries with their `adoptionPct`.

---

### `get_pillar_summary`

Returns adoption progress for a single pillar across all customers.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pillar` | string | yes | Pillar name, e.g. `"Copilot 365"` (partial match) |

**Returns:**
```json
[
  {
    "customer": "AMODCS",
    "pillar": "Copilot 365",
    "done": 5,
    "total": 8,
    "pct": 63
  }
]
```

---

## 4. Data Schema

All APIs read/write a single JSON document with this structure.

### Root object

| Field | Type | Description |
|-------|------|-------------|
| `_version` | number | Schema version — currently `1` |
| `_app` | string | `"Copilot Adoption Tracker by Tovik"` |
| `_saved` | string (ISO 8601) | Last save timestamp (added on write) |
| `customers` | Customer[] | List of tracked customers |
| `template` | Template | Default pillar template (optional) |

### Customer

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique random ID |
| `name` | string | Customer / company name |
| `createdAt` | string (ISO 8601) | Record creation timestamp |
| `users` | number | Total licensed users |
| `copilotUsers` | number | Active Copilot users |
| `renewalDate` | string (YYYY-MM-DD) | License renewal date |
| `aopDate` | string (YYYY-MM-DD) | Annual Operating Plan date |
| `aeName` | string | Account Executive name |
| `atsName` | string | ATS name |
| `csamName` | string | CSAM name |
| `seName` | string | SE name |
| `logo` | string | Base64 data URI or HTTPS URL (nullable) |
| `categories` | Category[] | Adoption pillars |

### Category (Pillar)

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Pillar identifier, e.g. `"copilot365"` |
| `icon` | string | Emoji icon |
| `title` | string | Display name, e.g. `"Copilot 365"` |
| `items` | Item[] | Adoption checklist items |

### Item

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique random ID |
| `label` | string | Item name, e.g. `"Licenses"` |
| `status` | string | See status values below |

### Item Status Values

| Value | Display Label | Meaning |
|-------|---------------|---------|
| `pending` | Not Started | Not yet addressed |
| `done` | Done / Will Happen | Completed or confirmed |
| `blocked` | Blocked | Actively blocked |
| `unblock` | Unblocking | In progress to resolve blocker |
| `missed` | Didn't Happen | Milestone missed |

---

## 5. URL Parameters

The web app (`index.html`) accepts these query parameters:

| Parameter | Example | Description |
|-----------|---------|-------------|
| `gist` | `?gist=abc123` | Auto-load a specific GitHub Gist by ID (read-only share) |

---

## 6. Configuration & Environment Variables

### MCP Server environment variables

Set in `claude_desktop_config.json`:

| Variable | Required | Description |
|----------|----------|-------------|
| `GIST_ID` | Yes | GitHub Gist ID to read data from |
| `GH_PAT` | No | GitHub Personal Access Token (required for private Gists) |

### Browser localStorage keys

| Key | Description |
|-----|-------------|
| `copilot-tracker-v3` | Main app state (customers, template, active customer) |
| `copilot-tracker-auth` | Session auth flag (read-only password mode) |
| `copilot-tracker-od` | OneDrive autosave settings |
| `copilot-tracker-od-clientid` | Azure app Client ID for MSAL |
| `copilot-tracker-gh-pat` | GitHub Personal Access Token |
| `copilot-tracker-gh-gist` | Configured GitHub Gist ID |
| `copilot-tracker-gh-raw` | Cached Gist raw URL (perf optimization) |
| `copilot-tracker-gh-auto` | GitHub autosave enabled toggle |

### Claude Desktop MCP config

Add to `~/.config/claude/claude_desktop_config.json` (Linux/Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "copilot-tracker": {
      "command": "node",
      "args": ["/FULL/PATH/TO/copilot-tracker/mcp-server/server.js"],
      "env": {
        "GIST_ID": "YOUR_GIST_ID",
        "GH_PAT": "YOUR_GITHUB_PAT"
      }
    }
  }
}
```

---

## 7. npm Scripts

From `mcp-server/`:

| Command | Description |
|---------|-------------|
| `npm install` | Install MCP server dependencies (`@modelcontextprotocol/sdk`) |
| `npm start` | Start the MCP server (`node server.js`) |
| `node server.js` | Run the MCP server directly |
