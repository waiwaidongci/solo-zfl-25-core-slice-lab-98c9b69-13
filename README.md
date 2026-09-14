# 岩芯样本切片实验室

运行：

```bash
npm start
```

访问 `http://localhost:3025`。支持样本创建、切片任务、步骤记录和交付统计（旧入口全部保留）。

## 深度区间拼接与切片溯源模块

新模块入口：`http://localhost:3025/depth`。

- **登记钻孔**：编号 + 米(m)/厘米(cm) 单位；系统内部统一为 0.1mm 整数刻度（米保留 4 位小数、厘米 2 位），超出精度的深度会被拒绝。
- **登记区间**：半开区间 `[from, to)`（from 含、to 不含），必须 `from < to`。
- **重叠与缺口**：按钻孔在看板中自动识别（统一精度后的整数刻度上计算，相邻不算重叠）。
- **拼接**：同一钻孔、首尾相接（`a.to === b.from`）的多个有效区间可拼接为新区间；跨孔拼接、不相邻、重复来源均失败。
- **拆分**：按多个切点一次性拆成 N+1 个子区间；切点必须严格落在父区间内部。
- **派生切片**：必须落在有效父区间内，越界派生失败；待复核/旧版区间不可派生。
- **更正**：更正上游深度会保留旧版（`superseded`），生成更正版本，并把全部后代（含旧链路上的下游）标为**待复核**；必须自父到子**逐级确认**后才恢复有效。
- **并发**：拆分/派生/更正均携带 `expectedVersion`，同一版本的并发操作仅成功一次，其余返回 409。
- **原子性**：任一变更失败（含落盘失败）整体回滚，不留部分区间或关系；数据存于 `data/depth-intervals.json`（tmp+rename 原子写），重启保留。
- **溯源**：`GET /api/depth/intervals/:id/chain` 返回任一切片的完整来源链（含旧版与更正节点）。

### API 一览（前缀 `/api/depth`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 全部钻孔、区间、重叠与缺口 |
| POST | `/boreholes` | 登记钻孔 `{id, name, unit}` |
| POST | `/intervals` | 登记区间 `{id, boreholeId, from, to}` |
| POST | `/splice` | 拼接 `{id, sourceIds[], expectedVersions?}` |
| POST | `/split` | 拆分 `{parentId, expectedVersion, cuts[], childIds[]}` |
| POST | `/derive` | 派生切片 `{id, parentId, expectedVersion, from, to}` |
| POST | `/correct` | 更正 `{id, targetId, expectedVersion, from, to}` |
| POST | `/confirm` | 逐级确认 `{id}` |
| GET | `/intervals/:id/chain` | 完整来源链 |

### 测试

```bash
npm test
```

集成测试会启动真实服务进程，实测单位边界、重叠缺口、拼接拆分、越界/跨孔/循环失败、
级联失效与逐级确认、并发互斥（同版本仅成功一次）、故障回滚（`DEPTH_TEST_HOOK=1` 模拟落盘失败）、
重启保留以及旧入口兼容。
