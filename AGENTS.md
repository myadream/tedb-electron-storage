# AGENTS.md — tedb-electron-storage

给 AI 编码代理的项目须知。本包是 [TeDB](https://github.com/tedb-org/teDB)(类 MongoDB 嵌入式文档库)的**文件存储适配器**:tedb 负责内存索引与查询,本包负责全部磁盘 IO——形态是**只追加段日志**(bitcask 式,0.8.0 起唯一引擎;历史 files 引擎已于 0.8.0 移除)。Electron/Node 环境,TypeScript。

## 常用命令(用 pnpm,不要用 npm/yarn)

```bash
pnpm install
pnpm typecheck        # tsc --noEmit,每次改动后必须过
pnpm test             # 全量(unit + concurrency + large + integration)
pnpm test:coverage    # 快速层 + 覆盖率阈值门禁,每次改动后必须过
pnpm build            # vite lib 模式 -> dist/(CJS bundle + d.ts)
```

覆盖率阈值在 `jest.config.js`(语句 95 / 分支 88 / 函数 92 / 行 95),`test:coverage` 低于阈值会直接 fail——新增源码分支时必须同步补测试。

## 代码地图

三层分层:**StorageDriver**(驱动契约/队列)→ **Engine**(引擎抽象,驱动只依赖 IEngine 接口 + createEngine 工厂)→ **LogEngine**(段日志实现,按业务一文件)。新增引擎 = 新增一个实现 IEngine 的目录并接到 createEngine,驱动零改动。

```
src/
├── StorageDriver/
│   ├── Driver.ts             ElectronStorage 类:per-key operationQueue 入口 + withEngine + allKeys 镜像
│   └── IndexCheck.ts         空索引占位符判定(公开导出)
├── Engine/                   引擎抽象层(驱动唯一依赖)
│   ├── IEngine.ts               IEngine 接口 + IEngineOptions + IEngineValue
│   └── index.ts                 createEngine 工厂(应用默认值 → LogEngine.open)
├── LogEngine/                段日志引擎实现(0.8.0),按业务一文件
│   ├── index.ts                 open():组装 state → 返回 IEngine
│   ├── state.ts                 ILogState 状态袋 + createState(mkdir → recover)
│   ├── manifest.ts              manifest 原子重写 + pid 存活检测
│   ├── recover.ts               启动恢复(段扫描/pid 锁/孤儿清理/撕裂尾截断)
│   ├── append.ts                写链 run / appendRecord / rollSegment
│   ├── read.ts                  tryRead / tryReadRaw(CRC + parse 判损)
│   ├── Compact.ts               触发判定 / compact(提升 prev、双坏删 key)/ 读屏障
│   ├── SetItem.ts               写入(移 prev 槽 + 组提交 + 触发压实)
│   ├── GetItem.ts               读取(损坏自愈:prev 重写为新 gen)
│   ├── RemoveItem.ts            dropKey(tombstone)
│   ├── Iterate.ts               扫描 + 逐 key 修复
│   ├── Keys.ts / Exists.ts      纯 keydir 查询(零 IO)
│   ├── CollectionSanitize.ts    tedb 对账(未知 key 删除)
│   ├── Clear.ts                 清空重建
│   ├── records.ts               19 字节头记录编解码(CRC32) + LogRecordError
│   └── sync.ts                  GroupSync 组提交(strict 三触点 / relaxed 1s 兜底)
├── utils/                    fs 的 Promise 封装;SafeWrite(manifest 原子写)、
│                             KeyedQueue(串行化)、mapPool(公开工具)
├── AppDirectory/             按平台决定数据根目录(自定义 dir 优先)
└── types/                    IStorageDriver / IElectronStorageOptions 等
```

详尽的数据流与并发模型见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)(log 引擎行为契约在 §2–§8)。

## 磁盘布局契约(测试和恢复逻辑都依赖它)

```
<dataDir>/<db>/db/<collection>/
├─ manifest.json              段清单 + pid + nextGen + checkpoint(SafeWrite 原子写)
└─ segments/seg-000001.log    只追加记录流(19B 头: CRC32‖gen‖keyLen‖valueLen‖flags)
```

- **所有落盘改动走两条路**:记录追加过 `LogEngine` 的写链(串行),manifest 走 `SafeWrite`(原子写)。禁止绕过 `LogEngine` 直接改段文件或手拼记录。
- **备份语义在 keydir**:prev 槽 = 上一代(`logHistory: 1` 默认);tombstone 保证删除跨重启不复活;"双坏删 key"判定与历史 files 引擎一致。
- **pid 检测**:manifest 记录持有者,打开时异存活 PID 拒绝(`collectionInUse`);崩溃残留(已死)接管。
- **上限**:value ≤ 4 MiB、key ≤ 65535 utf8 字节(超限拒写)、段数软上限 128(强制压实)、keydir 定位 ≤ 10 万 key。

## 关键不变量(改动必须保持)

1. **原子可见性**:读永远看不到半条记录(CRC + keydir 单点切换);append 必须过写链,禁止并发交错。
2. **per-key 串行**:同 key 的写/读/删经 `operationQueue.enqueue(key, ...)`;恢复动作(修复/丢 key)必须经同队列与在途写互斥。
3. **恢复语义矩阵**:current CRC/parse 坏 + prev 可读 → prev 重写为新 gen(strict)恢复;双坏 → tombstone + 删 key;`exists` 纯内存判定、从不复活;压实遇到双坏同样删 key,单坏提升 prev。
4. **durability**:`'strict'` 组提交 fsync / `'relaxed'` 1s 兜底;恢复写恒为 strict。
5. **错误前缀**:utils 错误信息以 `:::Storage::: <方法名> Error. ` 开头;`safe*` 系列仅在 ENOENT 时 resolve(false),其余错误必须 reject(按 `err.code` 判断,勿用 `errno`)。

## 测试规则

- 一律用 `spec/helpers.ts` 的 `setupStorage()`(隔离临时目录);**禁止**不带 `dir` 参数构造 `ElectronStorage`——会写进真实 OS 用户目录。
- log 引擎夹具:`setupStorage(db, col, {logSegMaxBytes: 200, logCompactDeadRatio: 0, ...})` 调小参数制造滚动/压实;损坏注入用"按 `decodeRecordAt` 找记录边界 → 翻转边界字节";`logManifest`/`logSegmentsDir` helper 定位布局。
- 崩溃语义测试进 `spec/unit/logEngine/logRecovery.spec.ts`(golden 截断矩阵在那);压实语义进 `logCompact.spec.ts`。
- AppDirectory 平台分支用 `jest.mock('os')` 工厂(mock 掉 platform,保留其余导出)。
- 已接受的未覆盖分支(竞态窗口、需故障注入的错误臂)列在 [docs/TESTING.md](docs/TESTING.md) 末尾,不必强行覆盖。

## 陷阱

- **CRC 损坏不改变记录长度**——死字节账目看不见,压实触发要用真实换代(第三次覆盖)腾死字节;测试断言前先 `getItem` 一次等压实落地(`compacting` 屏障)。
- **history: 1 下单次覆盖不产生死字节**(换出代成为 prev 仍算活),第三代才腾出。
- **压实拷贝必须同 key 按 gen 升序**(prev 在前),否则重启重建时新旧颠倒。
- Windows 上对已存在文件的并发 rename 会 EPERM——manifest 走 SafeWrite 内建重试,别绕过它。
- 大规模套件(`spec/large`)慢,日常迭代用 `test:coverage`;提交前跑全量。
- 父目录 `obsidian-language-learner` 是 Obsidian 插件仓库;本包在其 `package/` 下且是**独立 git 仓库**,提交只在本仓库内进行。

## 文档索引

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构、段日志契约、并发模型、恢复语义(§2–§8)
- [docs/TESTING.md](docs/TESTING.md) — 测试分层、损坏注入规范、新增测试规范
- [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) — 历史优化记录与 backlog
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录
