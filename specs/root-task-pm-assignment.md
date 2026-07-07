# Spec: Root Task PM Assignment

**Status:** Draft  
**Date:** 2026-07-07  
**Scope:** `project-lead.html`, `netlify/functions/get-lead-data.js`

---

## 1. Summary

A System Manager can open a "Manage PM Assignments" modal on the Project Lead dashboard and assign Project Manager resources (from the Resource Allocation table) to the two root tasks — HR MODULE IMPLEMENTATION and TENDER MODULE IMPLEMENTATION. Once assigned, a Project Manager logging into the dashboard only sees the sections (HR / Tender) assigned to them. System Managers always see everything.

---

## 2. User Stories

| Actor | Story |
|---|---|
| System Manager | I can open a "Manage PM Assignments" modal from the Project Lead dashboard topbar |
| System Manager | I can assign one or more PMs to the HR root task and independently assign PMs to the Tender root task |
| System Manager | I can see who is currently assigned to each root task |
| Project Manager | When I log in, I only see the section(s) assigned to me (HR only, Tender only, or both) |
| Project Manager | If I am not explicitly assigned to any root task, I see both sections (backwards-compatible) |

---

## 3. Data Mechanism

Root task assignment uses the same `_assign` field on the Task doctype, via the same `frappe.desk.form.assign_to.add / .remove` strategy already implemented in `assign-module.js`.

- **HR root task** is already fetched via `getTaskByName(HR_ROOT_TASK)` — its `_assign` field is included in the full Task response.
- **Tender root task** same.

No new Netlify function is needed — the existing `assign-module.js` handles root tasks identically to module-level tasks (it takes any `moduleTaskName`).

---

## 4. Resource Filtering in the Modal

Only resources with `role = "Project Manager"` in the Resource Allocation table should appear as candidates in the assignment modal. The frontend fetches from `get-project-resources.js` and filters client-side:

```js
resources.filter(r => r.role === "Project Manager")
```

---

## 5. Backend Changes — `get-lead-data.js`

### 5a. New additions

1. Add `userHasRole()` helper (same pattern as `get-consultant-data.js`).
2. After fetching root tasks, parse their `_assign` fields:
   ```js
   const hrAssignees     = parseAssign(hrRoot._assign);
   const tenderAssignees = parseAssign(tenderRoot._assign);
   ```
3. Run System Manager check in parallel with subtree fetches:
   ```js
   const [hrTasks, tenderTasks, isSystemManager] = await Promise.all([
     getSubtree(hrRoot.lft, hrRoot.rgt, authHeaders),
     getSubtree(tenderRoot.lft, tenderRoot.rgt, authHeaders),
     username ? userHasRole(username, "System Manager", authHeaders) : Promise.resolve(false),
   ]);
   ```

### 5b. Section filtering logic

```
if isSystemManager:
  → build and return both hr and tender sections (no filter)

else:
  showHr     = hrAssignees.includes(currentUser)     OR hrAssignees.length === 0
  showTender = tenderAssignees.includes(currentUser) OR tenderAssignees.length === 0
  → only build sections where show* is true
  → if both false (assigned to neither despite records existing): show both (safe fallback)
```

The "length === 0" condition preserves backwards-compatible behaviour — if no one has been assigned to a root task yet, all leads see it.

### 5c. Response additions

```json
{
  "hr": { ... },
  "tender": { ... },
  "isSystemManager": true,
  "hrRootTask":     "TASK-2026-01212",
  "tenderRootTask": "TASK-2026-01214",
  "hrAssignees":     ["vruti@akhilam.com"],
  "tenderAssignees": ["rahul@akhilam.com", "priya@akhilam.com"],
  ...
}
```

`hrRootTask` and `tenderRootTask` are passed so the frontend can call `assign-module.js` without hardcoding task names.

---

## 6. UI Changes — `project-lead.html`

### 6a. Topbar button (System Manager only)

A "Manage PMs" button appears in the topbar-right, hidden by default, shown only when `data.isSystemManager === true`:

```
Pioneer ERP  [PROJECT LEAD]          Updated 10:30  ← Client View  Manage PMs  Sign out
```

### 6b. "Manage PM Assignments" Modal

Full-screen overlay modal (not an inline panel — broader scope than module allocation).

```
┌────────────────────────────────────────────────────────┐
│  Manage PM Assignments                              ✕  │
├────────────────────────────────────────────────────────┤
│  HR MODULE IMPLEMENTATION                              │
│  ─────────────────────────────────────────────────     │
│  [✓] Vruti Rathod      vruti@akhilam.com               │
│  [ ] Rahul Sharma      rahul@akhilam.com               │
│                                                        │
│  PIONEER TENDER MODULE                                 │
│  ─────────────────────────────────────────────────     │
│  [ ] Vruti Rathod      vruti@akhilam.com               │
│  [✓] Rahul Sharma      rahul@akhilam.com               │
│  [✓] Priya Mehta       priya@akhilam.com               │
│                                                        │
├────────────────────────────────────────────────────────┤
│  [Cancel]                              [Save  →]       │
└────────────────────────────────────────────────────────┘
```

- Only resources with `role = "Project Manager"` shown
- Pre-checked from `hrAssignees` / `tenderAssignees` in the response
- **Save** fires two calls to `assign-module.js` (one for HR root, one for Tender root) in parallel
- Shows per-section feedback if one fails

### 6c. Section visibility on load

After `render(data)`, if `!isSystemManager`:
- If `data.hr` is absent/null → hide the HR Gantt section entirely
- If `data.tender` is absent/null → hide the Tender Gantt section entirely
- KPI strip recomputes from whichever sections are present

---

## 7. Implementation Order

1. Add `userHasRole()` and `parseAssign()` to `get-lead-data.js`
2. Add section filtering + new response fields (`isSystemManager`, `hrRootTask`, `tenderRootTask`, `hrAssignees`, `tenderAssignees`)
3. Add "Manage PMs" topbar button + modal UI in `project-lead.html`
4. Wire Save to call `assign-module.js` for each root task
5. Wire section visibility filter in `render()`

---

## 8. Out of Scope

- FR / module level filtering per PM (that is handled by module allocation — [[module-allocation]])
- Removing the "Akhilam Lead" role gate — this is an additional filter on top of it
- Notification to PMs when assigned
