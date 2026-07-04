# Pioneer ERP Progress Dashboard

Client-facing implementation-progress dashboard for Pioneer Foundation Engineering's
HR + Tender ERPNext modules. Static frontend + one Netlify Function that securely
queries ERPNext server-side — your API key/secret never reaches the browser.

```
pioneer-dashboard/
├── netlify.toml
├── package.json
├── .env.example
├── public/
│   └── index.html                       ← the dashboard UI
└── netlify/functions/
    └── get-progress-data.js             ← server-side ERPNext query + shaping
```

## How it works
1. Browser loads `public/index.html` (static, from Netlify's CDN).
2. On load, it calls `/.netlify/functions/get-progress-data`.
3. That function (running on Netlify's servers, not the browser) calls ERPNext's
   REST API using `ERP_API_KEY` / `ERP_API_SECRET` from environment variables,
   walks the Task tree under your HR and Tender root tasks, and returns shaped JSON.
4. If the function or ERPNext is unreachable, the page falls back to a small
   built-in sample dataset and shows a warning banner — it never goes blank.

No custom app needs to be installed on your ERPNext instance. Everything here
uses ERPNext's standard `/api/resource/...` REST endpoints.

## 1. Get an ERPNext API key/secret
You said you already have one — just confirm the user it belongs to has **read
permission on Task and Timesheet**. (Settings → Users → [user] → API Access →
Generate Keys, if you ever need a new pair.)

## 2. Local setup
```bash
npm install -g netlify-cli   # if you don't have it
cp .env.example .env
# edit .env with your real ERP_URL / ERP_API_KEY / ERP_API_SECRET
netlify dev
```
This runs the static site + function together locally (usually on `localhost:8888`).

## 3. Deploy to Netlify
### Option A — Netlify UI (fastest)
1. Push this folder to a GitHub repo.
2. In Netlify: **Add new site → Import an existing project** → pick the repo.
3. Build settings: leave as detected (`netlify.toml` already sets `publish = public`,
   `functions = netlify/functions`).
4. **Site configuration → Environment variables** — add:
   - `ERP_URL`
   - `ERP_API_KEY`
   - `ERP_API_SECRET`
   - `HR_ROOT_TASK` (defaults to `TASK-2026-01212` if unset)
   - `TENDER_ROOT_TASK` (defaults to `TASK-2026-01214` if unset)
5. Deploy. Visit the generated `*.netlify.app` URL (or attach your own domain under
   **Domain management**).

### Option B — CLI
```bash
netlify init
netlify env:set ERP_URL "https://erp.akhilaminc.com"
netlify env:set ERP_API_KEY "..."
netlify env:set ERP_API_SECRET "..."
netlify deploy --prod
```

## What's real vs. placeholder right now
| Item | Status |
|---|---|
| Module / FR / Open Item structure | **Live** — pulled from your actual Task tree via `lft`/`rgt` |
| FR completion % | **Live** — reflects each FR task's `status` field in ERPNext |
| Start / Est. End dates | **Live**, but will show "—" until you populate `exp_start_date` / `exp_end_date` on FR tasks |
| Open Item owner (Pioneer HR/Finance/IT/Tender Team) | **Placeholder** ("—") until you add a custom field — see below |
| Active This Week | **Live** — based on `Timesheet Detail` rows logged against a task this week (Mon–Sun) |
| Overdue Open Tasks | **Live** — `exp_end_date` in the past and status not Completed/Cancelled |

### Adding the Open Item "owner" field (optional but recommended)
In ERPNext: **Customize Form → Task** → add a Select field named
`owner_department` with options `Pioneer HR`, `Pioneer Finance`, `Pioneer IT`,
`Pioneer Tender Team`, `Pioneer Management`. Once populated on the 17 Open Item
tasks, it'll show automatically in the OI dialog — no code change needed, the
function already reads `t.owner_department` with a graceful `"—"` fallback.

## Adjusting the module → FR → Open Item structure later
If you restructure tasks in ERPNext (new modules, re-parented FRs, etc.), you
don't need to touch this repo at all — `get-progress-data.js` reads the tree
live every request (cached 5 minutes via `Cache-Control`). Only touch the code if:
- You add a **third sub-module** beyond HR/Tender → add its root task env var
  and one more `buildSubmodule()` call + one more `<div class="section">` block
  in the frontend loop.
- You change what counts as "Active" or "Overdue" → edit
  `getActiveTaskNamesThisWeek()` / `collectOverdue()` in the function.

## Security notes
- `ERP_API_KEY` / `ERP_API_SECRET` live **only** in Netlify's environment
  variables and inside the function's server-side execution — never sent to
  the browser, never committed to git (`.env` is real secrets, `.env.example`
  is just a template).
- The function only returns fields already visible on this dashboard
  (subject/status/dates) — no descriptions, comments, or assignee data beyond
  what's already shown.
- Response is cached 5 minutes at the edge (`Cache-Control: public, max-age=300`)
  to avoid hammering your ERPNext instance if the page is refreshed often.
- If you want this behind more than "unguessable URL," consider adding Netlify's
  built-in password protection (Site configuration → Visitor access) rather
  than building custom auth.

## Troubleshooting
- **Blank sections / fallback banner showing** — check Netlify's function logs
  (Site → Functions → get-progress-data) for the actual ERPNext error message.
- **401/403 from ERPNext** — the API user likely lacks read permission on Task
  or Timesheet, or the key/secret pair is wrong.
- **Active This Week always 0** — confirm Timesheet Detail rows actually have
  `task` set to the ERPNext Task name (not blank) and `from_time` falls within
  the current week.
