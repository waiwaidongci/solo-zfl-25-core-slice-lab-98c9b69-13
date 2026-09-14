// 深度区间拼接与切片溯源 —— 纯领域逻辑（不依赖 IO，便于测试与重启后重建派生状态）
//
// 约定：
// - 钻孔登记的深度单位为米(m)或厘米(cm)，系统内部统一为 0.1mm（万分之一米）整数刻度，
//   即米×10000、厘米×100，运算全程整数，避免浮点误差。
// - 深度区间为半开区间 [from, to)：from 含、to 不含。
// - 区间状态：valid（有效）/ pending（待复核）/ superseded（已被更正取代，旧版保留）。
// - 关系：parents -> children 有向无环图；split/splice/correct 均产生派生关系。

export const TICKS_PER_METER = 10000; // 0.1mm
export const TICKS_PER_CM = 100;

export const UNITS = {
  m: { label: "米", per: TICKS_PER_METER, decimals: 4 },
  cm: { label: "厘米", per: TICKS_PER_CM, decimals: 2 },
};

export const STATUS = { VALID: "valid", PENDING: "pending", SUPERSEDED: "superseded" };

export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new DomainError(code, message, details);
};

// ---------- 单位与精度 ----------

export function toTicks(value, unit) {
  const spec = UNITS[unit];
  if (!spec) fail("invalid_unit", `不支持的深度单位：${unit}（仅支持 m / cm）`);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_depth", `深度必须是有限数值，收到：${value}`);
  }
  const ticks = Math.round(value * spec.per);
  if (Math.abs(ticks - value * spec.per) > 1e-6) {
    fail("precision_loss", `深度 ${value}${unit} 超出统一精度（0.1mm）可表达范围`);
  }
  if (!Number.isSafeInteger(ticks)) fail("invalid_depth", `深度 ${value}${unit} 超出可表示范围`);
  return ticks;
}

export function fromTicks(ticks, unit) {
  const spec = UNITS[unit];
  if (!spec) fail("invalid_unit", `不支持的深度单位：${unit}`);
  return ticks / spec.per;
}

export function formatTicks(ticks, unit = "m") {
  const spec = UNITS[unit];
  if (!spec) fail("invalid_unit", `不支持的深度单位：${unit}`);
  return `${(ticks / spec.per).toFixed(spec.decimals)}${unit}`;
}

// ---------- 区间集合分析（统一精度后的整数刻度上进行） ----------

function normalizePairs(intervals) {
  return intervals
    .map((it) => ({ from: it.fromTicks, to: it.toTicks, ref: it }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

// 重叠：半开区间 [a.from,a.to) 与 [b.from,b.to) 相交当且仅当 a.from < b.to && b.from < a.to
export function findOverlaps(intervals) {
  const sorted = normalizePairs(intervals);
  const overlaps = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.from >= a.to) break;
      overlaps.push({
        a: a.ref.id,
        b: b.ref.id,
        fromTicks: Math.max(a.from, b.from),
        toTicks: Math.min(a.to, b.to),
      });
    }
  }
  return overlaps;
}

// 缺口：同一钻孔的区间按起点排序后，相邻两段之间的空隙
export function findGaps(intervals) {
  const sorted = normalizePairs(intervals);
  const gaps = [];
  let cursor = null;
  for (const it of sorted) {
    if (cursor === null) {
      cursor = it.to;
      continue;
    }
    if (it.from > cursor) gaps.push({ fromTicks: cursor, toTicks: it.from });
    cursor = Math.max(cursor, it.to);
  }
  return gaps;
}

// 同孔相邻：a.to === b.from（半开区间首尾相接）
export function areAdjacent(a, b) {
  return a.toTicks === b.fromTicks || b.toTicks === a.fromTicks;
}

// ---------- 状态存取 ----------

export function getBorehole(state, id) {
  const hole = state.boreholes.get(id);
  if (!hole) fail("borehole_not_found", `钻孔不存在：${id}`);
  return hole;
}

export function getInterval(state, id) {
  const interval = state.intervals.get(id);
  if (!interval) fail("interval_not_found", `深度区间不存在：${id}`);
  return interval;
}

export function requireVersion(interval, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) {
    fail("version_required", "该操作必须携带 expectedVersion 以防止并发覆盖");
  }
  if (interval.version !== expectedVersion) {
    fail(
      "version_conflict",
      `区间 ${interval.id} 当前版本为 v${interval.version}，与期望 v${expectedVersion} 不一致（可能已被并发修改）`
    );
  }
}

export function requireUsable(interval, action) {
  if (interval.status !== STATUS.VALID) {
    fail(
      "interval_not_valid",
      `区间 ${interval.id} 当前状态为「${interval.status}」，不能执行${action}（仅有效区间可派生）`
    );
  }
}

// ---------- 操作：登记钻孔 / 区间 ----------

export function createBorehole(state, { id, name, unit }, ctx) {
  if (!id || typeof id !== "string") fail("invalid_input", "钻孔编号不能为空");
  if (state.boreholes.has(id)) fail("duplicate_borehole", `钻孔已存在：${id}`);
  if (!UNITS[unit]) fail("invalid_unit", `钻孔 ${id} 的单位必须是 m 或 cm`);
  const hole = { id, name: name || id, unit, createdAt: ctx.now(), createdBy: ctx.actor };
  state.boreholes.set(id, hole);
  return hole;
}

export function createInterval(state, { id, boreholeId, from, to }, ctx) {
  const hole = getBorehole(state, boreholeId);
  if (!id || typeof id !== "string") fail("invalid_input", "区间编号不能为空");
  if (state.intervals.has(id)) fail("duplicate_interval", `区间编号已存在：${id}`);
  const fromT = toTicks(from, hole.unit);
  const toT = toTicks(to, hole.unit);
  if (!(fromT < toT)) {
    fail("invalid_interval", `区间 ${id} 必须满足 起点 < 终点（半开区间 [from, to)）`);
  }
  const interval = {
    id,
    boreholeId,
    fromTicks: fromT,
    toTicks: toT,
    status: STATUS.VALID,
    version: 1,
    kind: "source",
    note: "",
    createdAt: ctx.now(),
    createdBy: ctx.actor,
    parents: [],
    children: [],
    supersededBy: null,
    correctionOf: null,
    confirmedAt: null,
    confirmedBy: null,
  };
  state.intervals.set(id, interval);
  return interval;
}

// ---------- 操作：拼接（同孔、相邻、均有效） ----------

export function spliceIntervals(state, { id, sourceIds, expectedVersions, note }, ctx) {
  if (!Array.isArray(sourceIds) || sourceIds.length < 2) {
    fail("invalid_input", "拼接至少需要两个来源区间");
  }
  if (state.intervals.has(id)) fail("duplicate_interval", `区间编号已存在：${id}`);
  const sources = sourceIds.map((sid) => getInterval(state, sid));
  if (new Set(sourceIds).size !== sourceIds.length) {
    fail("invalid_input", "拼接来源中存在重复区间");
  }
  for (const src of sources) requireUsable(src, "拼接");
  if (expectedVersions) {
    for (const src of sources) requireVersion(src, expectedVersions[src.id]);
  }
  const holeIds = new Set(sources.map((s) => s.boreholeId));
  if (holeIds.size !== 1) {
    fail("cross_hole_splice", "不允许跨孔拼接：所有来源区间必须属于同一钻孔", {
      boreholes: [...holeIds],
    });
  }
  const sorted = [...sources].sort((a, b) => a.fromTicks - b.fromTicks);
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i].toTicks !== sorted[i + 1].fromTicks) {
      fail(
        "not_adjacent",
        `区间 ${sorted[i].id} 与 ${sorted[i + 1].id} 不相邻，无法拼接（需要首尾相接的半开区间）`
      );
    }
  }
  const interval = {
    id,
    boreholeId: sorted[0].boreholeId,
    fromTicks: sorted[0].fromTicks,
    toTicks: sorted[sorted.length - 1].toTicks,
    status: STATUS.VALID,
    version: 1,
    kind: "splice",
    note: note || "",
    createdAt: ctx.now(),
    createdBy: ctx.actor,
    parents: sourceIds.slice(),
    children: [],
    supersededBy: null,
    correctionOf: null,
    confirmedAt: null,
    confirmedBy: null,
  };
  state.intervals.set(id, interval);
  for (const src of sources) {
    src.children.push(id);
    src.version += 1; // 子级集合变化，递增修订号使并发的过期操作失败
  }
  return interval;
}

// ---------- 操作：拆分（多个切点，一次性产生全部子区间） ----------

export function splitInterval(state, { parentId, cuts, childIds, expectedVersion, note }, ctx) {
  const parent = getInterval(state, parentId);
  requireUsable(parent, "拆分");
  requireVersion(parent, expectedVersion);
  if (!Array.isArray(cuts) || cuts.length === 0) fail("invalid_input", "至少需要一个切点");
  const hole = getBorehole(state, parent.boreholeId);
  const cutTicks = cuts.map((c) => toTicks(c, hole.unit));
  for (const ct of cutTicks) {
    if (ct <= parent.fromTicks || ct >= parent.toTicks) {
      fail(
        "cut_out_of_bounds",
        `切点 ${formatTicks(ct, hole.unit)} 不在父区间 ${parent.id} 的范围 ${formatTicks(parent.fromTicks, hole.unit)} ~ ${formatTicks(parent.toTicks, hole.unit)} 内`
      );
    }
  }
  const uniqueCuts = [...new Set(cutTicks)].sort((a, b) => a - b);
  const bounds = [parent.fromTicks, ...uniqueCuts, parent.toTicks];
  if (!Array.isArray(childIds) || childIds.length !== bounds.length - 1) {
    fail("invalid_input", `按 ${uniqueCuts.length} 个切点拆分将产生 ${bounds.length - 1} 个子区间，请提供对应数量的编号`);
  }
  if (new Set(childIds).size !== childIds.length) fail("invalid_input", "子区间编号存在重复");
  for (const cid of childIds) {
    if (state.intervals.has(cid)) fail("duplicate_interval", `区间编号已存在：${cid}`);
  }
  const children = childIds.map((cid, i) => ({
    id: cid,
    boreholeId: parent.boreholeId,
    fromTicks: bounds[i],
    toTicks: bounds[i + 1],
    status: STATUS.VALID,
    version: 1,
    kind: "split",
    note: note || "",
    createdAt: ctx.now(),
    createdBy: ctx.actor,
    parents: [parentId],
    children: [],
    supersededBy: null,
    correctionOf: null,
    confirmedAt: null,
    confirmedBy: null,
  }));
  for (const child of children) state.intervals.set(child.id, child);
  parent.children.push(...childIds);
  parent.version += 1;
  return children;
}

// ---------- 操作：派生切片（须落在有效父区间内） ----------

export function deriveSlice(state, { id, parentId, from, to, expectedVersion, note }, ctx) {
  const parent = getInterval(state, parentId);
  requireUsable(parent, "派生切片");
  requireVersion(parent, expectedVersion);
  const hole = getBorehole(state, parent.boreholeId);
  if (state.intervals.has(id)) fail("duplicate_interval", `区间编号已存在：${id}`);
  const fromT = toTicks(from, hole.unit);
  const toT = toTicks(to, hole.unit);
  if (!(fromT < toT)) fail("invalid_interval", `切片 ${id} 必须满足 起点 < 终点`);
  if (fromT < parent.fromTicks || toT > parent.toTicks) {
    fail(
      "slice_out_of_bounds",
      `切片 ${id} [${formatTicks(fromT, hole.unit)}, ${formatTicks(toT, hole.unit)}) 越界：必须落在父区间 ${parent.id} [${formatTicks(parent.fromTicks, hole.unit)}, ${formatTicks(parent.toTicks, hole.unit)}) 内`
    );
  }
  const slice = {
    id,
    boreholeId: parent.boreholeId,
    fromTicks: fromT,
    toTicks: toT,
    status: STATUS.VALID,
    version: 1,
    kind: "slice",
    note: note || "",
    createdAt: ctx.now(),
    createdBy: ctx.actor,
    parents: [parentId],
    children: [],
    supersededBy: null,
    correctionOf: null,
    confirmedAt: null,
    confirmedBy: null,
  };
  state.intervals.set(id, slice);
  parent.children.push(id);
  parent.version += 1;
  return slice;
}

// ---------- 操作：更正（保留旧版，全部后代待复核） ----------

export function correctInterval(state, { id, targetId, from, to, expectedVersion, note }, ctx) {
  const target = getInterval(state, targetId);
  if (target.status === STATUS.SUPERSEDED) {
    fail("already_superseded", `区间 ${targetId} 已是旧版（被 ${target.supersededBy} 取代），请对最新版本更正`);
  }
  requireVersion(target, expectedVersion);
  if (state.intervals.has(id)) fail("duplicate_interval", `区间编号已存在：${id}`);
  const hole = getBorehole(state, target.boreholeId);
  const fromT = toTicks(from, hole.unit);
  const toT = toTicks(to, hole.unit);
  if (!(fromT < toT)) fail("invalid_interval", "更正后的区间必须满足 起点 < 终点");

  // 先收集全部后代（在修改任何状态之前完成遍历与校验，保证失败不留部分结果）。
  // 遍历穿透旧版节点：旧版本身是历史档案不再标记，但其更正版本仍是下游，必须一并标出。
  // 同时沿 correctionOf 链回溯整条更正血脉，保证"更正的更正"也能波及挂在旧链路上的下游。
  const lineage = [];
  {
    let cursor = target;
    const lineageSeen = new Set();
    while (cursor && !lineageSeen.has(cursor.id)) {
      lineageSeen.add(cursor.id);
      lineage.push(cursor.id);
      cursor = cursor.correctionOf ? state.intervals.get(cursor.correctionOf) : null;
    }
  }
  const descendants = [];
  const seen = new Set(lineage);
  const queue = [...lineage];
  while (queue.length) {
    const current = getInterval(state, queue.shift());
    for (const childId of current.children) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = getInterval(state, childId);
      if (child.status !== STATUS.SUPERSEDED) descendants.push(child);
      queue.push(childId);
    }
  }

  const correction = {
    id,
    boreholeId: target.boreholeId,
    fromTicks: fromT,
    toTicks: toT,
    status: STATUS.VALID,
    version: target.version + 1,
    kind: "correction",
    note: note || "",
    createdAt: ctx.now(),
    createdBy: ctx.actor,
    parents: [targetId],
    children: [],
    supersededBy: null,
    correctionOf: targetId,
    confirmedAt: null,
    confirmedBy: null,
  };
  state.intervals.set(id, correction);
  target.children.push(id);
  target.status = STATUS.SUPERSEDED;
  target.supersededBy = id;
  const lineageSet = new Set(lineage);
  for (const d of descendants) {
    // 直接后代的父引用重定向到更正版本：旧版保留可查，但子树挂到新版下，逐级确认才能走完。
    // 父引用指向更正链上任一旧版本的，都一并改挂到最新更正版本。
    d.parents = d.parents.map((pid) => (lineageSet.has(pid) ? id : pid));
    if (d.parents.includes(id)) {
      for (const oldId of lineage) {
        const old = state.intervals.get(oldId);
        old.children = old.children.filter((cid) => cid !== d.id);
      }
      if (!correction.children.includes(d.id)) correction.children.push(d.id);
    }
    if (d.status === STATUS.VALID) d.status = STATUS.PENDING;
  }
  return { correction, superseded: target, affected: descendants };
}

// ---------- 操作：逐级确认（父链全部有效后，子级才能恢复有效） ----------

export function confirmInterval(state, { id }, ctx) {
  const interval = getInterval(state, id);
  if (interval.status !== STATUS.PENDING) {
    fail("not_pending", `区间 ${id} 当前状态为「${interval.status}」，无需确认`);
  }
  const blocking = interval.parents
    .map((pid) => getInterval(state, pid))
    .filter((p) => p.status !== STATUS.VALID && interval.correctionOf !== p.id)
    .map((p) => p.id);
  if (blocking.length) {
    fail(
      "parents_not_confirmed",
      `必须先逐级确认父级区间：${blocking.join("、")} 仍为待复核/旧版`,
      { blocking }
    );
  }
  interval.status = STATUS.VALID;
  interval.confirmedAt = ctx.now();
  interval.confirmedBy = ctx.actor;
  return interval;
}

// ---------- 溯源：完整来源链 ----------

export function provenanceChain(state, id) {
  const target = getInterval(state, id);
  const nodes = new Map();
  const edges = [];
  const visit = (nodeId) => {
    if (nodes.has(nodeId)) return;
    const node = getInterval(state, nodeId);
    nodes.set(nodeId, node);
    for (const pid of node.parents) {
      edges.push({ from: pid, to: nodeId });
      visit(pid);
    }
  };
  visit(id);
  const depthOf = (nodeId) => {
    const node = nodes.get(nodeId);
    if (!node.parents.length) return 0;
    return 1 + Math.max(...node.parents.map(depthOf));
  };
  const chain = [...nodes.values()]
    .map((n) => ({ ...n, depth: depthOf(n.id) }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  return { target: id, nodes: chain, edges };
}

// 循环引用检测：若新增 parentId -> childId 边会成环则拒绝（沿 child 的后代方向能回到 parent 即成环）
export function wouldCreateCycle(state, parentId, childId) {
  if (parentId === childId) return true;
  const seen = new Set();
  const queue = [childId];
  while (queue.length) {
    const current = state.intervals.get(queue.shift());
    if (!current) continue;
    for (const next of current.children) {
      if (next === parentId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// ---------- 派生状态重建（重启后调用） ----------

export function rebuildDerived(state) {
  // 1) 关系完整性校验 + 子级索引重建
  for (const interval of state.intervals.values()) interval.children = [];
  for (const interval of state.intervals.values()) {
    for (const pid of interval.parents) {
      const parent = state.intervals.get(pid);
      if (!parent) fail("corrupt_data", `区间 ${interval.id} 引用了不存在的父级 ${pid}`);
      parent.children.push(interval.id);
    }
  }
  // 2) 待复核状态重建：任何非旧版区间，若其祖先链上存在被取代的旧版，则必须为待复核。
  //    例外：指向自己 correctionOf 旧版的边不算——更正版本本身就是对旧版的替代。
  const memo = new Map();
  const hasSupersededAncestor = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) fail("corrupt_data", `检测到循环引用，涉及区间 ${id}`);
    visiting.add(id);
    const node = state.intervals.get(id);
    const result = node.parents.some((pid) => {
      const p = state.intervals.get(pid);
      if (p.status === STATUS.SUPERSEDED && node.correctionOf !== pid) return true;
      return hasSupersededAncestor(pid, visiting);
    });
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  for (const interval of state.intervals.values()) {
    if (interval.status !== STATUS.SUPERSEDED && hasSupersededAncestor(interval.id)) {
      interval.status = STATUS.PENDING;
    }
  }
  return state;
}

// ---------- 序列化 ----------

export function serializeState(state) {
  // 深拷贝：快照用于失败回滚与落盘，不能与内存中的活对象共享引用
  return {
    boreholes: [...state.boreholes.values()].map((h) => ({ ...h })),
    intervals: [...state.intervals.values()].map((it) => ({
      ...it,
      parents: [...it.parents],
      children: [...it.children],
    })),
  };
}

export function emptyState() {
  return { boreholes: new Map(), intervals: new Map() };
}

export function hydrateState(data) {
  const state = emptyState();
  for (const hole of data.boreholes || []) state.boreholes.set(hole.id, { ...hole });
  for (const it of data.intervals || []) state.intervals.set(it.id, { ...it, parents: [...it.parents], children: [...it.children] });
  return rebuildDerived(state);
}
