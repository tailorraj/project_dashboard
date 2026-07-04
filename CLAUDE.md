# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Client-facing ERP implementation progress dashboard for Pioneer Foundation Engineering. Tracks HR and Tender ERPNext module rollout at Module → Functional Requirement (FR) → Open Item (OI) depth. Consists of exactly two files that matter:

- `public/index.html` — single-page dashboard (vanilla HTML/CSS/JS, no framework)
- `netlify/functions/get-progress-data.js` — Netlify Function that proxies ERPNext REST calls server-side, keeping API credentials out of the browser

## Local development

```bash
npm install           # installs netlify-cli
cp .env.example .env  # then fill in real values
netlify dev           # serves on http://localhost:8888
```

No build step. `public/` is served as-is from Netlify's CDN. The function runs at `/.netlify/functions/get-progress-data` (also aliased to `/api/progress` via `netlify.toml`).

## Required environment variables

| Variable | Purpose |
|---|---|
| `ERP_URL` | ERPNext instance base URL |
| `ERP_API_KEY` | API key (never reaches the browser) |
| `ERP_API_SECRET` | API secret |
| `HR_ROOT_TASK` | ERPNext Task name for the HR root node (default: `TASK-2026-01212`) |
| `TENDER_ROOT_TASK` | ERPNext Task name for the Tender root node (default: `TASK-2026-01214`) |

## Architecture

### Data flow
1. `index.html` calls `/.netlify/functions/get-progress-data` on page load.
2. The function authenticates to ERPNext using `token {API_KEY}:{API_SECRET}`, fetches the task subtree under each root using ERPNext's **nested-set** (`lft`/`rgt`) fields, and shapes it into `{ hr, tender, activeTasks, overdueTasks }`.
3. Response is cached 5 minutes at the edge (`Cache-Control: public, max-age=300`).
4. If the fetch fails for any reason, `index.html` shows an inline error state (no mock data is shown — the dashboard only ever displays live ERPNext data).

### ERPNext task conventions
- Task `subject` follows `"CODE: Title"` format (e.g. `"FR-HR-004: eSSL Attendance Integration"`). `splitCodeTitle()` in the function splits these apart.
- Task `type` field distinguishes `"Functional Requirement"` from `"Open Item"`.
- Task `is_group` marks module-level grouping nodes.
- The optional custom field `owner_department` (not shipped by default in ERPNext) maps to the OI owner shown in dialogs; falls back to `"—"` gracefully.
- Active tasks are determined by querying `Timesheet Detail` rows logged against tasks within the current Mon–Sun week.

### Adding a third sub-module (e.g. Finance)
1. Add `FINANCE_ROOT_TASK` env var.
2. In `get-progress-data.js`: fetch its root, fetch its subtree, call `buildSubmodule()`, include it in the response payload.
3. In `index.html`: add a `<div class="section">` block and add it to the `renderSection()` call inside `render()`.

### Modifying what counts as "Active" or "Overdue"
Edit `getActiveTaskNamesThisWeek()` and `collectOverdue()` in `netlify/functions/get-progress-data.js`.
