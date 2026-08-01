import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanAppCode } from "./appScan.js";

async function withFixture(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "rls-guard-scan-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content, "utf8");
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("finds a simple call site", async () => {
  await withFixture({ "a.ts": `supabase.from('posts').select('*');` }, async (dir) => {
    const sites = await scanAppCode(dir);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].table, "posts");
    assert.equal(sites[0].action, "select");
  });
});

test("gap: dynamic table name (.from(tableVar)) is entirely invisible to the scanner", async () => {
  await withFixture({ "a.ts": `const t = 'posts'; supabase.from(t).select('*');` }, async (dir) => {
    const sites = await scanAppCode(dir);
    assert.equal(sites.length, 0, "regex requires a quoted literal — dynamic names produce zero findings, not a warning");
  });
});

test("gap: template-literal table name with interpolation is invisible", async () => {
  await withFixture({ "a.ts": "supabase.from(`app_${env}`).select('*');" }, async (dir) => {
    const sites = await scanAppCode(dir);
    assert.equal(sites.length, 0, "the charset [a-zA-Z0-9_.]+ doesn't allow $/{/} — interpolated names silently produce zero findings");
  });
});

test("two .from() chains close together are each attributed correctly, not merged", async () => {
  await withFixture(
    { "a.ts": `const p = await supabase.from('posts').select('id'); const c = await supabase.from('comments').select('id');` },
    async (dir) => {
      const sites = await scanAppCode(dir);
      assert.equal(sites.length, 2);
      assert.equal(sites[0].table, "posts");
      assert.equal(sites[0].action, "select");
      assert.equal(sites[1].table, "comments");
      assert.equal(sites[1].action, "select");
    }
  );
});

test("nested chain (.from() as a Promise.all() array element) is attributed correctly", async () => {
  await withFixture(
    { "a.ts": `Promise.all([supabase.from('posts').select('*'), supabase.from('users').update({}).eq('id', 1)]);` },
    async (dir) => {
      const sites = await scanAppCode(dir);
      assert.equal(sites.length, 2);
      assert.deepEqual(
        sites.map((s) => [s.table, s.action]),
        [
          ["posts", "select"],
          ["users", "update"],
        ]
      );
    }
  );
});

test("multi-line chain with .eq()/.order()/.limit() between .from() and the CRUD method is still found", async () => {
  await withFixture(
    {
      "a.ts": `
        await supabase
          .from('posts')
          .update({ title })
          .eq('id', id)
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1);
      `,
    },
    async (dir) => {
      const sites = await scanAppCode(dir);
      assert.equal(sites.length, 1);
      assert.equal(sites[0].table, "posts");
      assert.equal(sites[0].action, "update");
    }
  );
});

test("gap: a CRUD method beyond the 300-char lookahead window is missed", async () => {
  const padding = "x".repeat(320);
  await withFixture(
    { "a.ts": `supabase.from('posts') /* ${padding} */ .select('*');` },
    async (dir) => {
      const sites = await scanAppCode(dir);
      assert.equal(sites.length, 0, "the CRUD method sits past CHAIN_LOOKAHEAD_CHARS — a long enough gap silently produces zero findings, not a warning");
    }
  );
});

test("upsert() is treated as touching both insert and update", async () => {
  await withFixture({ "a.ts": `supabase.from('posts').upsert({ id: 1 });` }, async (dir) => {
    const sites = await scanAppCode(dir);
    const actions = sites.map((s) => s.action).sort();
    assert.deepEqual(actions, ["insert", "update"]);
  });
});

test("ignores node_modules, dist, and test files", async () => {
  await withFixture(
    {
      "real.ts": `supabase.from('posts').select('*');`,
      "real.test.ts": `supabase.from('ignored_test_file').select('*');`,
    },
    async (dir) => {
      const sites = await scanAppCode(dir);
      assert.equal(sites.length, 1);
      assert.equal(sites[0].table, "posts");
    }
  );
});

test(".from() with no recognized CRUD method nearby is skipped", async () => {
  await withFixture({ "a.ts": `const ref = supabase.from('posts'); doSomethingElse(ref);` }, async (dir) => {
    const sites = await scanAppCode(dir);
    assert.equal(sites.length, 0);
  });
});
