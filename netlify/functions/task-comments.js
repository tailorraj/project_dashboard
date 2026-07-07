// GET  /?task=TASK-2026-XXXXX  — lists Comment records for a Task
// POST {taskName, content}     — creates a new Comment on the Task
// All calls use the visiting user's own ERPNext session (erp_sid cookie).
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

exports.handler = async function (event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };

  if (!ERP_URL)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ERP_URL env var." }) };

  const cookies = parseCookies(event.headers && event.headers.cookie);
  const sid = cookies.erp_sid;
  if (!sid)
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Not logged in." }) };

  const authHeaders = { Cookie: `sid=${sid}` };

  // ---------- GET: list comments ----------
  if (event.httpMethod === "GET") {
    const taskName = event.queryStringParameters && event.queryStringParameters.task;
    if (!taskName)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "'task' query param required." }) };

    const url = new URL(`${ERP_URL}/api/resource/Comment`);
    url.searchParams.set("filters", JSON.stringify([
      ["reference_doctype", "=", "Task"],
      ["reference_name", "=", taskName],
      ["comment_type", "=", "Comment"],
    ]));
    url.searchParams.set("fields", JSON.stringify(["name", "content", "owner", "creation"]));
    url.searchParams.set("order_by", "creation asc");
    url.searchParams.set("limit_page_length", "100");

    console.log(`[task-comments] GET comments for ${taskName}`);
    let res;
    try {
      res = await fetch(url.toString(), { headers: authHeaders });
    } catch (err) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
    }

    if (res.status === 401 || res.status === 403)
      return { statusCode: res.status, headers, body: JSON.stringify({ error: "Permission denied." }) };
    if (!res.ok) {
      const text = await res.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: `ERPNext error (${res.status}): ${text.slice(0,200)}` }) };
    }

    const json = await res.json();
    return { statusCode: 200, headers, body: JSON.stringify({ comments: json.data || [] }) };
  }

  // ---------- POST: add comment ----------
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body." }) };
    }

    const { taskName, content } = body;
    if (!taskName || typeof taskName !== "string")
      return { statusCode: 400, headers, body: JSON.stringify({ error: "taskName required." }) };
    if (!content || typeof content !== "string" || !content.trim())
      return { statusCode: 400, headers, body: JSON.stringify({ error: "content required." }) };
    if (content.length > 2000)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Comment exceeds 2000 character limit." }) };

    const url = `${ERP_URL}/api/resource/Comment`;
    console.log(`[task-comments] POST comment on ${taskName}`);

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `sid=${sid}` },
        body: JSON.stringify({
          comment_type: "Comment",
          reference_doctype: "Task",
          reference_name: taskName,
          content: content.trim(),
        }),
      });
    } catch (err) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
    }

    if (res.status === 401 || res.status === 403)
      return { statusCode: res.status, headers, body: JSON.stringify({ error: "Permission denied." }) };
    if (!res.ok) {
      const text = await res.text();
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: `ERPNext error (${res.status}): ${text.slice(0, 300)}` }),
      };
    }

    const json = await res.json();
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, comment: json.data }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed." }) };
};
