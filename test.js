// 集成测试：启动真实服务进程，实测单位边界、重叠缺口、拼接拆分、级联失效、
// 逐级确认、并发互斥、故障回滚、重启保留与旧入口兼容。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { hydrateState, wouldCreateCycle } from "./depth-lib.js";

const root = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("  ✗ " + name + " — " + error.message);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("  ✗ " + name + " — " + error.message);
  }
}

async function startServer(extraEnv = {}, dataDir) {
  const dir = dataDir || mkdtempSync(join(tmpdir(), "depth-it-"));
  const child = spawn(process.execPath, [join(root, "server.js")], {
    env: { ...process.env, PORT: "0", DATA_DIR: dir, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("服务启动超时\n" + buf)), 15000);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const m = buf.match(/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on("data", (chunk) => { buf += chunk; });
    child.on("exit", (code) => reject(new Error(`服务提前退出 code=${code}\n${buf}`)));
  });
  return { child, dir, base: `http://localhost:${port}` };
}
function stopServer(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 3000);
  });
}
async function api(base, method, path, payload) {
  const res = await fetch(base + path, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const get = (base, path) => api(base, "GET", path);
const post = (base, path, payload) => api(base, "POST", path, payload || {});

async function stateOf(base) {
  const res = await get(base, "/api/depth/state");
  assert.equal(res.status, 200);
  return res.data;
}
function intervalOf(state, id) {
  for (const h of state.boreholes) {
    const found = h.intervals.find((it) => it.id === id);
    if (found) return found;
  }
  return null;
}
function holeOf(state, id) {
  return state.boreholes.find((h) => h.id === id);
}

// ---------- 单元级：循环引用检测 ----------
console.log("\n[单元] 循环引用检测");
{
  const state = hydrateState({
    boreholes: [{ id: "H1", name: "H1", unit: "m", createdAt: "t", createdBy: "t" }],
    intervals: [
      { id: "A", boreholeId: "H1", fromTicks: 0, toTicks: 10, status: "valid", version: 1, kind: "source", note: "", createdAt: "t", createdBy: "t", parents: [], children: [], supersededBy: null, correctionOf: null, confirmedAt: null, confirmedBy: null },
      { id: "B", boreholeId: "H1", fromTicks: 0, toTicks: 5, status: "valid", version: 1, kind: "split", note: "", createdAt: "t", createdBy: "t", parents: ["A"], children: [], supersededBy: null, correctionOf: null, confirmedAt: null, confirmedBy: null },
      { id: "C", boreholeId: "H1", fromTicks: 0, toTicks: 2, status: "valid", version: 1, kind: "split", note: "", createdAt: "t", createdBy: "t", parents: ["B"], children: [], supersededBy: null, correctionOf: null, confirmedAt: null, confirmedBy: null },
    ],
  });
  ok("链 A→B→C 中让 C 成为 A 的父级会成环，被拒绝", () => {
    assert.equal(wouldCreateCycle(state, "C", "A"), true);
  });
  ok("链 A→B→C 中让 A 成为 C 的父级不成环（仍是 DAG）", () => {
    assert.equal(wouldCreateCycle(state, "A", "C"), false);
  });
  ok("自引用直接成环", () => {
    assert.equal(wouldCreateCycle(state, "A", "A"), true);
  });
  ok("腐坏数据（成环的 parents）在重建时被拒绝", () => {
    assert.throws(() => hydrateState({
      boreholes: [{ id: "H1", name: "H1", unit: "m", createdAt: "t", createdBy: "t" }],
      intervals: [
        { id: "X", boreholeId: "H1", fromTicks: 0, toTicks: 5, status: "valid", version: 1, kind: "source", note: "", createdAt: "t", createdBy: "t", parents: ["Y"], children: [], supersededBy: null, correctionOf: null, confirmedAt: null, confirmedBy: null },
        { id: "Y", boreholeId: "H1", fromTicks: 0, toTicks: 5, status: "valid", version: 1, kind: "source", note: "", createdAt: "t", createdBy: "t", parents: ["X"], children: [], supersededBy: null, correctionOf: null, confirmedAt: null, confirmedBy: null },
      ],
    }), /循环引用/);
  });
}

// ---------- 主服务实例 ----------
console.log("\n[启动] 主测试实例");
const main = await startServer();
console.log("  实例端口 " + main.base);

console.log("\n[单位与精度边界]");
await okAsync("登记米制钻孔", async () => {
  const res = await post(main.base, "/api/depth/boreholes", { id: "ZK-A", name: "甲孔", unit: "m" });
  assert.equal(res.status, 201, JSON.stringify(res.data));
});
await okAsync("登记厘米制钻孔", async () => {
  const res = await post(main.base, "/api/depth/boreholes", { id: "ZK-B", name: "乙孔", unit: "cm" });
  assert.equal(res.status, 201);
});
await okAsync("非法单位被拒绝", async () => {
  const res = await post(main.base, "/api/depth/boreholes", { id: "ZK-X", unit: "mm" });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "invalid_unit");
});
await okAsync("重复钻孔编号被拒绝", async () => {
  const res = await post(main.base, "/api/depth/boreholes", { id: "ZK-A", unit: "m" });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "duplicate_borehole");
});
await okAsync("米制 4 位小数（0.1mm 精度边界内）可登记", async () => {
  const res = await post(main.base, "/api/depth/intervals", { id: "A", boreholeId: "ZK-A", from: 0, to: 10.0001 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.to, 10.0001);
});
await okAsync("米制第 5 位小数超出统一精度，被拒绝", async () => {
  const res = await post(main.base, "/api/depth/intervals", { id: "A-BAD", boreholeId: "ZK-A", from: 0, to: 10.00001 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "precision_loss");
});
await okAsync("厘米制 2 位小数可登记", async () => {
  const res = await post(main.base, "/api/depth/intervals", { id: "D", boreholeId: "ZK-B", from: 0, to: 500.55 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
});
await okAsync("厘米制第 3 位小数超出统一精度，被拒绝", async () => {
  const res = await post(main.base, "/api/depth/intervals", { id: "D-BAD", boreholeId: "ZK-B", from: 0, to: 100.555 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "precision_loss");
});
await okAsync("起点必须小于终点（半开区间）", async () => {
  const r1 = await post(main.base, "/api/depth/intervals", { id: "E1", boreholeId: "ZK-A", from: 5, to: 5 });
  assert.equal(r1.status, 400);
  assert.equal(r1.data.error, "invalid_interval");
  const r2 = await post(main.base, "/api/depth/intervals", { id: "E2", boreholeId: "ZK-A", from: 9, to: 5 });
  assert.equal(r2.status, 400);
});

console.log("\n[重叠与缺口识别]");
await okAsync("登记相邻与重叠区间", async () => {
  assert.equal((await post(main.base, "/api/depth/intervals", { id: "B", boreholeId: "ZK-A", from: 10.0001, to: 20 })).status, 201);
  assert.equal((await post(main.base, "/api/depth/intervals", { id: "C", boreholeId: "ZK-A", from: 15, to: 25 })).status, 201);
  assert.equal((await post(main.base, "/api/depth/intervals", { id: "E", boreholeId: "ZK-B", from: 800, to: 1000 })).status, 201);
});
await okAsync("重叠被识别（B∩C = [15,20)），相邻不算重叠", async () => {
  const state = await stateOf(main.base);
  const hole = holeOf(state, "ZK-A");
  assert.equal(hole.overlaps.length, 1, JSON.stringify(hole.overlaps));
  assert.equal(hole.overlaps[0].a, "B");
  assert.equal(hole.overlaps[0].b, "C");
  assert.equal(hole.overlaps[0].range, "15.0000m ~ 20.0000m");
});
await okAsync("缺口被识别（ZK-B 的 [500.55,800)cm）", async () => {
  const state = await stateOf(main.base);
  const hole = holeOf(state, "ZK-B");
  assert.equal(hole.gaps.length, 1, JSON.stringify(hole.gaps));
  assert.equal(hole.gaps[0].range, "500.55cm ~ 800.00cm");
  assert.equal(hole.overlaps.length, 0);
});

console.log("\n[拼接规则]");
await okAsync("同孔相邻区间拼接成功（A+B，A.to===B.from）", async () => {
  const res = await post(main.base, "/api/depth/splice", { id: "AB", sourceIds: ["A", "B"] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.from, 0);
  assert.equal(res.data.to, 20);
  assert.deepEqual(res.data.parents.sort(), ["A", "B"]);
});
await okAsync("不相邻区间拼接失败", async () => {
  const res = await post(main.base, "/api/depth/splice", { id: "AC", sourceIds: ["A", "C"] });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "not_adjacent");
});
await okAsync("跨孔拼接失败", async () => {
  const res = await post(main.base, "/api/depth/splice", { id: "AD", sourceIds: ["A", "D"] });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "cross_hole_splice");
});
await okAsync("来源去重与数量校验", async () => {
  assert.equal((await post(main.base, "/api/depth/splice", { id: "X1", sourceIds: ["A", "A"] })).data.error, "invalid_input");
  assert.equal((await post(main.base, "/api/depth/splice", { id: "X2", sourceIds: ["A"] })).data.error, "invalid_input");
});

console.log("\n[拆分规则]");
await okAsync("多切点拆分：AB 按 5、12 拆为 3 段", async () => {
  const res = await post(main.base, "/api/depth/split", { parentId: "AB", expectedVersion: 1, cuts: [5, 12], childIds: ["S1", "S2", "S3"] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.deepEqual(res.data.map((c) => [c.from, c.to]), [[0, 5], [5, 12], [12, 20]]);
  const state = await stateOf(main.base);
  assert.equal(intervalOf(state, "AB").version, 2, "拆分后父版本号递增");
});
await okAsync("切点越界（含端点）被拒绝", async () => {
  assert.equal((await post(main.base, "/api/depth/split", { parentId: "AB", expectedVersion: 2, cuts: [20], childIds: ["Q1", "Q2"] })).data.error, "cut_out_of_bounds");
  assert.equal((await post(main.base, "/api/depth/split", { parentId: "AB", expectedVersion: 2, cuts: [0], childIds: ["Q1", "Q2"] })).data.error, "cut_out_of_bounds");
  assert.equal((await post(main.base, "/api/depth/split", { parentId: "AB", expectedVersion: 2, cuts: [30], childIds: ["Q1", "Q2"] })).data.error, "cut_out_of_bounds");
});
await okAsync("子区间编号数量必须等于切点数+1", async () => {
  const res = await post(main.base, "/api/depth/split", { parentId: "AB", expectedVersion: 2, cuts: [5], childIds: ["ONLY"] });
  assert.equal(res.data.error, "invalid_input");
});
await okAsync("拆分失败不留任何子区间（原子性）", async () => {
  const before = (await stateOf(main.base)).boreholes.flatMap((h) => h.intervals).length;
  const res = await post(main.base, "/api/depth/split", { parentId: "AB", expectedVersion: 2, cuts: [7], childIds: ["P1", "S1"] });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "duplicate_interval");
  const after = (await stateOf(main.base)).boreholes.flatMap((h) => h.intervals).length;
  assert.equal(after, before, "失败的拆分不得新增任何区间");
  assert.equal(intervalOf(await stateOf(main.base), "P1"), null);
});

console.log("\n[派生切片边界]");
await okAsync("派生切片落在父区间内：成功", async () => {
  const res = await post(main.base, "/api/depth/derive", { id: "SL1", parentId: "S2", expectedVersion: 1, from: 6, to: 10 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.kind, "slice");
});
await okAsync("派生切片越出父区间右界：失败", async () => {
  const res = await post(main.base, "/api/depth/derive", { id: "SL2", parentId: "S2", expectedVersion: 2, from: 11, to: 13 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "slice_out_of_bounds");
});
await okAsync("派生切片越出父区间左界：失败", async () => {
  const res = await post(main.base, "/api/depth/derive", { id: "SL3", parentId: "S2", expectedVersion: 2, from: 4, to: 8 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "slice_out_of_bounds");
});
await okAsync("切片自身必须 起点<终点", async () => {
  const res = await post(main.base, "/api/depth/derive", { id: "SL4", parentId: "S2", expectedVersion: 2, from: 9, to: 9 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "invalid_interval");
});

console.log("\n[更正级联：保留旧版、后代待复核、逐级确认]");
let affectedSnapshot;
await okAsync("更正 AB → AB2：旧版保留，全部后代标为待复核", async () => {
  const res = await post(main.base, "/api/depth/correct", { id: "AB2", targetId: "AB", expectedVersion: 2, from: 0, to: 21 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.superseded, "AB");
  assert.equal(res.data.correction.version, 3);
  affectedSnapshot = res.data.affected.sort();
  assert.deepEqual(affectedSnapshot, ["S1", "S2", "S3", "SL1"].sort(), "全部后代都应被标记");
  const state = await stateOf(main.base);
  assert.equal(intervalOf(state, "AB").status, "superseded");
  assert.equal(intervalOf(state, "AB").supersededBy, "AB2");
  assert.equal(intervalOf(state, "AB2").status, "valid");
  for (const id of ["S1", "S2", "S3", "SL1"]) assert.equal(intervalOf(state, id).status, "pending", id + " 应为待复核");
});
await okAsync("待复核区间不可派生（越级使用被阻断）", async () => {
  const res = await post(main.base, "/api/depth/derive", { id: "SL9", parentId: "S2", expectedVersion: 2, from: 6, to: 8 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "interval_not_valid");
});
await okAsync("旧版不可再派生", async () => {
  const res = await post(main.base, "/api/depth/derive", { id: "SL8", parentId: "AB", expectedVersion: 2, from: 1, to: 2 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "interval_not_valid");
});
await okAsync("越级确认孙级被拒绝（父级仍待复核）", async () => {
  const res = await post(main.base, "/api/depth/confirm", { id: "SL1" });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "parents_not_confirmed");
  assert.deepEqual(res.data.details.blocking, ["S2"]);
});
await okAsync("逐级确认：先父后子，全部恢复有效", async () => {
  for (const id of ["S1", "S2", "S3"]) {
    const res = await post(main.base, "/api/depth/confirm", { id });
    assert.equal(res.status, 200, id + ": " + JSON.stringify(res.data));
  }
  const res = await post(main.base, "/api/depth/confirm", { id: "SL1" });
  assert.equal(res.status, 200);
  const state = await stateOf(main.base);
  for (const id of ["S1", "S2", "S3", "SL1"]) assert.equal(intervalOf(state, id).status, "valid", id);
});
await okAsync("确认后区间恢复可派生", async () => {
  const res = await post(main.base, "/api/depth/derive", { id: "SL5", parentId: "S2", expectedVersion: 2, from: 6, to: 7 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
});
await okAsync("重复确认与对旧版更正均被拒绝", async () => {
  assert.equal((await post(main.base, "/api/depth/confirm", { id: "S1" })).data.error, "not_pending");
  assert.equal((await post(main.base, "/api/depth/correct", { id: "AB3", targetId: "AB", expectedVersion: 2, from: 0, to: 22 })).data.error, "already_superseded");
});

console.log("\n[来源链]");
await okAsync("切片 SL1 的完整来源链：A、B → AB（旧版）→ AB2（更正）→ S2 → SL1", async () => {
  const res = await get(main.base, "/api/depth/intervals/SL1/chain");
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.data.nodes.map((n) => [n.id, n]));
  assert.deepEqual(Object.keys(byId).sort(), ["A", "AB", "AB2", "B", "S2", "SL1"]);
  assert.equal(byId.A.depth, 0);
  assert.equal(byId.B.depth, 0);
  assert.equal(byId.AB.depth, 1);
  assert.equal(byId.AB2.depth, 2);
  assert.equal(byId.S2.depth, 3);
  assert.equal(byId.SL1.depth, 4);
  assert.equal(byId.AB.status, "superseded", "链中保留旧版节点");
  assert.equal(byId.AB2.kind, "correction");
  const edgeSet = new Set(res.data.edges.map((e) => e.from + ">" + e.to));
  for (const e of ["A>AB", "B>AB", "AB>AB2", "AB2>S2", "S2>SL1"]) assert.ok(edgeSet.has(e), "缺少边 " + e);
});
await okAsync("不存在的区间来源链返回 404", async () => {
  const res = await get(main.base, "/api/depth/intervals/NOPE/chain");
  assert.equal(res.status, 404);
});

console.log("\n[并发互斥：同一版本仅成功一次]");
await okAsync("并发拆分同一版本：5 个请求恰好 1 个成功", async () => {
  assert.equal((await post(main.base, "/api/depth/intervals", { id: "CC", boreholeId: "ZK-A", from: 100, to: 200 })).status, 201);
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      post(main.base, "/api/depth/split", { parentId: "CC", expectedVersion: 1, cuts: [100 + i * 10], childIds: [`CC-${i}a`, `CC-${i}b`] })
    )
  );
  const okCount = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409 && r.data.error === "version_conflict").length;
  assert.equal(okCount, 1, "恰好一个拆分成功，实际 " + okCount);
  assert.equal(conflicts, 4, "其余四个版本冲突，实际 " + conflicts);
  const state = await stateOf(main.base);
  const cc = intervalOf(state, "CC");
  assert.equal(cc.children.length, 2, "只有成功的那次拆分留下子区间");
  assert.equal(cc.version, 2);
});
await okAsync("并发更正同一版本：3 个请求恰好 1 个成功", async () => {
  assert.equal((await post(main.base, "/api/depth/intervals", { id: "DD", boreholeId: "ZK-A", from: 300, to: 400 })).status, 201);
  const results = await Promise.all(
    [1, 2, 3].map((i) =>
      post(main.base, "/api/depth/correct", { id: `DD-v${i}`, targetId: "DD", expectedVersion: 1, from: 300, to: 400 + i })
    )
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  const state = await stateOf(main.base);
  const dd = intervalOf(state, "DD");
  assert.equal(dd.status, "superseded");
  const corrections = state.boreholes.flatMap((h) => h.intervals).filter((it) => it.correctionOf === "DD");
  assert.equal(corrections.length, 1, "只产生一个更正版本");
});
await okAsync("并发派生同一父区间同一版本：恰好 1 个成功", async () => {
  const state = await stateOf(main.base);
  const cc = intervalOf(state, "CC");
  const childId = cc.children[0];
  const child = intervalOf(state, childId);
  const mid = (child.from + child.to) / 2;
  const results = await Promise.all(
    [1, 2, 3, 4].map((i) =>
      post(main.base, "/api/depth/derive", { id: `CCS-${i}`, parentId: childId, expectedVersion: child.version, from: child.from, to: mid })
    )
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
});

console.log("\n[重启保留]");
await okAsync("更正后未确认即重启：数据与待复核状态完整保留", async () => {
  await post(main.base, "/api/depth/correct", { id: "AB3", targetId: "AB2", expectedVersion: 3, from: 0, to: 21.5 });
  const before = await stateOf(main.base);
  assert.equal(intervalOf(before, "S2").status, "pending");
  await stopServer(main.child);
  const restarted = await startServer({}, main.dir);
  main.child = restarted.child;
  main.base = restarted.base;
  const after = await stateOf(main.base);
  const ids = (s) => s.boreholes.flatMap((h) => h.intervals.map((it) => it.id)).sort();
  assert.deepEqual(ids(after), ids(before), "重启后区间集合一致");
  assert.equal(intervalOf(after, "AB2").status, "superseded");
  assert.equal(intervalOf(after, "AB3").status, "valid");
  for (const id of ["S1", "S2", "S3", "SL1", "SL5"]) {
    assert.equal(intervalOf(after, id).status, "pending", id + " 重启后仍待复核");
  }
  const chain = await get(main.base, "/api/depth/intervals/SL1/chain");
  assert.equal(chain.status, 200);
  assert.ok(chain.data.nodes.some((n) => n.id === "AB"), "重启后来源链仍可追溯旧版");
});
await okAsync("重启后逐级确认恢复正常流程", async () => {
  for (const id of ["S1", "S2", "S3"]) assert.equal((await post(main.base, "/api/depth/confirm", { id })).status, 200);
  assert.equal((await post(main.base, "/api/depth/confirm", { id: "SL1" })).status, 200);
  assert.equal((await post(main.base, "/api/depth/confirm", { id: "SL5" })).status, 200);
  const state = await stateOf(main.base);
  assert.equal(intervalOf(state, "SL1").status, "valid");
});

console.log("\n[回归] 更正后越界切片的复核拦截");
await okAsync("准备：父区间 [0,10)m 派生切片 [8,10)", async () => {
  assert.equal((await post(main.base, "/api/depth/boreholes", { id: "ZK-M", name: "越界孔", unit: "m" })).status, 201);
  assert.equal((await post(main.base, "/api/depth/intervals", { id: "M-P", boreholeId: "ZK-M", from: 0, to: 10 })).status, 201);
  assert.equal((await post(main.base, "/api/depth/derive", { id: "M-S", parentId: "M-P", expectedVersion: 1, from: 8, to: 10 })).status, 201);
});
await okAsync("父区间更正为 [0,5)：切片转待复核且视图标记越界", async () => {
  const p = intervalOf(await stateOf(main.base), "M-P");
  const res = await post(main.base, "/api/depth/correct", { id: "M-P2", targetId: "M-P", expectedVersion: p.version, from: 0, to: 5 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.deepEqual(res.data.affected, ["M-S"]);
  const s = intervalOf(await stateOf(main.base), "M-S");
  assert.equal(s.status, "pending");
  assert.equal(s.outOfBounds, true, "越界切片应在状态视图中标记 outOfBounds");
});
await okAsync("越界切片确认被拒绝，且区间与关系零变化", async () => {
  const before = JSON.stringify(await stateOf(main.base));
  const res = await post(main.base, "/api/depth/confirm", { id: "M-S" });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "out_of_bounds");
  assert.equal(JSON.stringify(await stateOf(main.base)), before, "失败的确认不得改变任何区间与关系");
  assert.equal(intervalOf(await stateOf(main.base), "M-S").status, "pending", "越界切片必须保持待复核");
});
await okAsync("越界切片不能继续派生", async () => {
  const res = await post(main.base, "/api/depth/derive", { id: "M-S-X", parentId: "M-S", expectedVersion: 1, from: 8, to: 9 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "interval_not_valid");
});
await okAsync("切片更正到父区间外：创建即失败且无残留", async () => {
  const before = JSON.stringify(await stateOf(main.base));
  const res = await post(main.base, "/api/depth/correct", { id: "M-S2", targetId: "M-S", expectedVersion: 1, from: 6, to: 8 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "out_of_bounds");
  assert.equal(JSON.stringify(await stateOf(main.base)), before, "失败的更正不得产生新区间或关系");
  assert.equal(intervalOf(await stateOf(main.base), "M-S2"), null);
});
await okAsync("切片更正到有效父区间内：新版本仍为待复核", async () => {
  const res = await post(main.base, "/api/depth/correct", { id: "M-S2", targetId: "M-S", expectedVersion: 1, from: 3, to: 5 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const state = await stateOf(main.base);
  assert.equal(intervalOf(state, "M-S").status, "superseded");
  const s2 = intervalOf(state, "M-S2");
  assert.equal(s2.status, "pending", "更正后的切片仍须按依赖顺序复核");
  assert.equal(s2.outOfBounds, false);
});
await okAsync("按依赖顺序复核：父有效且落入包络后确认成功", async () => {
  const res = await post(main.base, "/api/depth/confirm", { id: "M-S2" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, "valid");
});
await okAsync("边界相等：与父区间完全重合的切片可确认", async () => {
  const p2 = intervalOf(await stateOf(main.base), "M-P2");
  assert.equal((await post(main.base, "/api/depth/derive", { id: "M-EQ", parentId: "M-P2", expectedVersion: p2.version, from: 0, to: 5 })).status, 201);
  const p2b = intervalOf(await stateOf(main.base), "M-P2");
  assert.equal((await post(main.base, "/api/depth/correct", { id: "M-P3", targetId: "M-P2", expectedVersion: p2b.version, from: 0, to: 5 })).status, 201);
  assert.equal(intervalOf(await stateOf(main.base), "M-EQ").status, "pending");
  const conf = await post(main.base, "/api/depth/confirm", { id: "M-EQ" });
  assert.equal(conf.status, 200, "边界相等 [0,5)⊆[0,5) 应确认成功: " + JSON.stringify(conf.data));
});
await okAsync("边界相等：起点贴着父区间右端点即为越界", async () => {
  const p3 = intervalOf(await stateOf(main.base), "M-P3");
  const res = await post(main.base, "/api/depth/derive", { id: "M-OUT", parentId: "M-P3", expectedVersion: p3.version, from: 5, to: 6 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "slice_out_of_bounds");
});
await okAsync("多级后代：中间级越界逐级拦截，孙级按依赖顺序复核", async () => {
  const p3 = intervalOf(await stateOf(main.base), "M-P3");
  assert.equal((await post(main.base, "/api/depth/split", { parentId: "M-P3", expectedVersion: p3.version, cuts: [2], childIds: ["M-C1", "M-C2"] })).status, 201);
  const c2 = intervalOf(await stateOf(main.base), "M-C2");
  assert.equal((await post(main.base, "/api/depth/derive", { id: "M-D", parentId: "M-C2", expectedVersion: c2.version, from: 3, to: 4 })).status, 201);
  const p3b = intervalOf(await stateOf(main.base), "M-P3");
  const cor = await post(main.base, "/api/depth/correct", { id: "M-P4", targetId: "M-P3", expectedVersion: p3b.version, from: 0, to: 3 });
  assert.equal(cor.status, 201);
  assert.deepEqual(cor.data.affected.sort(), ["M-C1", "M-C2", "M-D", "M-EQ", "M-S2"].sort(), "全部后代（含旧链路上的）都应待复核");
  // 中间级 M-C2 [2,5) 越出 M-P4 [0,3)
  const confC2 = await post(main.base, "/api/depth/confirm", { id: "M-C2" });
  assert.equal(confC2.data.error, "out_of_bounds");
  // 孙级 M-D 先被依赖顺序拦截
  const confD = await post(main.base, "/api/depth/confirm", { id: "M-D" });
  assert.equal(confD.data.error, "parents_not_confirmed");
  assert.deepEqual(confD.data.details.blocking, ["M-C2"]);
  // 中间级更正到父区间内 → 仍待复核 → 确认恢复
  const c2v = intervalOf(await stateOf(main.base), "M-C2");
  assert.equal((await post(main.base, "/api/depth/correct", { id: "M-C2v2", targetId: "M-C2", expectedVersion: c2v.version, from: 2, to: 3 })).status, 201);
  assert.equal(intervalOf(await stateOf(main.base), "M-C2v2").status, "pending");
  assert.equal((await post(main.base, "/api/depth/confirm", { id: "M-C2v2" })).status, 200);
  // 孙级 M-D [3,4) 仍越出 M-C2v2 [2,3)：确认被拒
  const confD2 = await post(main.base, "/api/depth/confirm", { id: "M-D" });
  assert.equal(confD2.data.error, "out_of_bounds");
  // 孙级更正到 [2,3) 内（边界相等）→ 待复核 → 确认恢复
  const dv = intervalOf(await stateOf(main.base), "M-D");
  assert.equal((await post(main.base, "/api/depth/correct", { id: "M-D2", targetId: "M-D", expectedVersion: dv.version, from: 2, to: 3 })).status, 201);
  assert.equal((await post(main.base, "/api/depth/confirm", { id: "M-D2" })).status, 200);
});
await okAsync("连续更正：约束始终按最新有效版本计算", async () => {
  const p4 = intervalOf(await stateOf(main.base), "M-P4");
  assert.equal((await post(main.base, "/api/depth/correct", { id: "M-P5", targetId: "M-P4", expectedVersion: p4.version, from: 0, to: 2 })).status, 201);
  const state = await stateOf(main.base);
  assert.equal(intervalOf(state, "M-C2v2").status, "pending", "再次更正后中间级重新待复核");
  assert.equal(intervalOf(state, "M-C2v2").outOfBounds, true);
  assert.equal((await post(main.base, "/api/depth/confirm", { id: "M-C2v2" })).data.error, "out_of_bounds");
});
await okAsync("厘米单位：同样的越界拦截与更正复核流程", async () => {
  assert.equal((await post(main.base, "/api/depth/boreholes", { id: "ZK-CM", name: "厘米孔", unit: "cm" })).status, 201);
  assert.equal((await post(main.base, "/api/depth/intervals", { id: "CM-P", boreholeId: "ZK-CM", from: 0, to: 1000 })).status, 201);
  assert.equal((await post(main.base, "/api/depth/derive", { id: "CM-S", parentId: "CM-P", expectedVersion: 1, from: 800, to: 1000 })).status, 201);
  const p = intervalOf(await stateOf(main.base), "CM-P");
  assert.equal((await post(main.base, "/api/depth/correct", { id: "CM-P2", targetId: "CM-P", expectedVersion: p.version, from: 0, to: 500 })).status, 201);
  const s = intervalOf(await stateOf(main.base), "CM-S");
  assert.equal(s.status, "pending");
  assert.equal(s.outOfBounds, true);
  assert.equal((await post(main.base, "/api/depth/confirm", { id: "CM-S" })).data.error, "out_of_bounds");
  const s2 = intervalOf(await stateOf(main.base), "CM-S");
  assert.equal((await post(main.base, "/api/depth/correct", { id: "CM-S2", targetId: "CM-S", expectedVersion: s2.version, from: 400.55, to: 500 })).status, 201);
  assert.equal((await post(main.base, "/api/depth/confirm", { id: "CM-S2" })).status, 200);
});
await okAsync("并发确认越界切片：全部失败且状态不变", async () => {
  const before = JSON.stringify(await stateOf(main.base));
  const results = await Promise.all([1, 2, 3].map(() => post(main.base, "/api/depth/confirm", { id: "M-C2v2" })));
  assert.ok(results.every((r) => r.status === 400 && r.data.error === "out_of_bounds"), JSON.stringify(results.map((r) => r.status)));
  assert.equal(JSON.stringify(await stateOf(main.base)), before);
});
let sliceWinner;
await okAsync("并发更正同一待复核切片：仅成功一次，新版仍待复核", async () => {
  const s = intervalOf(await stateOf(main.base), "M-C2v2");
  const results = await Promise.all([
    post(main.base, "/api/depth/correct", { id: "M-C2v3a", targetId: "M-C2v2", expectedVersion: s.version, from: 0, to: 2 }),
    post(main.base, "/api/depth/correct", { id: "M-C2v3b", targetId: "M-C2v2", expectedVersion: s.version, from: 0, to: 2 }),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  sliceWinner = results.find((r) => r.status === 201).data.correction.id;
  assert.equal(intervalOf(await stateOf(main.base), sliceWinner).status, "pending");
  assert.equal((await post(main.base, "/api/depth/confirm", { id: sliceWinner })).status, 200);
});
await okAsync("重启后越界约束仍成立", async () => {
  const p5 = intervalOf(await stateOf(main.base), "M-P5");
  assert.equal((await post(main.base, "/api/depth/correct", { id: "M-P6", targetId: "M-P5", expectedVersion: p5.version, from: 0, to: 1 })).status, 201);
  assert.equal(intervalOf(await stateOf(main.base), sliceWinner).status, "pending", "再次级联后切片重新待复核");
  await stopServer(main.child);
  const restarted = await startServer({}, main.dir);
  main.child = restarted.child;
  main.base = restarted.base;
  const state = await stateOf(main.base);
  const w = intervalOf(state, sliceWinner);
  assert.equal(w.status, "pending", "重启后仍待复核");
  assert.equal(w.outOfBounds, true, "重启后仍标记越界");
  const res = await post(main.base, "/api/depth/confirm", { id: sliceWinner });
  assert.equal(res.data.error, "out_of_bounds", "重启后越界确认仍被拒绝");
});
await okAsync("页面与接口结果一致：状态接口标记越界，页面渲染越界标识", async () => {
  const state = await stateOf(main.base);
  assert.equal(intervalOf(state, sliceWinner).outOfBounds, true);
  const res = await fetch(main.base + "/depth");
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes("越界"), "页面应包含越界标识");
});
await okAsync("来源链保留全部更正轨迹", async () => {
  const res = await get(main.base, `/api/depth/intervals/${sliceWinner}/chain`);
  assert.equal(res.status, 200);
  const ids = res.data.nodes.map((n) => n.id);
  for (const id of ["M-P", "M-P2", "M-P3", "M-P4", "M-P5", "M-P6", "M-C2", "M-C2v2", sliceWinner]) {
    assert.ok(ids.includes(id), "来源链缺少节点 " + id);
  }
});

console.log("\n[旧入口兼容]");
await okAsync("旧页面 / 可访问", async () => {
  const res = await fetch(main.base + "/");
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes("岩芯样本切片实验室"));
});
await okAsync("新页面 /depth 可访问", async () => {
  const res = await fetch(main.base + "/depth");
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes("深度区间拼接与切片溯源"));
});
await okAsync("旧 API：样本列表 / 创建 / 步骤 / 交付", async () => {
  const list = await get(main.base, "/api/samples");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data));
  const created = await post(main.base, "/api/samples", { project: "测试矿", borehole: "ZK-99", coreBox: "BX-1", depth: "1-2m", owner: "测试员", sliceId: "SL-T1", method: "无染色" });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const logged = await post(main.base, `/api/samples/${id}/slices/SL-T1/logs`, { step: "切割", note: "粗切" });
  assert.equal(logged.status, 200);
  const delivered = await post(main.base, `/api/samples/${id}/deliver`, {});
  assert.equal(delivered.status, 200);
  assert.equal(delivered.data.delivery, "已交付");
});
await stopServer(main.child);

console.log("\n[故障回滚]（独立实例，DEPTH_TEST_HOOK=1 模拟落盘失败）");
const failing = await startServer({ DEPTH_TEST_HOOK: "1" });
await okAsync("准备数据", async () => {
  assert.equal((await post(failing.base, "/api/depth/boreholes", { id: "ZK-F", unit: "m" })).status, 201);
  assert.equal((await post(failing.base, "/api/depth/intervals", { id: "F1", boreholeId: "ZK-F", from: 0, to: 100 })).status, 201);
});
await okAsync("拆分类落盘失败：整体回滚，不留部分区间或关系", async () => {
  const res = await post(failing.base, "/api/depth/split", { parentId: "F1", expectedVersion: 1, cuts: [50], childIds: ["F1-a", "F1-b"], __failSave: true });
  assert.equal(res.status, 500);
  const state = await stateOf(failing.base);
  const f1 = intervalOf(state, "F1");
  assert.equal(f1.version, 1, "版本号回滚");
  assert.deepEqual(f1.children, [], "不留子区间引用");
  assert.equal(intervalOf(state, "F1-a"), null);
  assert.equal(intervalOf(state, "F1-b"), null);
});
await okAsync("更正类落盘失败：目标不失效、无待复核残留", async () => {
  const res = await post(failing.base, "/api/depth/correct", { id: "F1-v2", targetId: "F1", expectedVersion: 1, from: 0, to: 120, __failSave: true });
  assert.equal(res.status, 500);
  const state = await stateOf(failing.base);
  const f1 = intervalOf(state, "F1");
  assert.equal(f1.status, "valid", "目标状态回滚为有效");
  assert.equal(f1.supersededBy, null);
  assert.equal(intervalOf(state, "F1-v2"), null, "更正版本不留存");
});
await okAsync("故障后正常操作仍可用（回滚不破坏后续写入）", async () => {
  const res = await post(failing.base, "/api/depth/split", { parentId: "F1", expectedVersion: 1, cuts: [50], childIds: ["F1-a", "F1-b"] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const state = await stateOf(failing.base);
  assert.equal(intervalOf(state, "F1").children.length, 2);
});
await okAsync("故障实例重启后无失败残留", async () => {
  await stopServer(failing.child);
  const restarted = await startServer({ DEPTH_TEST_HOOK: "1" }, failing.dir);
  const state = await stateOf(restarted.base);
  assert.equal(intervalOf(state, "F1").children.length, 2);
  assert.equal(intervalOf(state, "F1-v2"), null, "失败的更正未落盘");
  await stopServer(restarted.child);
});

rmSync(main.dir, { recursive: true, force: true });
rmSync(failing.dir, { recursive: true, force: true });

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log("  失败: " + f.name + "\n    " + f.error.stack.split("\n").slice(0, 3).join("\n    "));
  process.exit(1);
}
console.log("全部集成测试通过。");
