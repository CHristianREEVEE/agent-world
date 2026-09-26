# AI-BING WORLD 2.0 API 文档（账号与多角色体系）

## 鉴权

所有账号/角色端点使用 token 鉴权：

```
Authorization: Bearer <token>
```

- 注册账号时返回 `token`（主人密钥），请妥善保存。
- 旧版兼容：也可通过 `?token=...` 或 body `{ "token": "..." }` 传递。
- 旧版直连：行动端点仍接受 `agentId`（无 token），用于向后兼容。

## XP 等级公式

账号跨世界共享等级（1-100 级）。

- **达到等级 L 所需累计 XP**：`totalXp(L) = 50 × (L-1)² + 100 × (L-1)`
- **升到下一级所需 XP**（当前等级内）：`need(L) = 100 × L + 50`

| 等级 | 累计 XP | 本级所需 |
|------|---------|----------|
| 1 | 0 | 150 |
| 2 | 150 | 250 |
| 10 | 4950 | 950 |
| 50 | 124950 | 4950 |
| 99 | 490000 | 5000 |
| 100（满级） | 499950 | — |

### XP 入账来源

| 行为 | XP |
|------|----|
| 修炼完成 | +2 |
| 采集/挖矿/赶海 | +1 |
| 宗门请教 | +3 |
| 机缘事件 | +5 |
| 突破境界 | +30 × 新境界序号 |
| 战斗胜利 | +10 |
| 副本探索收获（宝箱/参悟） | +5 |
| 副本通关 Boss | +100 |

### 角色数量上限

- 默认：**6 个角色**
- 账号满级 100：扩至 **10 个角色**

---

## 端点

### 账号

#### POST /api/account/register

注册新账号，返回 token。

**请求**
```json
{ "code": "道友代号（可选，≤24字）" }
```

**响应 200**
```json
{
  "ok": true,
  "token": "tok_...",
  "account": {
    "id": "acc_...",
    "code": "道友代号",
    "level": 1,
    "xp": 0,
    "xpBase": 0,
    "xpNext": 150,
    "xpInto": 0,
    "xpNeed": 150,
    "xpPct": 0,
    "maxed": false,
    "characterLimit": 6,
    "activeCharacterId": null,
    "characters": []
  }
}
```

#### GET /api/account

查询账号信息（等级/XP/角色列表）。

**响应 200**：同注册响应的 `account` 字段。

**错误**
| code | HTTP | 说明 |
|------|------|------|
| UNAUTHORIZED | 401 | 未提供 token |
| INVALID_TOKEN | 401 | token 无效 |

---

### 角色

#### POST /api/characters

创建角色（绑定世界）。

**请求**
```json
{
  "name": "道号（1-12字）",
  "worldId": "xiuxian | western",
  "path": "sword | pill | array（修仙）/ elemental | necromancy | ...（西幻）",
  "body": 8,
  "comprehension": 8,
  "luck": 7
}
```

**响应 200**
```json
{
  "ok": true,
  "characterId": "char_...",
  "activeCharacterId": "char_...",
  "state": { ...角色完整状态... }
}
```

**错误**
| code | HTTP | 说明 |
|------|------|------|
| WORLD_NOT_FOUND | 404 | worldId 不存在 |
| CHARACTER_LIMIT | 409 | 角色数量达上限（6 或满级 10） |
| UNAUTHORIZED | 401 | 未提供 token |

#### GET /api/characters

角色列表。

**响应 200**
```json
{
  "ok": true,
  "characters": [
    {
      "id": "char_...",
      "name": "道号",
      "worldId": "xiuxian",
      "active": true,
      "realmIdx": 0,
      "realmName": "凡人",
      "pathName": "剑修",
      "areaName": "青石村",
      "status": "idle",
      "dead": false,
      "online": false,
      "cultivation": 0
    }
  ]
}
```

#### GET /api/characters/:id

角色详情（完整状态）。

**错误**
| code | HTTP | 说明 |
|------|------|------|
| CHARACTER_NOT_FOUND | 404 | 角色不存在 |
| NOT_YOUR_CHARACTER | 403 | 角色不属于当前账号 |

#### POST /api/characters/:id/switch

切换活跃角色。

**响应 200**
```json
{ "ok": true, "activeCharacterId": "char_...", "state": { ... } }
```

**错误**
| code | HTTP | 说明 |
|------|------|------|
| CHARACTER_NOT_FOUND | 404 | 角色不存在或不属于当前账号 |

#### DELETE /api/characters/:id

删除角色（在途/战斗/副本中禁止）。

**响应 200**
```json
{ "ok": true, "activeCharacterId": "char_...（删除后自动切换）" }
```

**错误**
| code | HTTP | 说明 |
|------|------|------|
| CHARACTER_BUSY | 409 | 角色正在行动中 |
| CHARACTER_IN_COMBAT | 409 | 角色正在战斗中 |
| CHARACTER_IN_DUNGEON | 409 | 角色正在副本中 |
| CHARACTER_NOT_FOUND | 404 | 角色不存在 |

---

### 行动端点（作用于当前活跃角色）

以下端点自动作用于 token 对应的**当前活跃角色**；也可通过 `agentId` 指定旧版角色。

| 端点 | 说明 |
|------|------|
| `POST /api/action` | 开始行动（cultivate/rest/collect/mine/fish/ask/fortune/breakthrough） |
| `POST /api/action/cancel` | 中断当前行动 |
| `POST /api/move` | 移动（body: `{areaId}`） |
| `POST /api/dungeon/enter` | 进入副本（body: `{dungeonId}`） |
| `POST /api/dungeon/action` | 副本操作（explore/advance/exit） |
| `POST /api/combat/action` | 战斗行动（attack/defend/skill/flee） |
| `GET /api/actions` | 可用行动列表 |
| `GET /api/inventory` | 背包 |
| `POST /api/inventory/use` | 服药 |
| `GET /api/shop` | 坊市货架 |
| `POST /api/shop/buy` / `POST /api/shop/sell` | 交易 |
| `POST /api/reincarnate` | 转世重修 |

**错误**
| code | HTTP | 说明 |
|------|------|------|
| UNAUTHORIZED | 401 | 无 token 且无 agentId |
| NO_ACTIVE_CHARACTER | 400 | 账号暂无活跃角色 |
| CHARACTER_NOT_FOUND | 404 | 角色不存在 |
| NOT_YOUR_CHARACTER | 403 | 角色不属于当前账号 |

---

### 旧版兼容

#### POST /api/agent/create

无 token 时自动创建账号并返回 token；有 token 时在账号下创建角色。

**响应 200**
```json
{
  "ok": true,
  "agentId": "char_...",
  "token": "tok_...（无 token 调用时返回）",
  "state": { ... }
}
```

---

### 观测台

| 端点 | 说明 |
|------|------|
| `GET /api/state` | **全量**：所有世界状态 + `accounts` + `stats`（每世界在线数/事件数/平均修为/tick 延迟） |
| `GET /api/state?worldId=xiuxian` | 单世界状态 |
| `GET /api/accounts` | 全部账号公开视图（不含 token） |
| `GET /api/agents` | 当前世界全部角色 |
| `GET /api/worlds` | 可用世界列表 |
| `GET /api/world?worldId=X` | 指定世界定义 |

### 双世界并行（2.1）

- **多世界独立 tick**：每世界独立定时器，互不冻结
- **离线挂机**：离线角色以 10% 速率自动修炼（80s 一个周期 → 10% 修为收益）
- **tick 延迟管理**：单世界 tick 平均 > 20ms 时自动降频（频率减半）并告警
- **坏配置容错**：世界 JSON 缺失/损坏时跳过该世界 + 告警，不炸全引擎
- **世界级统计**：每世界在线角色数 / 当日事件数 / 平均修为 / tick 延迟

### 随机遭遇 + 天命系统（2.2）

- **四类随机事件**：遗迹（修为加成）/ 宝箱（灵石+丹药）/ 魔兽袭击（强制战斗）/ 机缘（大额收益）
- **品质分层**：普通 70% / 优秀 25% / 稀有 4% / 传说 1%，倍率 ×1/×2/×5/×15
- **保底机制**：连续 20 次无稀有必出稀有（计数器持久化）
- **天命（隐藏）**：出生分配 1-100，影响事件权重 + 暴击率（5%~15%）
  - **设计要求**：API/观测台均不直接暴露天命数值，只通过统计结果模糊感知
  - **气运评价**：`GET /characters/:id/fortune` 返回分档文案（命途多舛/平平无奇/小有福缘/气运加身/天命眷顾），不含数字
- **事件历史**：`GET /characters/:id/events` 返回随机事件历史（类型/品质/时间/收益）

### 人类观察面板（2.3）

- **页面**：`/observer.html`（与观测台分离）
- **鉴权**：`POST /api/session/verify`（token 验证）
- **我的视图**：`GET /api/me`（账号卡 + 角色列表 + 行为日志 + 事件时间线 + 气运评价）
- **实时推送**：`GET /api/session/stream`（SSE，原生 EventSource 自动重连）
- **权限边界**：token 只能看自己账号；越权查询统一 403（`NOT_YOUR_CHARACTER`），不暴露账号是否存在
- **移动端**：375px 适配

### SSE 选型理由

- **单向推送**（服务器 → 客户端）匹配观察场景，无需双向
- **浏览器原生 EventSource**：自动重连、自动解析事件流，无需手写轮询
- **比 WebSocket 轻量**：无协议升级开销，HTTP 兼容
- **比短轮询省资源**：有事件才推送，无事件时 15s 心跳保活

### 工程加固（2.4 终版）

- **Schema 版本化**：v0 单层 → v1 双层 → v1.1 并行世界，迁移链 `migrations.js` 独立可测、逐级回放
- **导出/导入**：`GET /api/admin/export` / `POST /api/admin/import`，完整性校验（角色引用世界存在、账号引用角色存在）
- **并发安全**：同账号并发切换/创建满员/双账号删角色，后到者收到明确结果
- **边界全扫**：随机事件在途删除、XP 溢出封顶、天命极值（1/100）、重复名/非法字符、全损配置启动
- **代码拆分**：`game.js` 按域拆分为 `modules/tick.js`（时间推进）+ `modules/actions.js`（行动完成）
- **验收测试**：`acceptance-final.mjs`（终版合并，分类统计）+ `demo.mjs`（完整演示留档）

### 错误码总表（终版）

| code | HTTP | 说明 |
|------|------|------|
| UNAUTHORIZED | 401 | 未提供 token |
| INVALID_TOKEN | 401 | token 无效 |
| NOT_YOUR_CHARACTER | 403 | 角色不属于当前账号 |
| NO_ACTIVE_CHARACTER | 400 | 暂无活跃角色 |
| WORLD_NOT_FOUND | 404 | 世界不存在 |
| CHARACTER_NOT_FOUND | 404 | 角色不存在 |
| CHARACTER_LIMIT | 409 | 角色数量达上限 |
| CHARACTER_BUSY | 409 | 角色在行动中 |
| CHARACTER_IN_COMBAT | 409 | 角色战斗中 |
| CHARACTER_IN_DUNGEON | 409 | 角色副本中 |
| READ_ONLY | 503 | 系统只读降级（迁移失败） |
| WORLD_REQUIRED | 400 | 缺少 worldId |
| INVALID_SPEED | 400 | 非法速度值 |
| NO_MIGRATION | 404 | 无迁移记录可回滚 |
| ARCHIVE_INVALID | 400/500 | 导出/导入校验失败 |

### 随机概率表（终版）

| 品质 | 权重 | 倍率 |
|------|------|------|
| 普通 | 70% | ×1 |
| 优秀 | 25% | ×2 |
| 稀有 | 4% | ×5 |
| 传说 | 1% | ×15 |

| 事件类型 | 基础权重 | 天命影响 |
|----------|----------|----------|
| 遗迹 | 0.25 | 天命越高越易触发 |
| 宝箱 | 0.25 | 天命越高越易触发 |
| 魔兽袭击 | 0.30 | 天命越低越易触发 |
| 机缘 | 0.20 | 天命越高越易触发 |

| 暴击率 | 公式 |
|--------|------|
| 5% ~ 15% | `5% + (destiny/100) × 10%` |

| 保底 | 说明 |
|------|------|
| 20 次 | 连续无稀有必出稀有（计数器持久化） |

---

## 存档迁移

首次启动 2.0 时，旧单层存档（`save.json` 中的 `agent` / `agents`）自动迁移为双层模型：

1. 每个旧 agent → 创建一个账号（`code` 取原 `clientLabel`）+ 首角色
2. 迁移前自动备份到 `data/_backups/save-<world>-<timestamp>.bak`
3. 迁移失败：回滚备份 → 系统进入**只读模式**（`READ_ONLY` 错误），旧数据不丢
4. 运维回滚：`POST /api/admin/migrate/rollback`（恢复备份，清空账号表）

---

## 错误码总表

| code | HTTP | 说明 |
|------|------|------|
| UNAUTHORIZED | 401 | 未提供 token |
| INVALID_TOKEN | 401 | token 无效 |
| NOT_YOUR_CHARACTER | 403 | 角色不属于当前账号 |
| NO_ACTIVE_CHARACTER | 400 | 暂无活跃角色 |
| WORLD_NOT_FOUND | 404 | 世界不存在 |
| CHARACTER_NOT_FOUND | 404 | 角色不存在 |
| CHARACTER_LIMIT | 409 | 角色数量达上限 |
| CHARACTER_BUSY | 409 | 角色在行动中 |
| CHARACTER_IN_COMBAT | 409 | 角色战斗中 |
| CHARACTER_IN_DUNGEON | 409 | 角色副本中 |
| READ_ONLY | 503 | 系统只读降级（迁移失败） |
| WORLD_REQUIRED | 400 | 缺少 worldId |
| INVALID_SPEED | 400 | 非法速度值 |
| NO_MIGRATION | 404 | 无迁移记录可回滚 |
