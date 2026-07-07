# Spec: Module Allocation — Project Lead → Consultant

**Status:** Draft  
**Date:** 2026-07-07  
**Scope:** `project-lead.html`, `consultant.html`, two new Netlify functions

---

## 1. Summary

The Project Lead can open an allocation panel on any Module row, pick one or more consultants/developers from the Project's resource list, and save the assignment. ERPNext's native `_assign` field on the Module-level Task is updated. On the consultant side, the workspace auto-filters to show only modules (and their FRs/OIs) that are assigned to the logged-in user.

---

## 2. User Stories

| Actor | Story |
|---|---|
| Project Lead | I can click "Assign" on any Module row and pick one or more people from the project resource list |
| Project Lead | I can see who is currently assigned to each module at a glance |
| Project Lead | I can re-assign or clear assignment at any time |
| Consultant | My workspace opens pre-filtered to modules assigned to me — no manual filtering needed |
| Consultant | I can still remove the filter and browse all tasks if needed |

---

## 3. Data Source — Resource Allocation Doctype

Resources are stored in a custom **Resource Allocation** doctype (not the Project child table). Fields relevant to this feature:

| Field | Type | Notes |
|---|---|---|
| `project` | Link → Project | Filter by this |
| `employee` | Link → Employee | e.g. `HR-EMP-00010` |
| `employee_name` | Data | e.g. `Vruti Rathod` |
| `role` | Select | e.g. `Project Manager`, `Consultant` |
| `status` | Select | `Active` / `Inactive` |

**API call to fetch active resources for the project:**
```
GET /api/resource/Resource Allocation
  ?filters=[["project","=","{ERP_PROJECT_NAME}"],["status","=","Active"]]
  &fields=["employee","employee_name","role","custom_user_id"]
  &limit_page_length=0
```

The Project name is supplied via env var `ERP_PROJECT_NAME`.

> **User identity:** The `_assign` field on Task stores ERPNext User IDs (email strings). The Resource Allocation doctype has a `custom_user_id` field that holds the User ID directly — no secondary Employee lookup needed.

> **Fallback:** If no active resources exist for the project, return an empty list — UI degrades gracefully with "No active resources found for this project".

---

## 4. Assignment Mechanism — Frappe Assignment API

ERPNext stores task assignments in the `_assign` field (JSON array of user ID strings), but this field is managed internally via `tabToDo`. **Directly PUTting `_assign` on the Task resource does not persist reliably** — the underlying `tabToDo` table is not updated, so the field reverts on the next read.

The correct approach uses two Frappe endpoints:

**Read current assignees:**
```
GET /api/resource/Task/{module_task_name}?fields=["_assign"]
```
Response: `{ "data": { "_assign": "[\"rahul@akhilam.com\"]" } }`

**Add an assignee:**
```
POST /api/method/frappe.desk.form.assign_to.add
Content-Type: application/x-www-form-urlencoded

doctype=Task&name={task_name}&assign_to=["email@example.com"]&description=
```

**Remove an assignee:**
```
POST /api/method/frappe.desk.form.assign_to.remove
Content-Type: application/x-www-form-urlencoded

doctype=Task&name={task_name}&assign_to=email@example.com
```

**Full replacement strategy** (what `assign-module.js` implements):
1. Read current `_assign` list from ERPNext
2. Diff: compute `toAdd` (in new, not in current) and `toRemove` (in current, not in new)
3. Call `assign_to.remove` for each departing user
4. Call `assign_to.add` for each new user

All calls use the visiting user's `erp_sid` cookie so ERPNext logs the correct actor.

---

## 5. New Netlify Functions

### 5a. `get-project-resources.js`
- **Method:** GET
- **Auth:** erp_sid cookie (same pattern as all other functions)
- **Returns:**
  ```json
  {
    "resources": [
      { "name": "Vruti Rathod", "email": "vruti@akhilam.com", "role": "Project Manager" },
      { "name": "Rahul Sharma", "email": "rahul@akhilam.com", "role": "Consultant" }
    ]
  }
  ```
- **Source:** `GET /api/resource/Resource Allocation` filtered by `project = ERP_PROJECT_NAME` and `status = Active`; uses `custom_user_id` directly as the email/user ID — no secondary lookup
- **Caching:** `Cache-Control: private, max-age=300` (5 min; resources change rarely)

### 5b. `assign-module.js`
- **Method:** POST
- **Body:** `{ "moduleTaskName": "TASK-2026-XXXXX", "assignees": ["rahul@akhilam.com"] }`
- **Auth:** erp_sid cookie
- **Action:** `PUT /api/resource/Task/{moduleTaskName}` with `{ "_assign": JSON.stringify(assignees) }`
- **Returns:** `{ "ok": true, "assignees": [...] }` on success
- **Validation:**
  - `moduleTaskName` must be a non-empty string
  - `assignees` must be an array (can be empty — empty array clears the assignment)
  - Max 10 assignees per module

---

## 6. UI Changes — `project-lead.html`

### 6a. Module row — "Assign" control

Each module group header row gets a compact assignee display + trigger button:

```
▶  [HR]  Module 1: Core HR      [Rahul S.] [+1]  [Assign ▾]   12/20 FR ...
```

- If unassigned: shows `[Assign ▾]` pill in muted grey
- If assigned: shows avatar-style chips (first name + last initial) for up to 2, then `+N` for more
- Clicking `[Assign ▾]` or the chips opens the **Allocation Panel**

### 6b. Allocation Panel (dropdown/popover)

Opens inline below the module row (not a full-screen modal — keeps context visible).

```
┌─────────────────────────────────────────────────┐
│  Assign Module 1: Core HR                    ✕  │
├─────────────────────────────────────────────────┤
│  [✓] Rahul Sharma     rahul@akhilam.com         │
│  [ ] Priya Mehta      priya@akhilam.com         │
│  [ ] Aditya Kumar     aditya@akhilam.com        │
├─────────────────────────────────────────────────┤
│  [Clear all]                    [Save  →]       │
└─────────────────────────────────────────────────┘
```

- Checkboxes — multi-select allowed
- Currently assigned people are pre-checked (read from module's `_assign` via data already loaded)
- **Save** calls `assign-module.js` → updates ERPNext → updates in-memory data → re-renders the row chips
- **Clear all** unchecks everyone; still requires Save to persist
- Panel closes on Save, Escape, or clicking outside

### 6c. Visual state after save

Module row chips update immediately (optimistic). A brief `✓ Saved` toast appears for 2 seconds.

---

## 7. UI Changes — `consultant.html`

### 7a. Auto-filter on login

After `loadData()` returns, check if the logged-in user's email appears in any module's `_assign`. The `get-consultant-data.js` response will be extended to include `assignees: string[]` on each module object.

If the user is assigned to at least one module:
- Show a **"Showing your assigned modules"** info bar below the toolbar
- Filter the task list to show only those modules
- Provide a `[Show all]` button to remove the filter

If the user is not assigned to anything: show all tasks (current behaviour) with no banner.

### 7b. Assignment badge on module group header

Each module group header in the consultant view gets a small "assigned to" indicator:
```
▼  [HR]  Module 1: Core HR   [You + 1]   12/20 FR done ...
```

---

## 8. `get-consultant-data.js` — Required Extension

Add `assignees: string[]` to each module in the response:

```json
{
  "hr": {
    "modules": [
      {
        "name": "Module 1: Core HR",
        "taskName": "TASK-2026-...",
        "assignees": ["rahul@akhilam.com", "priya@akhilam.com"],
        ...
      }
    ]
  }
}
```

Source: include `_assign` in `TASK_FIELDS`, parse JSON, attach to each module node in `buildSection()`.

Same extension applies to `get-lead-data.js` so the PM view can read current assignees on page load without extra round-trips.

---

## 9. New Env Var

| Variable | Purpose |
|---|---|
| `ERP_PROJECT_NAME` | The ERPNext Project doctype name (e.g. `"Pioneer ERP Implementation"`) |

Add to `.env.example`.

---

## 10. Implementation Order

1. Add `ERP_PROJECT_NAME` to `.env.example`
2. Extend `TASK_FIELDS` in `get-consultant-data.js` and `get-lead-data.js` to include `_assign`; surface `assignees` on each module
3. Write `get-project-resources.js`
4. Write `assign-module.js`
5. Add allocation panel UI to `project-lead.html`
6. Add auto-filter + assignment badge to `consultant.html`

---

## 11. Out of Scope (this iteration)

- FR-level or OI-level allocation (module-level only)
- Email/notification on assignment
- Assignment history / audit trail in the dashboard (ERPNext tracks this natively)
- Drag-and-drop reallocation
