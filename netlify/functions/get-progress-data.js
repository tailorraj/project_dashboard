// netlify/functions/get-progress-data.js
//
// Secure server-side proxy: every call is made using the VISITING USER's own
// Frappe session (the `erp_sid` cookie set by login.js after they authenticate
// with their ERPNext username/password) — never a shared service account. So
// ERPNext's own role/permission rules decide what each visitor can see. The
// browser never sees ERPNext credentials, only the shaped JSON response.
//
// Uses ERPNext's standard REST API (/api/resource/...) — no custom app or
// whitelisted method needs to be installed on the ERPNext side.

const ERP_URL = process.env.ERP_URL;
const HR_ROOT_TASK = process.env.HR_ROOT_TASK || "TASK-2026-01212";
const TENDER_ROOT_TASK = process.env.TENDER_ROOT_TASK || "TASK-2026-01214";

const TASK_FIELDS = [
  "name", "subject", "status", "parent_task", "type", "is_group",
  "lft", "rgt", "exp_start_date", "exp_end_date", "modified", "description",
];

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

// ---------- small REST helpers ----------
// `authHeaders` carries the visiting user's ERPNext session (Cookie: sid=...)
// — threaded explicitly through every call rather than a module-level
// constant, since it differs per incoming request/user.
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
    console.error(`[erpGet] network error for ${path}:`, networkErr);
    throw new Error(`Network error calling ERPNext at ${path}: ${networkErr.message}`);
  }
  console.log(`[erpGet] <- ${path} status=${res.status}`);
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Not authorized to read ${path} (${res.status}).`), { authError: true, status: res.status });
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`[erpGet] FAILED ${path} (${res.status}): ${body.slice(0, 500)}`);
    throw new Error(`ERPNext request failed (${res.status}) for ${path}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const data = json.data ?? json.message ?? [];
  console.log(`[erpGet] ${path} returned ${Array.isArray(data) ? data.length + " rows" : typeof data}`);
  return data;
}

async function getTaskByName(name, authHeaders) {
  const url = `${ERP_URL}/api/resource/Task/${encodeURIComponent(name)}`;
  console.log(`[getTaskByName] -> ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: authHeaders });
  } catch (networkErr) {
    console.error(`[getTaskByName] network error fetching ${name}:`, networkErr);
    throw new Error(`Network error fetching root task ${name}: ${networkErr.message}`);
  }
  console.log(`[getTaskByName] <- ${name} status=${res.status}`);
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Not authorized to read root task ${name} (${res.status}).`), { authError: true, status: res.status });
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`[getTaskByName] FAILED ${name} (${res.status}): ${body.slice(0, 500)}`);
    throw new Error(`Could not fetch root task ${name} (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.data) {
    console.error(`[getTaskByName] ${name} responded OK but had no .data field:`, JSON.stringify(json).slice(0, 300));
    throw new Error(`Root task ${name} response had no data — check the task name/env var is correct.`);
  }
  if (json.data.lft == null || json.data.rgt == null) {
    console.error(`[getTaskByName] ${name} missing lft/rgt`, json.data);
    throw new Error(`Root task ${name} is missing lft/rgt nested-set fields.`);
  }
  return json.data;
}

async function getSubtree(rootLft, rootRgt, authHeaders) {
  return erpGet("/api/resource/Task", {
    filters: [
      ["lft", ">", rootLft],
      ["lft", "<", rootRgt],
    ],
    fields: TASK_FIELDS,
    limit_page_length: 0,
  }, authHeaders);
}

// ---------- week window (Mon 00:00 -> Sun 23:59, local server time) ----------
function currentWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun
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

async function getActiveTaskNamesThisWeek(allTaskNames, authHeaders) {
  if (allTaskNames.length === 0) return new Set();
  const { start, end } = currentWeekRange();
  const taskSet = new Set(allTaskNames);
  const active = new Set();

  // Frappe child-table doctypes (like "Timesheet Detail") can't be listed
  // directly via /api/resource/<Child Doctype> — permission checks are
  // evaluated against the child doctype itself, which usually has no
  // independent role permissions and 403s. Instead, query the parent
  // "Timesheet" doctype (which the API user does have read access to),
  // using Frappe's doctype-qualified filter syntax
  // ["<Child Doctype>", "<fieldname>", "<op>", value] to filter on child-row
  // values, and dotted "time_logs.<field>" in `fields` to pull the matching
  // child rows back out flattened (one row per timesheet-detail entry).
  //
  // If this visitor's ERPNext user can't read Timesheet, this degrades to an
  // empty active-tasks list rather than failing the whole dashboard.
  let timesheets;
  try {
    timesheets = await erpGet("/api/resource/Timesheet", {
      filters: [
        ["Timesheet Detail", "from_time", ">=", toErpDatetime(start)],
        ["Timesheet Detail", "from_time", "<=", toErpDatetime(end)],
      ],
      fields: ["name", "time_logs.task", "time_logs.from_time"],
      limit_page_length: 0,
    }, authHeaders);
  } catch (err) {
    console.error("[getActiveTaskNamesThisWeek] failed to fetch Timesheets, treating as no active tasks:", err.message);
    return active;
  }

  timesheets.forEach((row) => {
    if (row.task && taskSet.has(row.task)) active.add(row.task);
  });

  return active;
}

// ---------- subject parsing ----------
// Real ERPNext Task names are auto-generated (TASK-2026-XXXXX). The readable
// codes (FR-HR-004, OI-01, "Module 1: ...") live inside `subject`, in the
// form "CODE: Title text". Split them back apart here.
function splitCodeTitle(subject) {
  const idx = subject.indexOf(":");
  if (idx === -1) return { code: subject, title: subject };
  return {
    code: subject.slice(0, idx).trim(),
    title: subject.slice(idx + 1).trim(),
  };
}

// ---------- tree building ----------
function buildSubmodule(rootDoc, allTasks) {
  const byParent = {};
  allTasks.forEach((t) => {
    (byParent[t.parent_task] = byParent[t.parent_task] || []).push(t);
  });

  const moduleTasks = (byParent[rootDoc.name] || []).filter((t) => t.is_group);

  const modules = moduleTasks.map((mod) => {
    const children = byParent[mod.name] || [];
    const frTasks = children.filter((t) => t.type === "Functional Requirement");
    const moduleOi = children
      .filter((t) => t.type === "Open Item")
      .map(shapeOi);

    const frs = frTasks.map((fr) => {
      const frChildren = byParent[fr.name] || [];
      const frOi = frChildren.filter((t) => t.type === "Open Item").map(shapeOi);
      const { code, title } = splitCodeTitle(fr.subject);
      return {
        id: code,
        taskName: fr.name, // real ERPNext name, kept for deep-linking back to /app/task/<name>
        title,
        status: fr.status,
        description: fr.description || "",
        oi: frOi,
      };
    });

    const starts = frTasks.map((f) => f.exp_start_date).filter(Boolean).sort();
    const ends = frTasks.map((f) => f.exp_end_date).filter(Boolean).sort();

    const { title: moduleName } = splitCodeTitle(mod.subject); // strips "Module N: " prefix

    return {
      name: moduleName,
      taskName: mod.name,
      start: starts[0] || null,
      end: ends[ends.length - 1] || null,
      moduleOi,
      frs,
    };
  });

  return { label: rootDoc.subject, modules };
}

function shapeOi(t) {
  const { code, title } = splitCodeTitle(t.subject);
  return {
    id: code,
    taskName: t.name,
    status: t.status,
    desc: title,
    // owner_department is an OPTIONAL custom field — add it on Task in ERPNext
    // (Customize Form) if you want the OI dialog to show an owner. Falls back
    // gracefully if it isn't present.
    owner: t.owner_department || "—",
  };
}

function collectOverdue(allTasks) {
  const today = new Date().toISOString().slice(0, 10);
  return allTasks
    .filter(
      (t) =>
        t.exp_end_date &&
        t.exp_end_date < today &&
        !["Completed", "Cancelled"].includes(t.status)
    )
    .map((t) => ({
      id: t.name,
      title: t.subject,
      status: t.status,
      dueDate: t.exp_end_date,
    }));
}

// ---------- Netlify handler ----------
exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    // Per-user data must not be cached at the shared edge — different
    // visitors can legitimately see different data based on their own
    // ERPNext permissions.
    "Cache-Control": "private, no-store",
  };

  console.log("[handler] start", { ERP_URL_present: !!ERP_URL, HR_ROOT_TASK, TENDER_ROOT_TASK });

  if (!ERP_URL) {
    console.error("[handler] missing required env vars");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Missing ERP_URL env var." }),
    };
  }

  const cookies = parseCookies(event.headers && event.headers.cookie);
  const sid = cookies.erp_sid;
  if (!sid) {
    console.warn("[handler] no erp_sid cookie on request — visitor is not logged in");
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "Not logged in.", stage: "auth" }),
    };
  }
  const authHeaders = { Cookie: `sid=${sid}` };

  let stage = "init";
  try {
    stage = "fetch root tasks";
    const [hrRoot, tenderRoot] = await Promise.all([
      getTaskByName(HR_ROOT_TASK, authHeaders),
      getTaskByName(TENDER_ROOT_TASK, authHeaders),
    ]);
    console.log("[handler] roots fetched", {
      hrRoot: { name: hrRoot.name, lft: hrRoot.lft, rgt: hrRoot.rgt },
      tenderRoot: { name: tenderRoot.name, lft: tenderRoot.lft, rgt: tenderRoot.rgt },
    });

    stage = "fetch subtrees";
    const [hrTasks, tenderTasks] = await Promise.all([
      getSubtree(hrRoot.lft, hrRoot.rgt, authHeaders),
      getSubtree(tenderRoot.lft, tenderRoot.rgt, authHeaders),
    ]);
    console.log("[handler] subtrees fetched", {
      hrTasks: hrTasks.length,
      tenderTasks: tenderTasks.length,
    });

    const allTasks = [...hrTasks, ...tenderTasks];
    const allTaskNames = allTasks.map((t) => t.name);

    stage = "fetch active tasks (Timesheet Detail)";
    const activeNames = await getActiveTaskNamesThisWeek(allTaskNames, authHeaders);
    const activeTasks = allTasks
      .filter((t) => activeNames.has(t.name))
      .map((t) => ({ id: t.name, title: t.subject, status: t.status }));
    console.log("[handler] active tasks resolved", { count: activeTasks.length });

    stage = "collect overdue";
    const overdueTasks = collectOverdue(allTasks);

    stage = "build payload";
    const payload = {
      hr: buildSubmodule(hrRoot, hrTasks),
      tender: buildSubmodule(tenderRoot, tenderTasks),
      activeTasks,
      overdueTasks,
      generatedAt: new Date().toISOString(),
    };

    console.log("[handler] success", {
      hrModules: payload.hr.modules.length,
      tenderModules: payload.tender.modules.length,
    });

    return { statusCode: 200, headers, body: JSON.stringify(payload) };
  } catch (err) {
    if (err.authError) {
      console.warn(`[handler] auth error at stage "${stage}": session invalid/expired or lacks permission`);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Your ERPNext session has expired or lacks permission. Please log in again.", stage }),
      };
    }
    console.error(`[handler] FAILED at stage "${stage}":`, err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message, stage }),
    };
  }
};
