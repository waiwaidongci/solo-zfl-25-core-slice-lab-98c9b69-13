import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DomainError,
  STATUS,
  UNITS,
  confirmInterval,
  correctInterval,
  createBorehole,
  createInterval,
  deriveSlice,
  findGaps,
  findOverlaps,
  formatTicks,
  fromTicks,
  hydrateState,
  provenanceChain,
  serializeState,
  spliceIntervals,
  splitInterval,
} from "./depth-lib.js";
import { DepthStore } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "data");
const dbPath = join(dataDir, "core-slices.json");
const depthPath = join(dataDir, "depth-intervals.json");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

// ================= 深度区间拼接与切片溯源模块 =================

const depthStore = new DepthStore(depthPath);
await depthStore.load();

// 串行写队列：所有变更逐个执行、天然互斥；配合版本号校验，并发操作同一版本仅成功一次。
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const run = writeQueue.then(fn);
  writeQueue = run.catch(() => {});
  return run;
}

// 任一变更失败：内存回滚到变更前快照，不落盘、不留部分区间或关系。
async function mutateDepth(mutator, failSave) {
  return enqueueWrite(async () => {
    const snapshot = serializeState(depthStore.state);
    try {
      const result = mutator(depthStore.state);
      if (process.env.DEPTH_TEST_HOOK === "1" && failSave) {
        throw new Error("injected_save_failure");
      }
      await depthStore.save();
      return result;
    } catch (error) {
      depthStore.state = hydrateState(snapshot);
      throw error;
    }
  });
}

const ctxOf = (req, input) => ({
  now: () => new Date().toISOString(),
  actor: (input && input.actor) || req.headers["x-actor"] || "匿名",
});

function intervalView(state, it) {
  const hole = state.boreholes.get(it.boreholeId);
  const unit = hole ? hole.unit : "m";
  return {
    id: it.id,
    boreholeId: it.boreholeId,
    unit,
    from: fromTicks(it.fromTicks, unit),
    to: fromTicks(it.toTicks, unit),
    range: formatTicks(it.fromTicks, unit) + " ~ " + formatTicks(it.toTicks, unit),
    status: it.status,
    version: it.version,
    kind: it.kind,
    note: it.note,
    parents: it.parents,
    children: it.children,
    supersededBy: it.supersededBy,
    correctionOf: it.correctionOf,
    createdAt: it.createdAt,
    createdBy: it.createdBy,
    confirmedAt: it.confirmedAt,
    confirmedBy: it.confirmedBy,
  };
}

function depthStateView() {
  const state = depthStore.state;
  const boreholes = [...state.boreholes.values()].map((hole) => {
    const own = [...state.intervals.values()].filter((it) => it.boreholeId === hole.id);
    const valid = own.filter((it) => it.status === STATUS.VALID);
    return {
      ...hole,
      unitLabel: UNITS[hole.unit].label,
      intervals: own.map((it) => intervalView(state, it)),
      overlaps: findOverlaps(valid).map((o) => ({
        a: o.a,
        b: o.b,
        range: formatTicks(o.fromTicks, hole.unit) + " ~ " + formatTicks(o.toTicks, hole.unit),
      })),
      gaps: findGaps(valid).map((g) => ({
        range: formatTicks(g.fromTicks, hole.unit) + " ~ " + formatTicks(g.toTicks, hole.unit),
      })),
    };
  });
  return { boreholes };
}

function handleDomainError(res, error) {
  if (error instanceof DomainError) {
    const status = error.code.endsWith("_not_found") ? 404 : error.code === "version_conflict" ? 409 : 400;
    return sendJson(res, status, { error: error.code, message: error.message, details: error.details });
  }
  throw error;
}

async function handleDepthApi(req, res, url) {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/depth/state") {
    return sendJson(res, 200, depthStateView());
  }
  const chainMatch = path.match(/^\/api\/depth\/intervals\/([^/]+)\/chain$/);
  if (req.method === "GET" && chainMatch) {
    try {
      const chain = provenanceChain(depthStore.state, decodeURIComponent(chainMatch[1]));
      const state = depthStore.state;
      return sendJson(res, 200, {
        target: chain.target,
        edges: chain.edges,
        nodes: chain.nodes.map((n) => Object.assign(intervalView(state, n), { depth: n.depth })),
      });
    } catch (error) {
      return handleDomainError(res, error);
    }
  }
  if (req.method !== "POST") return sendJson(res, 404, { error: "not_found" });
  const input = await body(req);
  const failSave = process.env.DEPTH_TEST_HOOK === "1" && input.__failSave === true;
  try {
    if (path === "/api/depth/boreholes") {
      const hole = await mutateDepth((state) => createBorehole(state, input, ctxOf(req, input)), failSave);
      return sendJson(res, 201, hole);
    }
    if (path === "/api/depth/intervals") {
      const interval = await mutateDepth((state) => createInterval(state, input, ctxOf(req, input)), failSave);
      return sendJson(res, 201, intervalView(depthStore.state, interval));
    }
    if (path === "/api/depth/splice") {
      const interval = await mutateDepth((state) => spliceIntervals(state, input, ctxOf(req, input)), failSave);
      return sendJson(res, 201, intervalView(depthStore.state, interval));
    }
    if (path === "/api/depth/split") {
      const children = await mutateDepth((state) => splitInterval(state, input, ctxOf(req, input)), failSave);
      return sendJson(res, 201, children.map((c) => intervalView(depthStore.state, c)));
    }
    if (path === "/api/depth/derive") {
      const slice = await mutateDepth((state) => deriveSlice(state, input, ctxOf(req, input)), failSave);
      return sendJson(res, 201, intervalView(depthStore.state, slice));
    }
    if (path === "/api/depth/correct") {
      const result = await mutateDepth((state) => correctInterval(state, input, ctxOf(req, input)), failSave);
      return sendJson(res, 201, {
        correction: intervalView(depthStore.state, result.correction),
        superseded: result.superseded.id,
        affected: result.affected.map((d) => d.id),
      });
    }
    if (path === "/api/depth/confirm") {
      const interval = await mutateDepth((state) => confirmInterval(state, input, ctxOf(req, input)), failSave);
      return sendJson(res, 200, intervalView(depthStore.state, interval));
    }
    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    return handleDomainError(res, error);
  }
}

const depthPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>深度区间拼接与切片溯源</title>
  <style>
    :root { --bg:#f4f2ec; --panel:#fff; --ink:#26282a; --muted:#6f7268; --line:#dcd8cc; --accent:#7a5c2e; --ok:#3f7a4a; --warn:#b07d10; --bad:#b23b3b; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:14px; flex-wrap:wrap; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 10px; font-size:17px; } h3 { margin:12px 0 6px; font-size:15px; }
    main { padding:20px 28px; display:grid; gap:16px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:13px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; margin-top:10px; }
    button.ghost { background:#eee9dd; color:var(--ink); }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
    th { color:var(--muted); font-weight:600; }
    .pill { display:inline-block; border-radius:999px; padding:2px 9px; font-size:12px; font-weight:700; }
    .valid { background:#e2f0e4; color:var(--ok); } .pending { background:#f7ecc9; color:var(--warn); } .superseded { background:#f3dcdc; color:var(--bad); }
    .tag { display:inline-block; border:1px solid var(--line); border-radius:4px; padding:1px 6px; font-size:12px; color:var(--muted); margin:2px 4px 2px 0; }
    .alert { border-radius:6px; padding:8px 10px; font-size:13px; margin:6px 0; }
    .alert.bad { background:#f9e3e3; color:var(--bad); } .alert.warn { background:#fbf3d9; color:var(--warn); }
    #msg div { border-radius:6px; padding:10px 14px; font-size:14px; box-shadow:0 1px 4px rgba(0,0,0,.12); margin-bottom:10px; }
    #msg .okmsg { background:#e2f0e4; color:var(--ok); } #msg .errmsg { background:#f9e3e3; color:var(--bad); }
    .row-actions button { margin:2px 4px 2px 0; padding:4px 8px; font-size:12px; }
    .chain-node { border-left:3px solid var(--accent); background:#faf8f2; margin:6px 0; padding:8px 10px; border-radius:0 6px 6px 0; font-size:13px; }
    .muted { color:var(--muted); font-size:12px; }
    a { color:var(--accent); }
  </style>
</head>
<body>
  <header>
    <div><h1>深度区间拼接与切片溯源</h1><div class="muted">半开区间 [from, to) · 统一精度 0.1mm · 拼接 / 拆分 / 派生 / 更正 / 逐级确认 · 完整来源链</div></div>
    <div><a href="/">← 返回切片任务页</a> <button class="ghost" id="reload">刷新</button></div>
  </header>
  <main>
    <div id="msg"></div>
    <div class="cols">
      <section class="panel">
        <h2>① 登记钻孔</h2>
        <label>钻孔编号</label><input id="bh-id" placeholder="如 ZK-17">
        <label>名称</label><input id="bh-name" placeholder="如 东岭铜矿 17 号孔">
        <label>深度单位</label><select id="bh-unit"><option value="m">米 m</option><option value="cm">厘米 cm</option></select>
        <button id="bh-save">登记钻孔</button>
      </section>
      <section class="panel">
        <h2>② 登记深度区间</h2>
        <label>区间编号</label><input id="iv-id" placeholder="如 ZK17-A">
        <label>所属钻孔</label><select id="iv-hole"></select>
        <label>起点 from（含，按钻孔单位）</label><input id="iv-from" type="number" step="any">
        <label>终点 to（不含）</label><input id="iv-to" type="number" step="any">
        <button id="iv-save">登记区间</button>
      </section>
      <section class="panel">
        <h2>③ 拼接（同孔相邻）</h2>
        <label>新区间编号</label><input id="sp-id" placeholder="如 ZK17-AB">
        <label>来源区间（按住 Ctrl 多选，须同孔且首尾相接）</label>
        <select id="sp-sources" multiple size="5"></select>
        <button id="sp-save">拼接</button>
      </section>
      <section class="panel">
        <h2>④ 拆分（多个切点）</h2>
        <label>父区间</label><select id="sl-parent"></select>
        <label>切点（逗号分隔）</label><input id="sl-cuts" placeholder="如 128.5, 128.7">
        <label>子区间编号（逗号分隔，数量 = 切点数 + 1）</label><input id="sl-ids" placeholder="如 A1, A2, A3">
        <div class="muted" id="sl-ver"></div>
        <button id="sl-save">拆分</button>
      </section>
      <section class="panel">
        <h2>⑤ 派生切片（须落在有效父区间内）</h2>
        <label>切片编号</label><input id="dv-id" placeholder="如 SL-01">
        <label>父区间</label><select id="dv-parent"></select>
        <label>起点 from（含）</label><input id="dv-from" type="number" step="any">
        <label>终点 to（不含）</label><input id="dv-to" type="number" step="any">
        <div class="muted" id="dv-ver"></div>
        <button id="dv-save">派生切片</button>
      </section>
      <section class="panel">
        <h2>⑥ 更正上游深度（保留旧版，后代待复核）</h2>
        <label>被更正区间</label><select id="cr-target"></select>
        <label>更正后新区间编号</label><input id="cr-id" placeholder="如 ZK17-A-v2">
        <label>更正后起点 from</label><input id="cr-from" type="number" step="any">
        <label>更正后终点 to</label><input id="cr-to" type="number" step="any">
        <div class="muted" id="cr-ver"></div>
        <button id="cr-save">提交更正</button>
      </section>
    </div>
    <section class="panel">
      <h2>钻孔看板（重叠与缺口）</h2>
      <div id="holes"></div>
    </section>
    <section class="panel">
      <h2>全部区间</h2>
      <table>
        <thead><tr><th>编号</th><th>钻孔</th><th>区间</th><th>状态</th><th>版本</th><th>类型</th><th>父级</th><th>操作</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
    <section class="panel">
      <h2>切片来源链</h2>
      <label>选择区间查看完整来源链</label><select id="chain-target"></select>
      <div id="chain"></div>
    </section>
  </main>
  <script>
    var state = { boreholes: [] };
    var KIND_LABEL = { source: "原始", splice: "拼接", split: "拆分", slice: "切片", correction: "更正" };
    var STATUS_LABEL = { valid: "有效", pending: "待复核", superseded: "旧版" };
    function $(id) { return document.getElementById(id); }
    function api(path, options) {
      var opts = options || {};
      if (opts.body) opts.headers = { "Content-Type": "application/json" };
      return fetch(path, opts).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.message || data.error || "请求失败");
          return data;
        });
      });
    }
    function post(path, payload) { return api(path, { method: "POST", body: JSON.stringify(payload) }); }
    function showMsg(text, ok) {
      $("msg").innerHTML = '<div class="' + (ok ? "okmsg" : "errmsg") + '">' + text + "</div>";
      setTimeout(function () { $("msg").innerHTML = ""; }, 6000);
    }
    function run(promise) { promise.then(function () { return load(); }).then(function () { showMsg("操作成功", true); }).catch(function (e) { showMsg(e.message, false); }); }
    function allIntervals() {
      var list = [];
      state.boreholes.forEach(function (h) { h.intervals.forEach(function (it) { list.push(it); }); });
      return list;
    }
    function findInterval(id) {
      var all = allIntervals();
      for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
      return null;
    }
    function fillOptions(select, items) {
      var prev = select.value;
      select.innerHTML = items.map(function (it) {
        return '<option value="' + it.id + '">' + it.id + "（" + it.range + " · " + STATUS_LABEL[it.status] + " · v" + it.version + "）</option>";
      }).join("");
      if (prev && items.some(function (it) { return it.id === prev; })) select.value = prev;
    }
    function syncHints() {
      [["sl-parent", "sl-ver"], ["dv-parent", "dv-ver"], ["cr-target", "cr-ver"]].forEach(function (pair) {
        var it = findInterval($(pair[0]).value);
        $(pair[1]).textContent = it ? "将对 v" + it.version + " 提交（提交时自动携带版本号，并发冲突会失败）" : "";
      });
    }
    function render() {
      var holes = state.boreholes;
      $("iv-hole").innerHTML = holes.map(function (h) { return '<option value="' + h.id + '">' + h.id + "（" + h.unitLabel + "）</option>"; }).join("");
      var all = allIntervals();
      var valid = all.filter(function (it) { return it.status === "valid"; });
      fillOptions($("sp-sources"), valid);
      fillOptions($("sl-parent"), valid);
      fillOptions($("dv-parent"), valid);
      fillOptions($("cr-target"), all.filter(function (it) { return it.status !== "superseded"; }));
      fillOptions($("chain-target"), all);
      syncHints();
      $("holes").innerHTML = holes.map(function (h) {
        var cover = h.intervals.filter(function (it) { return it.status === "valid"; })
          .map(function (it) { return '<span class="tag">' + it.id + " " + it.range + "</span>"; }).join("") || '<span class="muted">暂无有效区间</span>';
        var alerts = h.overlaps.map(function (o) { return '<div class="alert bad">重叠：' + o.a + " 与 " + o.b + " → " + o.range + "</div>"; }).join("") +
          h.gaps.map(function (g) { return '<div class="alert warn">缺口：' + g.range + "</div>"; }).join("");
        return "<h3>" + h.id + " · " + h.name + "（单位：" + h.unitLabel + "）</h3><div>" + cover + "</div>" + (alerts || '<div class="muted">无重叠、无缺口</div>');
      }).join("") || '<div class="muted">尚未登记钻孔</div>';
      $("rows").innerHTML = all.map(function (it) {
        var confirmBtn = it.status === "pending" ? '<button data-confirm="' + it.id + '">确认有效</button>' : "";
        return "<tr><td><b>" + it.id + "</b></td><td>" + it.boreholeId + "</td><td>" + it.range + "</td>" +
          '<td><span class="pill ' + it.status + '">' + STATUS_LABEL[it.status] + "</span></td><td>v" + it.version + "</td>" +
          "<td>" + (KIND_LABEL[it.kind] || it.kind) + "</td>" +
          "<td>" + (it.parents.join("、") || "—") + (it.supersededBy ? '<div class="muted">被 ' + it.supersededBy + " 取代</div>" : "") + "</td>" +
          '<td class="row-actions">' + confirmBtn + '<button class="ghost" data-chain="' + it.id + '">来源链</button></td></tr>';
      }).join("");
      document.querySelectorAll("[data-confirm]").forEach(function (btn) {
        btn.onclick = function () { run(post("/api/depth/confirm", { id: btn.dataset.confirm })); };
      });
      document.querySelectorAll("[data-chain]").forEach(function (btn) {
        btn.onclick = function () { $("chain-target").value = btn.dataset.chain; loadChain(); };
      });
    }
    function loadChain() {
      var id = $("chain-target").value;
      var box = $("chain");
      if (!id) { box.innerHTML = ""; return; }
      api("/api/depth/intervals/" + encodeURIComponent(id) + "/chain").then(function (chain) {
        box.innerHTML = "<h3>来源链（自根到叶，共 " + chain.nodes.length + " 个节点）</h3>" + chain.nodes.map(function (n) {
          return '<div class="chain-node" style="margin-left:' + n.depth * 22 + 'px"><b>' + n.id + "</b> " +
            '<span class="pill ' + n.status + '">' + STATUS_LABEL[n.status] + "</span> " +
            '<span class="tag">' + (KIND_LABEL[n.kind] || n.kind) + "</span> " + n.range +
            '<div class="muted">' + n.boreholeId + " · v" + n.version + (n.parents.length ? " · 父级：" + n.parents.join("、") : " · 根（原始登记）") + (n.note ? " · " + n.note : "") + "</div></div>";
        }).join("");
      }).catch(function (e) { box.innerHTML = '<div class="alert bad">' + e.message + "</div>"; });
    }
    function load() { return api("/api/depth/state").then(function (s) { state = s; render(); }); }
    $("reload").onclick = load;
    $("chain-target").onchange = loadChain;
    ["sl-parent", "dv-parent", "cr-target"].forEach(function (id) { $(id).onchange = syncHints; });
    $("bh-save").onclick = function () {
      run(post("/api/depth/boreholes", { id: $("bh-id").value.trim(), name: $("bh-name").value.trim(), unit: $("bh-unit").value }));
    };
    $("iv-save").onclick = function () {
      run(post("/api/depth/intervals", { id: $("iv-id").value.trim(), boreholeId: $("iv-hole").value, from: Number($("iv-from").value), to: Number($("iv-to").value) }));
    };
    $("sp-save").onclick = function () {
      var sources = Array.prototype.slice.call($("sp-sources").selectedOptions).map(function (o) { return o.value; });
      run(post("/api/depth/splice", { id: $("sp-id").value.trim(), sourceIds: sources }));
    };
    $("sl-save").onclick = function () {
      var parent = findInterval($("sl-parent").value);
      var cuts = $("sl-cuts").value.split(/[,，]/).map(function (s) { return Number(s.trim()); }).filter(function (n) { return !isNaN(n); });
      var ids = $("sl-ids").value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
      run(post("/api/depth/split", { parentId: parent && parent.id, expectedVersion: parent && parent.version, cuts: cuts, childIds: ids }));
    };
    $("dv-save").onclick = function () {
      var parent = findInterval($("dv-parent").value);
      run(post("/api/depth/derive", { id: $("dv-id").value.trim(), parentId: parent && parent.id, expectedVersion: parent && parent.version, from: Number($("dv-from").value), to: Number($("dv-to").value) }));
    };
    $("cr-save").onclick = function () {
      var target = findInterval($("cr-target").value);
      run(post("/api/depth/correct", { id: $("cr-id").value.trim(), targetId: target && target.id, expectedVersion: target && target.version, from: Number($("cr-from").value), to: Number($("cr-to").value) }));
    };
    load();
  </script>
</body>
</html>`;

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .slice { border-top:1px solid var(--line); padding-top:10px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤和交付 · <a href="/depth">深度区间拼接与溯源 →</a></div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    let samples = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function render() {
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("");
      samplesEl.innerHTML = samples.map(sample => '<article class="card"><h3>'+sample.project+'</h3><span class="pill">'+sample.status+'</span><div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div><label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'+sample.slices.map(slice => '<div class="slice"><b>'+slice.id+'</b><div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>').join("")+'<button data-deliver="'+sample.id+'">标记交付</button></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.add;
        await api('/api/samples/'+id+'/slices', { method:'POST', body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
        await load();
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
        await load();
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => { await api('/api/samples/'+btn.dataset.deliver+'/deliver', { method:'POST', body: JSON.stringify({}) }); await load(); });
    }
    async function load(){ samples = await api("/api/samples"); render(); }
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/depth/")) return await handleDepthApi(req, res, url);
    if (req.method === "GET" && url.pathname === "/depth") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(depthPage);
    }
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const sample = { id: `CORE-${Date.now()}`, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }] };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === logMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === logMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      slice.status = input.step;
      if (input.step === "观察") slice.observation = input.note || slice.observation;
      slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${server.address().port} (depth module at /depth)`));
