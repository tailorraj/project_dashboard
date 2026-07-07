// Returns active resources for the project from the Resource Allocation doctype.
// Fields used: employee_name, role, custom_user_id (ERPNext User email).

const ERP_URL          = process.env.ERP_URL;
const ERP_PROJECT_NAME = process.env.ERP_PROJECT_NAME;

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
    throw new Error(`Network error at ${path}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error(`Not authorized (${res.status}).`), { authError: true });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ERPNext ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data ?? json.message ?? [];
}

exports.handler = async function (event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, max-age=300" };

  if (!ERP_URL)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ERP_URL env var." }) };
  if (!ERP_PROJECT_NAME)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ERP_PROJECT_NAME env var." }) };

  const cookies = parseCookies(event.headers && event.headers.cookie);
  const sid = cookies.erp_sid;
  if (!sid)
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Not logged in." }) };

  const authHeaders = { Cookie: `sid=${sid}` };

  try {
    const baseParams = {
      fields: ["employee_name", "role", "custom_user_id"],
      limit_page_length: 0,
    };

    // Try with project filter first; fall back to all active records if nothing matches.
    // This handles cases where the project link value doesn't exactly match ERP_PROJECT_NAME.
    let rows = await erpGet("/api/resource/Resource Allocation", {
      ...baseParams,
      filters: [["project", "=", ERP_PROJECT_NAME], ["status", "=", "Active"]],
    }, authHeaders);

    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn(`[get-project-resources] project filter returned nothing for "${ERP_PROJECT_NAME}" — falling back to all active records`);
      rows = await erpGet("/api/resource/Resource Allocation", {
        ...baseParams,
        filters: [["status", "=", "Active"]],
      }, authHeaders);
    }

    const resources = (Array.isArray(rows) ? rows : [])
      .filter(r => r.custom_user_id)
      .map(r => ({
        name:  r.employee_name || r.custom_user_id,
        email: r.custom_user_id,
        role:  r.role || "",
      }));

    return { statusCode: 200, headers, body: JSON.stringify({ resources }) };
  } catch (err) {
    if (err.authError)
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired." }) };
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
