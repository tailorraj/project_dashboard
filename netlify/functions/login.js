// netlify/functions/login.js
//
// Authenticates a dashboard visitor against ERPNext using their own Frappe
// username/password (NOT the shared ERP_API_KEY/SECRET service account).
// On success, ERPNext issues a session id ("sid") which we forward to the
// browser as an HttpOnly cookie. Every subsequent call to
// get-progress-data.js reads that cookie and uses it to talk to ERPNext AS
// THAT USER, so ERPNext's own role/permission rules apply per-visitor.

const ERP_URL = process.env.ERP_URL;

const COMMON_HEADERS = {
  "Content-Type": "application/json",
};

function sidCookie(sid, maxAgeSeconds) {
  // HttpOnly: JS on the page can't read/exfiltrate it.
  // SameSite=Lax + Secure: sent back on top-level navigation/fetch to the same site over HTTPS.
  // Path=/: needed on every function call, not just /login.
  return `erp_sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: COMMON_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (!ERP_URL) {
    return { statusCode: 500, headers: COMMON_HEADERS, body: JSON.stringify({ error: "Missing ERP_URL env var." }) };
  }

  let usr, pwd;
  try {
    ({ usr, pwd } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers: COMMON_HEADERS, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  if (!usr || !pwd) {
    return { statusCode: 400, headers: COMMON_HEADERS, body: JSON.stringify({ error: "Username and password are required." }) };
  }

  let res;
  try {
    res = await fetch(`${ERP_URL}/api/method/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usr, pwd }),
    });
  } catch (networkErr) {
    console.error("[login] network error contacting ERPNext:", networkErr);
    return { statusCode: 502, headers: COMMON_HEADERS, body: JSON.stringify({ error: "Could not reach ERPNext." }) };
  }

  if (!res.ok) {
    console.warn(`[login] ERPNext rejected login for ${usr}: status=${res.status}`);
    return { statusCode: 401, headers: COMMON_HEADERS, body: JSON.stringify({ error: "Invalid username or password." }) };
  }

  // Frappe's login response sets a `sid` cookie among possibly several
  // Set-Cookie headers (sid, system_user, full_name, user_id...). We only
  // need `sid` — that's the actual session identifier used for auth on
  // subsequent requests.
  const rawSetCookie = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);

  const sidPair = rawSetCookie
    .map((c) => c.split(";")[0])
    .find((c) => c.trim().startsWith("sid="));

  if (!sidPair) {
    console.error("[login] ERPNext login succeeded but no sid cookie returned", rawSetCookie);
    return { statusCode: 502, headers: COMMON_HEADERS, body: JSON.stringify({ error: "ERPNext did not return a session." }) };
  }

  const sid = sidPair.split("=").slice(1).join("=");
  const body = await res.json().catch(() => ({}));

  return {
    statusCode: 200,
    headers: COMMON_HEADERS,
    multiValueHeaders: {
      "Set-Cookie": [sidCookie(sid, 60 * 60 * 8)], // 8 hour session
    },
    body: JSON.stringify({ ok: true, fullName: body.full_name || usr }),
  };
};
