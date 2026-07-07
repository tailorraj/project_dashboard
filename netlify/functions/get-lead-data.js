// netlify/functions/get-lead-data.js
//
// Project Lead internal dashboard data endpoint.
// Returns enriched task data: consultant assignments, daily timesheet
// activity, and weekly task planning data derived from ERPNext.
//
// Auth is the same per-user session cookie as get-progress-data.js —
// ERPNext's own role permissions govern what each caller can see.

const ERP_URL          = process.env.ERP_URL;
const HR_ROOT_TASK     = process.env.HR_ROOT_TASK     || "TASK-2026-01212";
const TENDER_ROOT_TASK = process.env.TENDER_ROOT_TASK || "TASK-2026-01214";
const LEAD_ROLE        = process.env.LEAD_ROLE        || "Akhilam Lead";

const TASK_FIELDS = [
  "name", "subject", "status", "parent_task", "type", "is_group",
  "lft", "rgt", "exp_start_date", "exp_end_date", "modified", "description",
  "_assign", "priority", "owner",
];

// ---------- auth / request helpers ----------

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

async function erpGet(path, params = {}, authHeaders) {
  const url = new URL(`${ERP_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  });
  console.log(`[erpGet] -> ${url.toString()}`);
  let res;
  try {
    res = await fetch(url.toString(), { headers: authHeaders });
  } catch (networkErr) {
    throw new Error(`Network error at ${path}: ${networkErr.message}`);
  }
  console.log(`[erpGet] <- ${path} status=${res.status}`);
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Not authorized (${res.status}).`), { authError: true });
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ERPNext request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const data = json.data ?? json.message ?? [];
  console.log(`[erpGet] ${path} → ${Array.isArray(data) ? data.length + " rows" : typeof data}`);
  return data;
}

async function getTaskByName(name, authHeaders) {
  const url = `${ERP_URL}/api/resource/Task/${encodeURIComponent(name)}`;
  let res;
  try {
    res = await fetch(url, { headers: authHeaders });
  } catch (e) {
    throw new Error(`Network error fetching ${name}: ${e.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Not authorized to read root task ${name}.`), { authError: true });
  }
  if (!res.ok) throw new Error(`Could not fetch root task ${name} (${res.status})`);
  const json = await res.json();
  if (!json.data) throw new Error(`Root task ${name} had no data field.`);
  if (json.data.lft == null) throw new Error(`Root task ${name} missing lft/rgt.`);
  return json.data;
}

async function getSubtree(rootLft, rootRgt, authHeaders) {
  return erpGet("/api/resource/Task", {
    filters: [["lft", ">", rootLft], ["lft", "<", rootRgt]],
    fields: TASK_FIELDS,
    limit_page_length: 0,
  }, authHeaders);
}

// ---------- date helpers ----------

function currentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

function toErpDatetime(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ---------- subject parsing ----------

function splitCodeTitle(subject) {
  const idx = subject.indexOf(":");
  if (idx === -1) return { code: subject, title: subject };
  return { code: subject.slice(0, idx).trim(), title: subject.slice(idx + 1).trim() };
}

// ---------- assignment helpers ----------

function parseAssign(raw) {
  try { return JSON.parse(raw || "[]"); } catch (_) { return []; }
}

async function getUserNames(userIds, authHeaders) {
  if (userIds.length === 0) return {};
  try {
    const users = await erpGet("/api/resource/User", {
      filters: [["name", "in", userIds]],
      fields: ["name", "full_name"],
      limit_page_length: 0,
    }, authHeaders);
    const map = {};
    users.forEach(u => { map[u.name] = u.full_name || u.name; });
    return map;
  } catch (err) {
    console.error("[getUserNames] failed:", err.message);
    return {};
  }
}

// ---------- timesheet activity ----------

async function getWeeklyTimesheets(allTaskNames, authHeaders) {
  if (allTaskNames.length === 0) return [];
  const { start, end } = currentWeekRange();
  const taskSet = new Set(allTaskNames);

  let timesheets;
  try {
    timesheets = await erpGet("/api/resource/Timesheet", {
      filters: [
        ["Timesheet Detail", "from_time", ">=", toErpDatetime(start)],
        ["Timesheet Detail", "from_time", "<=", toErpDatetime(end)],
      ],
      fields: [
        "name", "owner", "employee_name", "employee",
        "time_logs.task", "time_logs.from_time", "time_logs.hours",
        "time_logs.description", "time_logs.activity_type",
      ],
      limit_page_length: 0,
    }, authHeaders);
  } catch (err) {
    console.error("[getWeeklyTimesheets] failed:", err.message);
    return [];
  }

  const rows = [];
  timesheets.forEach(ts => {
    if (ts.task && taskSet.has(ts.task)) {
      rows.push({
        consultant: ts.employee_name || ts.owner || "Unknown",
        taskId: ts.task,
        date: ts.from_time ? ts.from_time.slice(0, 10) : null,
        hours: parseFloat(ts.hours) || 0,
        activity: ts.activity_type || "",
        remarks: ts.description || "",
      });
    }
  });

  return rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// ---------- tree building ----------

function buildLeadSubmodule(rootDoc, allTasks, userNames) {
  const byParent = {};
  allTasks.forEach(t => {
    (byParent[t.parent_task] = byParent[t.parent_task] || []).push(t);
  });

  function resolveAssigns(raw, ownerUser) {
    const assigned = parseAssign(raw).map(u => userNames[u] || u).filter(Boolean);
    // If no one explicitly assigned, fall back to task owner
    if (assigned.length === 0 && ownerUser) {
      const ownerName = userNames[ownerUser] || ownerUser;
      if (ownerName) return [ownerName];
    }
    return assigned;
  }

  const moduleTasks = (byParent[rootDoc.name] || []).filter(t => t.is_group);

  const modules = moduleTasks.map(mod => {
    const children = byParent[mod.name] || [];
    const frTasks = children.filter(t => t.type === "Functional Requirement");
    const moduleOi = children.filter(t => t.type === "Open Item").map(t => {
      const { code, title } = splitCodeTitle(t.subject);
      return { id: code, taskName: t.name, status: t.status, desc: title };
    });

    const frs = frTasks.map(fr => {
      const frChildren = byParent[fr.name] || [];
      const frOi = frChildren.filter(t => t.type === "Open Item").map(t => {
        const { code, title } = splitCodeTitle(t.subject);
        return { id: code, taskName: t.name, status: t.status, desc: title };
      });
      const { code, title } = splitCodeTitle(fr.subject);
      return {
        id: code,
        taskName: fr.name,
        title,
        status: fr.status,
        start: fr.exp_start_date || null,
        end: fr.exp_end_date || null,
        priority: fr.priority || "Medium",
        assignments: resolveAssigns(fr._assign, fr.owner),
        oi: frOi,
        description: fr.description || "",
      };
    });

    const { title: moduleName } = splitCodeTitle(mod.subject);
    const completedFrs = frs.filter(f => f.status === "Completed").length;
    const inProgressFrs = frs.filter(f => ["Working", "Pending Review", "Rework"].includes(f.status)).length;

    return {
      name: moduleName,
      taskName: mod.name,
      start: mod.exp_start_date || null,
      end: mod.exp_end_date || null,
      assignments: resolveAssigns(mod._assign, mod.owner),
      assigneeEmails: parseAssign(mod._assign),
      moduleOi,
      frs,
      completedFrs,
      inProgressFrs,
      totalFrs: frs.length,
    };
  });

  return {
    label: rootDoc.subject,
    rootStart: rootDoc.exp_start_date || null,
    rootEnd: rootDoc.exp_end_date || null,
    modules,
  };
}

// ---------- role-based access check ----------

// Returns the Frappe username (email) of whoever owns the current session,
// or null if the session is invalid / guest.
async function getLoggedInUser(authHeaders) {
  try {
    const res = await fetch(`${ERP_URL}/api/method/frappe.auth.get_logged_user`, { headers: authHeaders });
    if (!res.ok) return null;
    const json = await res.json();
    const user = json.message || null;
    return user && user !== "Guest" ? user : null;
  } catch (err) {
    console.error("[getLoggedInUser] failed:", err.message);
    return null;
  }
}

// Check if username has a specific role by querying the User list with a
// Has Role child-table filter. Returns true/false using the caller's own
// session — no admin credentials needed.
async function userHasRole(username, role, authHeaders) {
  const url = new URL(`${ERP_URL}/api/resource/User`);
  url.searchParams.set("filters", JSON.stringify([
    ["name", "=", username],
    ["Has Role", "role", "=", role],
  ]));
  url.searchParams.set("fields", JSON.stringify(["name"]));
  url.searchParams.set("limit_page_length", "1");
  console.log(`[userHasRole] checking "${role}" for "${username}"`);
  try {
    const res = await fetch(url.toString(), { headers: authHeaders });
    if (!res.ok) {
      console.error(`[userHasRole] HTTP ${res.status}`);
      return false;
    }
    const json = await res.json();
    const found = (json.data || []).length > 0;
    console.log(`[userHasRole] "${username}" has "${role}": ${found}`);
    return found;
  } catch (err) {
    console.error("[userHasRole] failed:", err.message);
    return false;
  }
}

// ---------- Netlify handler ----------

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
  };

  if (!ERP_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ERP_URL." }) };
  }

  const cookies = parseCookies(event.headers && event.headers.cookie);
  const sid = cookies.erp_sid;
  if (!sid) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Not logged in.", stage: "auth" }) };
  }
  const authHeaders = { Cookie: `sid=${sid}` };

  let stage = "role-check";
  try {
    // Resolve the session owner and verify the required role before touching
    // any task data. Fail closed: if the role check itself fails, deny access.
    const username = await getLoggedInUser(authHeaders);
    if (!username) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Not logged in.", stage: "role-check" }),
      };
    }
    const allowed = await userHasRole(username, LEAD_ROLE, authHeaders);
    if (!allowed) {
      console.warn(`[handler] access denied for ${username} — missing role "${LEAD_ROLE}"`);
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: `Access denied. Your ERPNext account (${username}) does not have the "${LEAD_ROLE}" role.`,
          stage: "role-check",
          requiredRole: LEAD_ROLE,
        }),
      };
    }
    console.log(`[handler] role check passed for ${username}`);

    stage = "fetch root tasks";
    const [hrRoot, tenderRoot] = await Promise.all([
      getTaskByName(HR_ROOT_TASK, authHeaders),
      getTaskByName(TENDER_ROOT_TASK, authHeaders),
    ]);

    stage = "fetch subtrees";
    const [hrTasks, tenderTasks] = await Promise.all([
      getSubtree(hrRoot.lft, hrRoot.rgt, authHeaders),
      getSubtree(tenderRoot.lft, tenderRoot.rgt, authHeaders),
    ]);

    const allTasks = [...hrTasks, ...tenderTasks];
    const allTaskNames = allTasks.map(t => t.name);

    stage = "resolve user names";
    const allUserIds = new Set();
    allTasks.forEach(t => {
      parseAssign(t._assign).forEach(u => allUserIds.add(u));
      if (t.owner) allUserIds.add(t.owner);
    });
    const userNames = await getUserNames([...allUserIds], authHeaders);

    stage = "fetch weekly timesheets";
    const rawActivity = await getWeeklyTimesheets(allTaskNames, authHeaders);

    // Build task + module/section lookup maps for enriching activity rows
    const taskMap = {};
    allTasks.forEach(t => { taskMap[t.name] = t; });

    const moduleOfTask = {};
    const sectionOfTask = {};
    function mapTree(tasks, rootTask, sectionLabel) {
      const bp = {};
      tasks.forEach(t => { (bp[t.parent_task] = bp[t.parent_task] || []).push(t); });
      const mods = (bp[rootTask.name] || []).filter(t => t.is_group);
      mods.forEach(mod => {
        const { title: modName } = splitCodeTitle(mod.subject);
        function walk(pid) {
          (bp[pid] || []).forEach(t => {
            moduleOfTask[t.name] = modName;
            sectionOfTask[t.name] = sectionLabel;
            walk(t.name);
          });
        }
        moduleOfTask[mod.name] = modName;
        sectionOfTask[mod.name] = sectionLabel;
        walk(mod.name);
      });
    }
    mapTree(hrTasks,     hrRoot,     "HR");
    mapTree(tenderTasks, tenderRoot, "Tender");

    const weeklyActivity = rawActivity.map(row => {
      const t = taskMap[row.taskId];
      const { code, title } = t ? splitCodeTitle(t.subject) : { code: row.taskId, title: "" };
      return {
        ...row,
        taskCode: code,
        taskTitle: title,
        module: moduleOfTask[row.taskId] || "—",
        section: sectionOfTask[row.taskId] || "—",
      };
    });

    stage = "build payload";
    const hr     = buildLeadSubmodule(hrRoot,     hrTasks,     userNames);
    const tender = buildLeadSubmodule(tenderRoot, tenderTasks, userNames);

    // Weekly tasks: all non-completed FRs, sorted by urgency
    const statusOrder = { Working: 0, "Pending Review": 1, Rework: 2, Overdue: 3, Open: 4 };
    const weeklyTasks = [];
    [{ section: hr, key: "HR" }, { section: tender, key: "Tender" }].forEach(({ section, key }) => {
      section.modules.forEach(mod => {
        mod.frs
          .filter(fr => !["Completed", "Cancelled"].includes(fr.status))
          .forEach(fr => {
            weeklyTasks.push({
              id: fr.id,
              taskName: fr.taskName,
              title: fr.title,
              status: fr.status,
              description: fr.description || '',
              startDate: fr.start,
              dueDate: fr.end,
              priority: fr.priority,
              module: mod.name,
              section: key,
              assignments: fr.assignments,
              oiCount: fr.oi.length,
            });
          });
      });
    });
    weeklyTasks.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

    console.log("[handler] success", {
      hrModules:     hr.modules.length,
      tenderModules: tender.modules.length,
      activityRows:  weeklyActivity.length,
      weeklyTasks:   weeklyTasks.length,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ hr, tender, weeklyActivity, weeklyTasks, generatedAt: new Date().toISOString() }),
    };
  } catch (err) {
    if (err.authError) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired. Please log in again.", stage }) };
    }
    console.error(`[handler] FAILED at stage "${stage}":`, err);
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message, stage }) };
  }
};
