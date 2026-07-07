// Sets module-level Task assignments in ERPNext using the proper Frappe
// assignment API (frappe.desk.form.assign_to.add / .remove).
//
// Direct PUT on _assign is not reliable — Frappe manages assignments via
// tabToDo internally and only updates that table through these endpoints.
//
// Strategy: read current _assign → diff → remove departing users → add new users.
// POST { moduleTaskName: string, assignees: string[] }

const ERP_URL = process.env.ERP_URL;

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

function parseAssign(raw) {
  try { return JSON.parse(raw || "[]"); } catch (_) { return []; }
}

async function erpFetch(url, opts, authHeaders) {
  let res;
  try { res = await fetch(url, { ...opts, headers: { ...authHeaders, ...opts.headers } }); }
  catch (err) { throw new Error(`Network error: ${err.message}`); }
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error(`Not authorized (${res.status}).`), { authError: true });
  return res;
}

async function getCurrentAssignees(taskName, authHeaders) {
  const url = `${ERP_URL}/api/resource/Task/${encodeURIComponent(taskName)}?fields=["_assign"]`;
  const res = await erpFetch(url, { method: "GET" }, authHeaders);
  if (!res.ok) return [];
  const json = await res.json();
  return parseAssign(json.data?._assign);
}

async function addAssignee(taskName, email, authHeaders) {
  const form = new URLSearchParams({
    doctype: "Task",
    name: taskName,
    assign_to: JSON.stringify([email]),
    description: "",
  });
  const res = await erpFetch(
    `${ERP_URL}/api/method/frappe.desk.form.assign_to.add`,
    { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    authHeaders,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`assign_to.add failed for ${email}: ${text.slice(0, 150)}`);
  }
}

async function removeAssignee(taskName, email, authHeaders) {
  const form = new URLSearchParams({
    doctype: "Task",
    name: taskName,
    assign_to: email,
  });
  const res = await erpFetch(
    `${ERP_URL}/api/method/frappe.desk.form.assign_to.remove`,
    { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    authHeaders,
  );
  // 417 from remove means the user wasn't assigned — treat as success
  if (!res.ok && res.status !== 417) {
    const text = await res.text();
    throw new Error(`assign_to.remove failed for ${email}: ${text.slice(0, 150)}`);
  }
}

exports.handler = async function (event) {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed." }) };

  if (!ERP_URL)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ERP_URL env var." }) };

  const cookies = parseCookies(event.headers && event.headers.cookie);
  const sid = cookies.erp_sid;
  if (!sid)
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Not logged in." }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (_) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body." }) }; }

  const { moduleTaskName, assignees } = body;
  if (!moduleTaskName || typeof moduleTaskName !== "string")
    return { statusCode: 400, headers, body: JSON.stringify({ error: "moduleTaskName is required." }) };
  if (!Array.isArray(assignees))
    return { statusCode: 400, headers, body: JSON.stringify({ error: "assignees must be an array." }) };
  if (assignees.length > 10)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 10 assignees per module." }) };

  const authHeaders = { Cookie: `sid=${sid}` };

  try {
    const current = await getCurrentAssignees(moduleTaskName, authHeaders);
    const toAdd    = assignees.filter(e => !current.includes(e));
    const toRemove = current.filter(e => !assignees.includes(e));

    // Remove departing assignees, then add new ones sequentially
    for (const email of toRemove) await removeAssignee(moduleTaskName, email, authHeaders);
    for (const email of toAdd)    await addAssignee(moduleTaskName, email, authHeaders);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, assignees }) };
  } catch (err) {
    if (err.authError)
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired or lacks permission." }) };
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
