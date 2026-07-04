// netlify/functions/logout.js
//
// Clears the erp_sid cookie set by login.js. Best-effort also tells ERPNext
// to invalidate the session server-side.

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
  const headers = { "Content-Type": "application/json" };
  const cookies = parseCookies(event.headers.cookie);
  const sid = cookies.erp_sid;

  if (sid && ERP_URL) {
    try {
      await fetch(`${ERP_URL}/api/method/logout`, {
        headers: { Cookie: `sid=${sid}` },
      });
    } catch (err) {
      console.warn("[logout] failed to notify ERPNext of logout (non-fatal):", err.message);
    }
  }

  return {
    statusCode: 200,
    headers,
    multiValueHeaders: {
      "Set-Cookie": ["erp_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"],
    },
    body: JSON.stringify({ ok: true }),
  };
};
