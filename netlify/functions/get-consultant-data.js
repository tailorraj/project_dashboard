// Consultant workspace data endpoint.
// Returns the same task tree as get-progress-data.js but enriched:
//   - FRs include startDate/endDate + isActive/isOverdue flags
//   - OIs include endDate + isOverdue flag
//   - A top-level summary object with aggregated counts
// Auth: visiting user's erp_sid session cookie.

const ERP_URL         = process.env.ERP_URL;
const HR_ROOT_TASK    = process.env.HR_ROOT_TASK    || "TASK-2026-01212";
const TENDER_ROOT_TASK = process.env.TENDER_ROOT_TASK || "TASK-2026-01214";

const TASK_FIELDS = [
  "name", "subject", "status", "parent_task", "type", "is_group",
  "lft", "rgt", "exp_start_date", "exp_end_date", "description", "_assign",
];

function parseAssign(raw) {
  try { return JSON.parse(raw || "[]"); } catch (_) { return []; }
}

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
  let res;
  try {
    res = await fetch(url.toString(), { headers: authHeaders });
  } catch (err) {
    throw new Error(`Network error for ${path}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error(`Not authorised (${res.status}).`), { authError: true });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ERPNext ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data ?? json.message ?? [];
}

async function getTaskByName(name, authHeaders) {
  const url = `${ERP_URL}/api/resource/Task/${encodeURIComponent(name)}`;
  let res;
  try { res = await fetch(url, { headers: authHeaders }); }
  catch (err) { throw new Error(`Network error fetching ${name}: ${err.message}`); }
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error(`Not authorised (${res.status}).`), { authError: true });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cannot fetch root task ${name} (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.data) throw new Error(`Root task ${name} returned no data.`);
  if (json.data.lft == null) throw new Error(`Root task ${name} missing lft/rgt fields.`);
  return json.data;
}

async function getSubtree(rootLft, rootRgt, authHeaders) {
  return erpGet("/api/resource/Task", {
    filters: [["lft", ">", rootLft], ["lft", "<", rootRgt]],
    fields: TASK_FIELDS,
    limit_page_length: 0,
  }, authHeaders);
}

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
function toErpDatetime(d) { return d.toISOString().slice(0, 19).replace("T", " "); }

async function getActiveTaskNames(allTaskNames, authHeaders) {
  if (!allTaskNames.length) return new Set();
  const { start, end } = currentWeekRange();
  const taskSet = new Set(allTaskNames);
  const active = new Set();
  let timesheets;
  try {
    timesheets = await erpGet("/api/resource/Timesheet", {
      filters: [
        ["Timesheet Detail", "from_time", ">=", toErpDatetime(start)],
        ["Timesheet Detail", "from_time", "<=", toErpDatetime(end)],
      ],
      fields: ["name", "time_logs.task"],
      limit_page_length: 0,
    }, authHeaders);
  } catch {
    return active;
  }
  timesheets.forEach((row) => { if (row.task && taskSet.has(row.task)) active.add(row.task); });
  return active;
}

function splitCodeTitle(subject) {
  const idx = subject.indexOf(":");
  if (idx === -1) return { code: subject, title: subject };
  return { code: subject.slice(0, idx).trim(), title: subject.slice(idx + 1).trim() };
}

function buildSection(rootDoc, allTasks, activeNames, today) {
  const byParent = {};
  allTasks.forEach((t) => { (byParent[t.parent_task] = byParent[t.parent_task] || []).push(t); });

  const moduleTasks = (byParent[rootDoc.name] || []).filter((t) => t.is_group);

  const modules = moduleTasks.map((mod) => {
    const children = byParent[mod.name] || [];
    const frTasks  = children.filter((t) => t.type === "Functional Requirement");
    const moduleOi = children.filter((t) => t.type === "Open Item").map((t) => shapeOi(t, today, activeNames));

    const frs = frTasks.map((fr) => {
      const frChildren = byParent[fr.name] || [];
      const oi = frChildren.filter((t) => t.type === "Open Item").map((t) => shapeOi(t, today, activeNames));
      const { code, title } = splitCodeTitle(fr.subject);
      const isDone = ["Completed", "Cancelled"].includes(fr.status);
      return {
        taskName: fr.name,
        code,
        title,
        status: fr.status,
        description: fr.description || "",
        startDate:  fr.exp_start_date || null,
        endDate:    fr.exp_end_date   || null,
        isActive:   activeNames.has(fr.name),
        isOverdue:  !!(fr.exp_end_date && fr.exp_end_date < today && !isDone),
        oi,
      };
    });

    const starts = frTasks.map((f) => f.exp_start_date).filter(Boolean).sort();
    const ends   = frTasks.map((f) => f.exp_end_date).filter(Boolean).sort();
    const { title: moduleName } = splitCodeTitle(mod.subject);

    return {
      name: moduleName,
      taskName: mod.name,
      start: starts[0] || null,
      end: ends[ends.length - 1] || null,
      assignees: parseAssign(mod._assign),
      moduleOi,
      frs,
    };
  });

  return { label: rootDoc.subject, modules };
}

function shapeOi(t, today, activeNames) {
  const { code, title } = splitCodeTitle(t.subject);
  const isDone = ["Completed", "Cancelled"].includes(t.status);
  return {
    taskName: t.name,
    code,
    title,
    status: t.status,
    owner: t.owner_department || "—",
    endDate: t.exp_end_date || null,
    isActive:  activeNames.has(t.name),
    isOverdue: !!(t.exp_end_date && t.exp_end_date < today && !isDone),
  };
}

async function getLoggedUser(authHeaders) {
  try {
    const res = await fetch(`${ERP_URL}/api/method/frappe.auth.get_logged_user`, { headers: authHeaders });
    if (!res.ok) return null;
    const json = await res.json();
    const u = json.message || null;
    return u && u !== "Guest" ? u : null;
  } catch (_) { return null; }
}

async function userHasRole(username, roleName, authHeaders) {
  try {
    const url = `${ERP_URL}/api/resource/User/${encodeURIComponent(username)}`;
    const res = await fetch(url, { headers: authHeaders });
    if (!res.ok) return false;
    const json = await res.json();
    return (json.data?.roles || []).some(r => r.role === roleName);
  } catch (_) { return false; }
}

exports.handler = async function (event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };

  if (!ERP_URL)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ERP_URL env var." }) };

  const cookies = parseCookies(event.headers && event.headers.cookie);
  const sid = cookies.erp_sid;
  if (!sid)
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Not logged in.", stage: "auth" }) };

  const authHeaders = { Cookie: `sid=${sid}` };
  let stage = "init";

  try {
    stage = "fetch root tasks";
    const [hrRoot, tenderRoot, currentUser] = await Promise.all([
      getTaskByName(HR_ROOT_TASK, authHeaders),
      getTaskByName(TENDER_ROOT_TASK, authHeaders),
      getLoggedUser(authHeaders),
    ]);

    stage = "fetch subtrees";
    const [hrTasks, tenderTasks, isSystemManager] = await Promise.all([
      getSubtree(hrRoot.lft, hrRoot.rgt, authHeaders),
      getSubtree(tenderRoot.lft, tenderRoot.rgt, authHeaders),
      currentUser ? userHasRole(currentUser, "System Manager", authHeaders) : Promise.resolve(false),
    ]);

    const allTaskNames = [...hrTasks, ...tenderTasks].map((t) => t.name);
    stage = "fetch active tasks";
    const activeNames = await getActiveTaskNames(allTaskNames, authHeaders);

    stage = "build payload";
    const today = new Date().toISOString().slice(0, 10);
    const hr     = buildSection(hrRoot,     hrTasks,     activeNames, today);
    const tender = buildSection(tenderRoot, tenderTasks, activeNames, today);

    const allFrs = [...hr.modules, ...tender.modules].flatMap((m) => m.frs);
    const allOis = [...hr.modules, ...tender.modules].flatMap((m) => [
      ...m.moduleOi,
      ...m.frs.flatMap((f) => f.oi),
    ]);

    const summary = {
      totalFr:     allFrs.length,
      completedFr: allFrs.filter((f) => f.status === "Completed").length,
      inProgressFr: allFrs.filter((f) => ["Working", "Pending Review", "Rework"].includes(f.status)).length,
      openOi:      allOis.filter((o) => !["Completed", "Cancelled"].includes(o.status)).length,
      overdueCount: [...allFrs, ...allOis].filter((t) => t.isOverdue).length,
      activeCount:  [...allFrs, ...allOis].filter((t) => t.isActive).length,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ hr, tender, summary, currentUser, isSystemManager, generatedAt: new Date().toISOString() }),
    };
  } catch (err) {
    if (err.authError)
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired or lacks permission.", stage }) };
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message, stage }) };
  }
};
