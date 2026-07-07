// Updates allowed Task fields via the visiting user's own ERPNext session.
// Only whitelisted fields are forwarded — everything else is silently dropped.
const ERP_URL = process.env.ERP_URL;

const ALLOWED_FIELDS = new Set(["status", "exp_end_date", "exp_start_date", "description"]);

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

exports.handler = async function (event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };

  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!ERP_URL)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ERP_URL env var." }) };

  const cookies = parseCookies(event.headers && event.headers.cookie);
  const sid = cookies.erp_sid;
  if (!sid)
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Not logged in." }) };

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  const { taskName, fields } = body;
  if (!taskName || typeof taskName !== "string")
    return { statusCode: 400, headers, body: JSON.stringify({ error: "taskName (string) required." }) };
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    return { statusCode: 400, headers, body: JSON.stringify({ error: "fields (object) required." }) };

  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(k)) safe[k] = v;
  }
  if (Object.keys(safe).length === 0)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No updatable fields provided." }) };

  const url = `${ERP_URL}/api/resource/Task/${encodeURIComponent(taskName)}`;
  console.log(`[task-update] PUT ${url}`, safe);

  let res;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: `sid=${sid}` },
      body: JSON.stringify(safe),
    });
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Network error: ${err.message}` }) };
  }

  console.log(`[task-update] <- ${res.status}`);

  if (res.status === 401 || res.status === 403)
    return { statusCode: res.status, headers, body: JSON.stringify({ error: "Permission denied by ERPNext." }) };

  if (!res.ok) {
    const text = await res.text();
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: `ERPNext error (${res.status}): ${text.slice(0, 300)}` }),
    };
  }

  const json = await res.json();
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data: json.data }) };
};
