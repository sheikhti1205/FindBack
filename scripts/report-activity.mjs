#!/usr/bin/env node
// Convenience reporter for FindBack: prints an activity summary table or writes CSV.
//   node scripts/report-activity.mjs [--csv out.csv] [--days 14]
// Requires an API base URL (default http://localhost:4000) and demo credentials
// via env FB_USER / FB_PASS (defaults rafi_cu / password123).

const API = process.env.FB_API ?? "http://localhost:4000";
const USER = process.env.FB_USER ?? "rafi_cu";
const PASS = process.env.FB_PASS ?? "password123";

const args = process.argv.slice(2);
const days = argVal(args, "--days", "14");
const csvOut = argVal(args, "--csv", "");

function argVal(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
}

async function main() {
  const loginRes = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: USER, password: PASS }),
  });
  if (!loginRes.ok) throw new Error(`login failed (${loginRes.status}) — check FB_USER/FB_PASS`);
  const { token } = await loginRes.json();

  const format = csvOut ? "csv" : "json";
  const res = await fetch(`${API}/reports/activity?days=${days}&format=${format}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`report failed (${res.status})`);

  if (csvOut) {
    const text = await res.text();
    await import("node:fs/promises").then(async ({ writeFile }) => {
      await writeFile(csvOut, text);
    });
    console.log(`Wrote ${csvOut} (${text.split("\r\n").length} lines).`);
    return;
  }

  const r = await res.json();
  const s = r.summary;
  console.log(`FindBack activity report — generated ${r.generatedAt}`);
  console.log("=".repeat(60));
  console.log(`Posts total/7d      : ${s.totalPosts} / ${s.postsLast7Days}`);
  console.log(`  lost ${s.lostPosts} · found ${s.foundPosts}`);
  console.log(`  open ${s.openPosts} · matched ${s.matchedPosts} · recovered ${s.recoveredPosts} · closed ${s.closedPosts}`);
  console.log(`Users               : ${s.totalUsers}`);
  console.log(`Comments/reactions  : ${s.totalComments} / ${s.totalReactions}`);
  console.log(`Ratings (avg)       : ${s.totalRatings} (${s.averageRating ?? "-"})`);
  console.log("");
  console.log("Daily activity:");
  for (const row of r.byDay.filter((d) => d.posts || d.comments || d.newUsers)) {
    console.log(`  ${row.date}  posts=${row.posts} comments=${row.comments} newUsers=${row.newUsers}`);
  }
  console.log("");
  console.log("Top contributors:");
  for (const t of r.topContributors) {
    console.log(`  @${t.username}  posts=${t.posts} comments=${t.comments}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
