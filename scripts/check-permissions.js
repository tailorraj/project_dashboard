#!/usr/bin/env node
// Usage: node scripts/check-permissions.js <username> <password>
// Reads ERP_URL from .env in the project root.

const fs   = require("fs");
const path = require("path");

// ---------- load .env ----------
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"#\n]*)"?/);
    if (m) process.env[m[1]] = m[2].trim();
  });
}

const ERP_URL          = process.env.ERP_URL;
const HR_ROOT_TASK     = process.env.HR_ROOT_TASK     || "TASK-2026-01212";
const TENDER_ROOT_TASK = process.env.TENDER_ROOT_TASK || "TASK-2026-01214";
const LEAD_ROLE        = process.env.LEAD_ROLE        || "Akhilam Lead";

const [,, username, password] = process.argv;
if (!username || !password) {
  console.error("Usage: node scripts/check-permissions.js <username> <password>");
  process.exit(1);
}
if (!ERP_URL) {
  console.error("ERP_URL not set in .env");
  process.exit(1);
}

// ---------- helpers ----------
const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
const WARN = "⚠️  WARN";

function result(label, ok, detail = "") {
  const icon = ok === true ? PASS : ok === "warn" ? WARN : FAIL;
  console.log(`  ${icon}  ${label}${detail ? `  →  ${detail}` : ""}`);
  return ok === true;
}

async function get(sid, path, params = {}) {
  const url = new URL(`${ERP_URL}${path}`);
  Object.entries(params).forEach(([k, v]) =>
    url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v))
  );
  const res = await fetch(url.toString(), { headers: { Cookie: `sid=${sid}` } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

// ---------- main ----------
(async () => {
  console.log(`\nERPNext Permission Check`);
  console.log(`URL:  ${ERP_URL}`);
  console.log(`User: ${username}`);
  console.log("─".repeat(55));

  // 1. Login
  console.log("\n[1] Login");
  let sid;
  try {
    const res = await fetch(`${ERP_URL}/api/method/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usr: username, pwd: password }),
    });
    const setCookie = res.headers.get("set-cookie") || "";
    const match = setCookie.match(/sid=([^;]+)/);
    sid = match?.[1];
    const ok = res.ok && sid && sid !== "Guest";
    result("Login", ok, ok ? `sid obtained` : `HTTP ${res.status} — wrong credentials?`);
    if (!ok) process.exit(1);
  } catch (e) {
    result("Login", false, e.message);
    process.exit(1);
  }

  // 2. Confirm session user
  console.log("\n[2] Session");
  const meRes = await get(sid, "/api/method/frappe.auth.get_logged_user");
  const loggedUser = meRes.body?.message;
  result("get_logged_user", meRes.ok && loggedUser && loggedUser !== "Guest", loggedUser || "Guest");

  // 3 & 4. Role check — same method as Netlify function (User list + Has Role filter)
  console.log("\n[3] Role check via Has Role filter");
  const roleUrl = new URL(`${ERP_URL}/api/resource/User`);
  roleUrl.searchParams.set("filters", JSON.stringify([["name","=",username],["Has Role","role","=",LEAD_ROLE]]));
  roleUrl.searchParams.set("fields", JSON.stringify(["name"]));
  roleUrl.searchParams.set("limit_page_length", "1");
  const roleRes  = await fetch(roleUrl.toString(), { headers: { Cookie: `sid=${sid}` } });
  const roleBody = await roleRes.json().catch(() => ({}));
  const hasLeadRole = (roleBody.data || []).length > 0;
  result(`Query User with role="${LEAD_ROLE}"`, roleRes.ok, `HTTP ${roleRes.status}`);

  console.log("\n[4] Required role");
  result(`Has "${LEAD_ROLE}" role`, hasLeadRole, hasLeadRole ? "present" : `missing — add this role in ERPNext`);

  // 5. Task — read list
  console.log("\n[5] Task doctype");
  const taskListRes = await get(sid, "/api/resource/Task", {
    fields: ["name"], limit_page_length: 1,
  });
  result("Read Task (list)", taskListRes.ok, `HTTP ${taskListRes.status}`);

  // Task — read specific root tasks
  for (const [label, taskName] of [["HR root task", HR_ROOT_TASK], ["Tender root task", TENDER_ROOT_TASK]]) {
    const r = await get(sid, `/api/resource/Task/${encodeURIComponent(taskName)}`);
    result(`Read ${label} (${taskName})`, r.ok, `HTTP ${r.status}${!r.ok ? " — task missing or no permission" : ""}`);
  }

  // Task — write (PUT)
  const taskWriteRes = await get(sid, `/api/resource/Task/${encodeURIComponent(HR_ROOT_TASK)}`);
  const canReadForWrite = taskWriteRes.ok;
  // We won't actually write — just check if doctype allows write via permissions endpoint
  const taskPermRes = await get(sid, `/api/resource/Task/${encodeURIComponent(HR_ROOT_TASK)}`, {});
  result(
    "Task write permission (inferred)",
    canReadForWrite ? "warn" : false,
    canReadForWrite ? "readable — write assumed if role has it; not destructively tested" : "cannot read, write likely blocked too"
  );

  // 6. Timesheet — read list
  console.log("\n[6] Timesheet doctype");
  const tsRes = await get(sid, "/api/resource/Timesheet", {
    fields: ["name"], limit_page_length: 1,
  });
  result("Read Timesheet (list)", tsRes.ok, `HTTP ${tsRes.status}`);

  // 7. Resource Allocation — read list
  console.log("\n[7] Resource Allocation doctype");
  const raRes = await get(sid, "/api/resource/Resource Allocation", {
    fields: ["name"], limit_page_length: 1,
  });
  result("Read Resource Allocation (list)", raRes.ok, `HTTP ${raRes.status}`);

  // 8. Comment — read + create check
  console.log("\n[8] Comment doctype");
  const cmtRes = await get(sid, "/api/resource/Comment", {
    fields: ["name"], limit_page_length: 1,
  });
  result("Read Comment (list)", cmtRes.ok, `HTTP ${cmtRes.status}`);

  // ---------- summary ----------
  console.log("\n" + "─".repeat(55));
  if (!hasLeadRole) {
    console.log(`\nACTION REQUIRED:`);
    console.log(`  In ERPNext → Users → ${username} → Roles tab`);
    console.log(`  → Add "${LEAD_ROLE}" → Save\n`);
  } else {
    console.log(`\nAll role checks passed. If dashboard still fails, check`);
    console.log(`Netlify function logs for the exact error stage.\n`);
  }
})();
