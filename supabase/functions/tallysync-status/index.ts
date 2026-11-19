// TallySync status: document counts per status, Tally vouchers, last sync run.
// Call:  GET <supabase url>/functions/v1/tallysync-status   with  Authorization: Bearer <service role key>  (and apikey header)
const URL_ = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest(path: string) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if ((req.headers.get("Authorization") || "") !== `Bearer ${KEY}`) return json({ error: "Not allowed" }, 401);
  try {
    const docs: { status: string }[] = await rest("documents?select=status");
    const byStatus: Record<string, number> = {};
    for (const d of docs) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    const vouchers: unknown[] = await rest("tally_vouchers?select=id");
    const runs: unknown[] = await rest("sync_runs?select=id,kind,status,started_at,finished_at&order=id.desc&limit=1");
    return json({ ok: true, documents: byStatus, tally_vouchers: vouchers.length, last_sync_run: runs[0] ?? null });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message) }, 500);
  }
});
