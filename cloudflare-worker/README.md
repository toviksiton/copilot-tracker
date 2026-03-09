# Copilot Tracker — Cloudflare Worker API

Exposes your tracker data as a free public REST API.
The GitHub PAT stays secret inside Cloudflare — it is **never** sent to clients.

---

## Setup (5 minutes)

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login          # opens browser to authorize your Cloudflare account
```

### 2. Configure your Gist ID

Open `wrangler.toml` and paste your Gist ID:

```toml
[vars]
GIST_ID = "abc123yourgistid"
```

Or set it as a secret (more secure):

```bash
wrangler secret put GIST_ID
# paste your Gist ID when prompted
```

### 3. Add your GitHub PAT as a secret (optional — only needed for private Gists)

```bash
wrangler secret put GH_PAT
# paste your PAT when prompted — it will never be visible again
```

### 4. Deploy

```bash
cd cloudflare-worker
wrangler deploy
```

Your API URL will be printed:
```
https://copilot-tracker-api.<your-subdomain>.workers.dev
```

---

## Local development

```bash
wrangler dev
# API runs at http://localhost:8787
```

To pass secrets locally, create a `.dev.vars` file (never commit this):

```
GIST_ID=abc123yourgistid
GH_PAT=ghp_yourtoken
```

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/` | Health check + route index |
| `GET` | `/data` | Raw tracker JSON |
| `GET` | `/summary` | Dashboard totals |
| `GET` | `/customers` | All customers with adoption % |
| `GET` | `/customers/:name` | Single customer full detail |
| `GET` | `/blocked` | All blocked items |
| `GET` | `/pending` | All pending (not-started) items |
| `GET` | `/search?q=<term>` | Search by name / AE / CSAM / SE / ATS |
| `GET` | `/filter?min=<n>&max=<n>` | Filter by adoption % range |
| `GET` | `/pillar/:name` | Pillar summary across customers |

### Examples

```bash
# Dashboard totals
curl https://copilot-tracker-api.<you>.workers.dev/summary

# All customers
curl https://copilot-tracker-api.<you>.workers.dev/customers

# Single customer
curl https://copilot-tracker-api.<you>.workers.dev/customers/AMODCS

# Customers between 50–80% adoption
curl "https://copilot-tracker-api.<you>.workers.dev/filter?min=50&max=80"

# Search by AE name
curl "https://copilot-tracker-api.<you>.workers.dev/search?q=John"

# Copilot 365 pillar across all customers
curl https://copilot-tracker-api.<you>.workers.dev/pillar/Copilot%20365

# All blocked items
curl https://copilot-tracker-api.<you>.workers.dev/blocked
```

---

## Caching

- Data is cached **in-memory for 30 seconds** per Worker isolate.
- HTTP response includes `Cache-Control: public, max-age=30` — Cloudflare edge also caches it.
- This means up to ~30 s delay between a Gist save and the API reflecting the update.

---

## CORS

All responses include `Access-Control-Allow-Origin: *` — the API can be called from any browser or web app.

---

## Free tier limits (Cloudflare Workers free plan)

| Limit | Value |
|-------|-------|
| Requests/day | 100,000 |
| CPU time/request | 10 ms |
| Memory | 128 MB |
| Script size | 1 MB |
| Secrets | 100 |

This app comfortably fits within the free tier.
