# 项目总览从零讲解

> 面向第一次接触 `xense-lerobot-viewer` 的读者。建议配合
> [README.md](../../README.md)、[package.json](../../package.json) 和
> [CLAUDE.md](../../CLAUDE.md) 阅读。

## 0. 这个项目是做什么的

一句话：**把本机磁盘上的 LeRobot 数据集打开，在浏览器里检查视频、曲线、统计、标注、
原始 parquet 和 3D 回放。**

它和 TacCap 采集仓库的关系：

| 项目                   | 主要问题                                     | 是否需要硬件 |
| ---------------------- | -------------------------------------------- | ------------ |
| `xense-taccap-lerobot` | 如何实时采集、录制、转换和检查 TacCap 数据集 | 采集时需要   |
| `xense-lerobot-viewer` | 如何读已经落盘的数据集，并做交互式检查       | 不需要       |

所以本项目的学习重点不是“如何控制设备”，而是：

- 如何找到本地数据集。
- 如何安全读本地文件。
- 如何把 parquet / video / metadata 组装成页面数据。
- 如何保持视频、曲线和 3D 回放同步。
- 如何把诊断和人工标注结果保存成 sidecar。

## 1. 从命令到页面的最短路径

```shell
bun install
LOCAL_DATASET_ROOT=/path/to/lerobot bun dev
```

打开 `http://localhost:3000` 后，整体流程是：

```text
浏览器请求 /
  -> src/app/page.tsx 渲染首页
  -> 首页调用 /api/local-datasets
  -> src/lib/local-datasets-discovery.ts 扫描 LOCAL_DATASET_ROOT
  -> 找到每个 meta/info.json
  -> 返回 LocalDatasetSummary[]
  -> 首页展示 dataset card
  -> 点击某个数据集
  -> 进入 /_local/<encodedPath>/episode_0
  -> EpisodeViewer 加载当前 episode 的视频、曲线和分析入口
```

如果不设置 `LOCAL_DATASET_ROOT`，默认扫描：

```text
~/.cache/huggingface/lerobot
```

## 2. 目录结构先看四层

初学时不用一口气读完整个 `src/`。先按职责分成四层：

| 层         | 目录             | 作用                                                 |
| ---------- | ---------------- | ---------------------------------------------------- |
| 页面层     | `src/app`        | Next.js 页面和 API route。                           |
| 组件层     | `src/components` | 视频播放器、图表、面板、URDF viewer 等 UI。          |
| 业务服务层 | `src/lib`        | 本地目录扫描、路径安全、Doctor、parquet 服务端读取。 |
| 工具层     | `src/utils`      | 路由编码、版本判断、parquet URL、数据处理、纯函数。  |

一个常见读法是：

```text
src/app/page.tsx
  -> src/lib/local-datasets-discovery.ts
  -> src/app/%5Flocal/[encodedPath]/[episode]/page.tsx
  -> src/app/[org]/[dataset]/[episode]/episode-viewer.tsx
  -> src/app/[org]/[dataset]/[episode]/fetch-data.ts
```

注意磁盘目录里的 `%5Flocal` 是 URL 编码后的 `_local`。浏览器里看到的是 `/_local/...`。

## 3. 为什么项目内部还叫 repoId

这个 viewer 最初兼容过 Hugging Face Hub 的远程数据集路径，很多内部接口习惯用
`repoId`。当前本地化后，`repoId` 被包装成：

```text
local:<dataset-relative-path>
```

例如：

```text
local:lerobot/svla_so101_pickplace
```

这保留了原来的函数签名，减少了重构面。真正拼本地文件 API 时，会通过
`src/utils/datasetRoute.ts` 转换：

```text
local:lerobot/svla_so101_pickplace
  -> relative path: lerobot/svla_so101_pickplace
  -> encodedPath: bGVyb2JvdC9zdmxhX3NvMTAxX3BpY2twbGFjZQ
  -> /api/local-datasets/<encodedPath>/meta/info.json
```

读代码时要记住：**这里的 repoId 不是一定代表远端仓库，它更像数据集 ID。**

## 4. 页面功能按 tab 理解

Episode Viewer 打开后主要有这些 tab：

| Tab             | 作用                            | 主要源码                                           |
| --------------- | ------------------------------- | -------------------------------------------------- |
| Episodes        | 多路视频 + 数值曲线同步播放     | `simple-videos-player.tsx`、`data-recharts.tsx`    |
| Annotations     | 语言 atom 标注                  | `annotations-panel.tsx`、`annotations-context.tsx` |
| Statistics      | episode 长度、基础统计          | `stats-panel.tsx`、`fetch-data.ts`                 |
| Frames          | 按相机浏览每个 episode 的帧范围 | `overview-panel.tsx`                               |
| Action Insights | 跨 episode 动作质量分析         | `action-insights-panel.tsx`                        |
| Doctor          | 结构化数据集诊断                | `doctor-panel.tsx`、`src/lib/doctor`               |
| Filtering       | 按问题 episode 生成筛选操作     | `filtering-panel.tsx`                              |
| 3D Replay       | URDF 三维回放                   | `urdf-viewer.tsx`                                  |
| Parquet         | 原始 parquet 表格浏览           | `parquet-table-panel.tsx`                          |

这些 tab 共享同一个 `EpisodeData` 和同一个 `TimeContext`。区别只是有些 tab 会懒加载更重的
统计数据，避免首屏打开太慢。

## 5. 本项目的几个设计原则

### 5.1 浏览路径 local-only

正常浏览、解析和播放只读本地文件。`buildVersionedUrl()` 对非本地 `repoId` 会直接抛错，
避免偷偷走远端。

例外有两个：

- 首页手动 Sync，会在用户明确点击后调用 Python 脚本下载 Hub 数据。
- 首页会写 `.xense-viewer/corpus-history.json`，用于记录 corpus 增长趋势。

### 5.2 原始数据尽量只读

多数功能不改 parquet：

- Tags 写 `meta/xense_tags.json`。
- Annotations 写 `meta/lerobot_annotations.json`。
- Subtasks 写 `meta/annotations.json`，导出时才会改 parquet。
- Doctor 默认只读诊断，不做自动修复。

这样做的好处是：检查和标注可以快速迭代，不会轻易破坏原始训练数据。

### 5.3 重数据懒加载

视频和当前 episode 曲线是核心首屏；跨 episode 统计、Doctor、Parquet 浏览都可能比较重，
所以通常在切到对应 tab 时才加载。

`episode-viewer.tsx` 里可以看到这种模式：

```text
activeTab 切换
  -> loadStats / loadFrames / loadInsights
  -> 对应 panel 渲染结果
```

### 5.4 纯函数优先放 utils

例如路径编码、字符串模板、统计聚合、parquet cell 格式化等，都尽量写成可测试的纯函数。
这种模式让边界清晰：React 组件管交互，`utils` 管可复用规则，`lib` 管 Node 侧能力。

## 6. 新人阅读建议

第一次读源码时，建议不要从 React 组件细节开始。更稳的顺序是：

1. 先看 `src/utils/datasetRoute.ts`，理解本地路径如何变成 URL。
2. 再看 `src/lib/local-datasets-discovery.ts`，理解首页数据从哪来。
3. 再看 `src/app/[org]/[dataset]/[episode]/fetch-data.ts`，理解一个 episode 怎么被读出来。
4. 最后看 `episode-viewer.tsx` 和具体组件，理解 UI 如何消费这些数据。

如果把项目想成一个流水线，`fetch-data.ts` 就是最值得先读的中间站：它连接了数据格式和 UI。
