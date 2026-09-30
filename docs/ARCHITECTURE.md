# tedb-electron-storage 架构与业务流程

> 适用版本：0.3.0（本 fork）。本文档描述修复与并发增强后的实际行为。

## 1. 定位与使用流程

本包是 [TeDB](https://github.com/tedb-org/teDB)（类 MongoDB 的嵌入式文档数据库）的**文件存储适配器**：实现 `IStorageDriver` 接口，被 tedb 的 `Datastore` 消费。tedb 负责内存中的索引与查询，本包负责所有磁盘 IO。

典型使用流程：

```typescript
import {ElectronStorage} from '@qiyangxy/tedb-electron-storage';
import {Datastore} from 'tedb';

// 第 3 个参数可选：自定义数据根目录；不传则使用 OS 用户目录
const storage = new ElectronStorage('MyDB', 'users', 'D:/my-data');
const db = new Datastore({storage});

await db.ensureIndex({fieldName: 'email', unique: true});
await db.insert({_id: 'u1', email: 'a@x.com'});
await db.find({email: 'a@x.com'}).exec();
await db.update({email: 'a@x.com'}, {$set: {name: 'Alice'}}, {multi: false});
await db.remove({email: 'a@x.com'});
await db.sanitize();          // 交叉清理：索引 ↔ 磁盘文件
await db.saveIndex('email');  // 索引持久化（每次全量重写索引文件）
```

## 2. 磁盘布局

```
<dataDir>/<dbName>/
└─ db/<collection>/
   ├─ <key>.db                  # 文档当前值（每文档一个 JSON 文件）
   ├─ index_<fieldName>.db      # 索引（JSON 数组，整体读写）
   └─ `v0.0.1/states/
      ├─ <key>/past             # 该文档上一代内容（一代备份，lazyBackup 下由首次更新创建）
      └─ index_<fieldName>/past # 该索引上一代内容
```

* 版本目录名带前导反引号（`` `v0.0.1 ``）是**有意的**：所有目录扫描用 `` `v `` 前缀识别并跳过它。
* 扫描只认 `.db` 后缀的文件；原子写产生的 `*.tmp.<pid>.<n>` 残留文件会被自动忽略。
* key 从文件名第一个 `.` 之前截取——**key 中不能包含 `.`**（tedb 的 _id 是 base64/hex，天然满足）。

## 3. 写入路径（setItem / storeIndex）

```
value → JSON.stringify（往返校验）
  → base 文件不存在？（safeStat 探测，不读内容）
      是 → 无备份目录？ lazyBackup（默认）下只写 base，past 留给首次更新
           （lazyBackup:false 或有备份目录 → 写 past + base）
           有备份目录？ 先写 past 再写 base
      否 → copy base 内容 → past（保留上一代）
           再写新内容 → base
  → allKeys 去重登记，resolve 原始 value
```

**SafeWrite（原子写，0.3.0 核心）**：所有落盘走"写 `<目标>.tmp.<pid>.<序号>` → fsync 临时文件 → rename 到目标 → fsync 目录（POSIX）"。因此：

* 崩溃/断电只可能留下无害的 tmp 残留，读者永远不会看到截断或空文件（旧实现是 truncate+write，崩溃窗口内文件为空/半截，会被读路径误判为损坏）。
* rename 在 Windows 上遇杀软占用产生的瞬时 EPERM/EACCES/EBUSY 按 25ms→800ms 指数退避重试。
* 同一目标路径的写操作在进程内按路径排队（SafeWrite 内置 per-path 队列），消除并发 rename 替换同一文件的 EPERM 竞争；不同文件完全并行。

**durability 等级（0.4.0）**：构造第 4 参 `{durability: 'strict' | 'relaxed'}`（默认 strict，行为同上）。`relaxed` 跳过两次 fsync 但保留原子 rename：文件不会撕裂，断电可能丢最近数百 ms 的写（OS 页缓存级别的承诺）；实测 Windows 上 insert ~3×、update ~2×。恢复路径（Keys 自愈重写）恒为 strict。

**备份拷贝（0.4.0）**：更新路径的 base→past 拷贝是 `fs.copyFile` 内核级字节拷贝——按字节保存上一代（损坏字节也原样保留，由读路径判定与自愈），任何 IO 失败（含源文件在检查后消失的竞争）都会让本次写整体失败，不再静默跳过。

## 4. 读取路径与自愈（getItem / fetchIndex）

```
读 <key>.db → JSON.parse 成功 → 返回文档
  失败/文件缺失 → 检查 states/<key>/past
      past 可解析 → copy 回 base（恢复），返回 past 数据
      past 不可解析 → 删除 base + past + 备份目录，从 allKeys 移除（文档确实丢了）
      无备份目录 → 删除 base，从 allKeys 移除
```

读操作**有副作用**（可能删除文件、修改 allKeys 缓存），这是设计上的自愈机制。0.3.0 起由按 key 串行化保证自愈不会与写入竞争（见下）。由于写入是原子的，自愈只在外部损坏（磁盘坏块、同步工具、手工编辑）时触发。

## 5. 并发模型（0.3.0）

三层机制：

1. **KeyedQueue（按 key 串行）**：`setItem`/`getItem`/`removeItem`/`storeIndex`/`fetchIndex`/`removeIndex`/`exists` 在方法入口按 key 入队。同一 key 的操作严格按提交顺序执行；不同 key 完全并行。效果：
   - 同 key 并发写 → past 语义严格成立（past 一定是某个真实上一代，而非交错产物）；
   - 读自愈（删文件）不会与该 key 的在途写入交错；
   - `allKeys` 的增删不会交错撕裂。
2. **SafeWrite（按路径串行）**：utils 层面同一文件路径的写排队（见上），兜底直接调用 utils 的场景。
3. **mapPool（有界并发池，IO_LIMIT=128）**：`keys()`/`iterate()`/`collectionSanitize()`/`ClearDirectory` 等全集合扫描不再无界 `Promise.all`（10 万文件会耗尽 fd），最多同时打开 128 个文件；扫描中发现损坏文档时的恢复动作会**转入该 key 的队列**执行，不与写入竞争。

**keys() 缓存校验**：内存 `allKeys` 缓存只在"磁盘文件名集合与缓存完全一致"时被直接信任；否则触发全量扫描（顺带完成损坏恢复）。旧的"文件数量相等即信任"启发式在插入+删除恰好抵消时会返回过期结果，已移除。

**clear()**：先等待所有在途排队操作结束（队列 barrier），再递归删除集合目录，然后重建目录骨架并清空 `allKeys`——clear 之后实例仍可继续使用。

## 6. 大数据特征与已知限制

| 特征 | 说明 |
|---|---|
| 每文档一文件 | 插入吞吐受限于小文件创建 + fsync。lazyBackup（0.6.0 默认开）后首写为 1 次 fsync，更新为 1 次拷贝 + 1 次 fsync（实测 Windows 基线见 docs/OPTIMIZATION.md，可用 `TEDB_LARGE_N` 调大规模） |
| 索引整体重写 | 每次 `saveIndex` 重写整个索引 JSON，成本随集合规模线性增长——建议低频持久化 |
| 无读缓存 | persist-only 设计，每次读都走磁盘（OS 页缓存兜底） |
| key 不能含 `.` | 文件名→key 取第一个 `.` 之前的部分 |
| allKeys 内存优先 | `keys()` 返回内存缓存 ∪ 磁盘扫描；外部直接删文件后，缓存中的 key 仍会返回（直到实例重建或 sanitize） |
| 多进程 | 原子写保证单文件一致性，但队列/缓存都是进程内的——多进程并发写同一目录不受串行化保护 |

## 7. 相对 0.2.1 的行为变化清单

1. **修复 master 分支致命缺陷**：`initDir()` 从未被调用导致 `collectionPath`/`allKeys`/`version` 未初始化，整个驱动不可用。目录引导已移回构造器；构造器签名 `(db, collection, dir?: string)`，第 3 参类型修正为字符串。
2. **修复 Keys 恢复路径崩溃**：`SafeWrite` 曾收到对象而非字符串（必抛 TypeError）。
3. **错误不再被吞**：`safeReadFile` 仅对 ENOENT 返回 `false`；`UnlinkFile`/`RmDir` 仅容忍 ENOENT，其余错误上抛。旧的"一切错误当文件不存在"会掩盖真实故障。
4. **iterate 回调契约修正为 (value, key)**：与 tedb Datastore 实际消费顺序一致（旧类型声明写反）；回调返回真值可中断迭代。
5. **StoreIndex 控制流理顺**：删除 base 存在分支后的冗余二次写；空索引判定 `indexCheck` 改为 parse 后结构判断（旧字符串字面量比较对空白/键序脆弱）。
6. **Linux 数据目录修正**：`~/local/share` → `~/.local/share`；移除无效的 `win64` 平台判断。
7. **"无值"解析值**：`Promise<null>` 契约的方法现在如约 resolve `null`（旧代码 resolve `undefined`）。对调用方均为 falsy，无实质影响。
8. **`parseJSON` 数组分支笔误修复**；`package.json` 仓库 URL typo 修复；`main`/`types` 指向 tsc 实际产物（`dist/index.js` / `dist/index.d.ts`），webpack/babel 构建链移除。

### 0.4.0 增量

9. **CopyFile 改为内核拷贝且失败必上抛**（正确性）：旧的"源不可解析就静默跳过"会无声破坏"past 是 base 上一代"的备份不变量。现在按字节精确复制（损坏字节也保留，自愈语义不变），IO 失败使整个写失败。
10. **durability 等级选项**：`{durability: 'relaxed'}` 跳过 fsync 保留原子 rename（见 §3）。
11. **allKeys 伴随 Set**：`trackKey`/`untrackKey` 维护 `allKeysSet`，写查重 O(1)；GetItem/RemoveItem/CollectionSanitize 的删除路径不再整体重建数组。

## 8. 测试与构建

```bash
pnpm test   # 17 套件 / 85 用例（jest）
pnpm build  # Vite 8 lib 模式 -> dist/index.js（CJS）+ d.ts
```

| 分层 | 覆盖 |
|---|---|
| `spec/unit/` | CRUD 与备份语义、损坏恢复（各排列）、索引持久化、keys/iterate/exists/sanitize/clear、原子写、错误语义、KeyedQueue/mapPool |
| `spec/concurrency/` | 同 key 50 路并发写、100 key × 5 轮并发更新、混合读写、扫描与写入竞争、索引并发 |
| `spec/large/` | 3000（`TEDB_LARGE_N` 可调至 10 万；`pnpm test:large` 单独跑）条批量插入/keys/iterate/更新/删除 + tmp 残留检查 |
| `spec/integration/` | tedb Datastore 真实集成冒烟（未安装 tedb 时自动跳过） |

所有测试通过第 3 个构造参数在 `os.tmpdir()` 隔离运行（旧测试直接写用户主目录）。
