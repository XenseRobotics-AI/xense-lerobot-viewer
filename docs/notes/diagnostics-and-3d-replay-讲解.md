# 诊断与 3D 回放链路讲解

> 主要源码：
> [action-insights-panel.tsx](../../src/components/action-insights-panel.tsx) ·
> [doctor-panel.tsx](../../src/components/doctor-panel.tsx) ·
> [src/lib/doctor](../../src/lib/doctor) ·
> [urdf-viewer.tsx](../../src/components/urdf-viewer.tsx) ·
> [so101-robot.ts](../../src/lib/so101-robot.ts)

## 0. 这几个功能解决什么问题

Episode tab 主要回答：“这一集看起来怎么样？”

诊断和 3D 回放回答更深的问题：

- 数据集结构是否完整，能不能训练？
- 动作是否有异常、低运动、抖动或对齐问题？
- 机器人关节/末端轨迹在 3D 空间里是否合理？
- 哪些 episode 应该被标记出来，后续过滤或重录？

可以分成三类：

| 功能            | 数据范围                        | 典型用途                                      |
| --------------- | ------------------------------- | --------------------------------------------- |
| Action Insights | 跨 episode 的 action/state 统计 | 找低运动、jerky episode、速度分布异常         |
| Doctor          | 数据集结构和质量诊断            | 判断 metadata、文件、视频、动作连续性是否可靠 |
| 3D Replay       | 当前 episode 的机器人状态回放   | 直观看关节映射和动作是否符合物理直觉          |

## 1. Action Insights 怎么读数据

入口在 `episode-viewer.tsx` 的 `loadInsights()`：

```text
切到 Insights
  -> getDatasetVersionAndInfo(repoId)
  -> loadCrossEpisodeActionVariance(repoId, version, info, fps)
  -> setCrossEpData(result)
  -> ActionInsightsPanel 渲染
```

`loadCrossEpisodeActionVariance()` 在 `fetch-data.ts` 里，核心思路是：

```text
选取一批 episode
  -> 读取每个 episode 的 action
  -> 对每集内部再采样，限制最大帧数
  -> 计算跨 episode 方差、速度、低运动、抖动、自相关、alignment 等
  -> 返回 CrossEpisodeVarianceData
```

为什么要采样：

- 全量读取所有 episode 的所有帧会很重。
- 质量分析通常看趋势和异常，不需要每个原始点都进入 UI。
- 采样上限通过环境变量控制，例如 `MAX_CROSS_EPISODE_SAMPLE`。

Action Insights 的结果可以和 flagged episode workflow 结合，把问题 episode 送到后续过滤面板。

## 2. Doctor 的定位

Doctor 是更系统的诊断器。它不是一个 UI 里临时拼出来的统计，而是一套 TypeScript 检查引擎：

```text
DoctorPanel
  -> POST /api/local-datasets/<encodedPath>/doctor
  -> src/lib/doctor/runner.ts
  -> src/lib/doctor/loader.ts 读取 metadata / parquet / video 信息
  -> src/lib/doctor/checks/* 执行检查
  -> 返回 DoctorReport
```

Doctor 的特点：

- 本地运行，不依赖远程服务。
- TypeScript 实现，不需要 Python bridge。
- 默认只读，不自动修复数据集。
- 报告结构化，UI 可以按 PASS/WARN/FAIL 展示。

典型检查范围包括：

| 范围               | 说明                                                |
| ------------------ | --------------------------------------------------- |
| metadata           | `info.json`、features、episode 数、fps 等是否一致。 |
| files              | `data/`、`videos/`、metadata shard 是否存在。       |
| parquet            | 行数、列、episode row range 是否可读。              |
| video              | mp4 容器结构、轨道、时长和采样信息。                |
| actions            | 动作连续性、维度跳变、异常值。                      |
| speeds             | 可选 TCP 线速度/角速度阈值检查。                    |
| training readiness | 是否具备训练所需的基础结构。                        |

## 3. Doctor 为什么在 Node 侧跑

Doctor 要读本地文件、stat 文件、解析 parquet 和视频结构。浏览器做这些事有几个问题：

- 浏览器不能直接访问任意本地路径。
- 把大 parquet 下载到浏览器再解析会浪费内存和带宽。
- 路径安全必须由服务端统一控制。

所以 Doctor route 在 Node.js runtime 中运行，读取路径仍通过本项目的本地数据集解析规则。

可以把它理解成：

```text
浏览器只负责发起诊断和展示结果
Node route 负责受控地读取本地数据集
doctor runner 负责把检查规则组织成报告
```

## 4. Doctor 和 Action Insights 的区别

| 维度       | Doctor                          | Action Insights                   |
| ---------- | ------------------------------- | --------------------------------- |
| 目标       | 判断数据集结构和训练准备度      | 分析动作质量和异常 episode        |
| 输出       | PASS / WARN / FAIL 的结构化报告 | 图表、统计列表、可标记 episode    |
| 数据读取   | Node route 统一执行             | `fetch-data.ts` 中跨 episode 读取 |
| 是否偏工程 | 是，重 metadata/files/schema    | 否，更偏运动数据分析              |
| 是否只读   | 是                              | 是                                |

简单判断：

- 数据集打不开、文件缺失、schema 奇怪：先看 Doctor。
- 数据集能打开，但动作质量可疑：看 Action Insights。

## 5. URDF 3D Replay 的基本链路

3D Replay 的入口是 `URDFViewer`。

整体流程：

```text
EpisodeData
  -> datasetInfo.robot_type 判断是否支持 URDF
  -> 当前 episode 的 flat/chart data 提供关节或状态序列
  -> URDF loader 加载 robot 结构和 mesh
  -> TimeContext 提供当前播放时间
  -> 根据 currentTime 采样关节值
  -> Three.js 场景更新 robot pose
```

相关依赖：

| 依赖                 | 用途                            |
| -------------------- | ------------------------------- |
| `three`              | 3D 渲染基础。                   |
| `@react-three/fiber` | React 方式组织 Three.js 场景。  |
| `@react-three/drei`  | 相机控制、辅助组件等。          |
| `urdf-loader`        | 读取 URDF、mesh 和 joint 结构。 |

`src/lib/so101-robot.ts` 负责描述本项目支持哪些 robot type，以及如何把数据集中的列名映射到
URDF joint。

## 6. 3D Replay 最容易出错的地方

### 6.1 robot type 不匹配

如果 `datasetInfo.robot_type` 不在支持列表里，tab 可能不会启用或无法正确映射。

排查：

1. 看 `meta/info.json` 的 `robot_type`。
2. 看 `hasURDFSupport()` 是否支持这个值。
3. 看 `so101-robot.ts` 里的映射规则。

### 6.2 joint 名和 feature 名不匹配

URDF 里用 joint 名；LeRobot 数据集里用 feature names。中间必须有映射。

常见数据列形式：

```text
action | shoulder_pan.pos
observation.state | shoulder_pan.position
observation.state | shoulder_pan.q
```

如果映射只认一种后缀，回放就会缺关节。本项目的映射逻辑通常会容忍 `.pos`、`.position`、
`.q` 等后缀。

### 6.3 时间采样错位

3D 回放必须和视频使用同一个 episode-local time。如果曲线 timestamp 被错误缩放，可能出现：

- 视频已经到某个动作，但 3D marker 还在上一帧。
- v3 segmented video 的片段时间和 parquet timestamp 不一致。

因此读 `fetch-data.ts` 时要关注 timestamp 的来源和 duration 的计算。

### 6.4 mesh 加载慢

URDF mesh 可能比较大。`episode-viewer.tsx` 会在满足条件时提前 import `urdf-viewer`，用于减少用户
第一次点开 3D Replay 的等待时间。

## 7. flagged episode 如何串起来

`FlaggedEpisodesProvider` 是页面级上下文。它让多个面板共享“哪些 episode 被认为有问题”。

典型路径：

```text
Doctor 或 Action Insights 发现问题
  -> 用户把 episode 加入 flagged
  -> Sidebar / Frames / Filtering 读取 flagged 状态
  -> FilteringPanel 生成后续处理建议
```

这样设计的价值是：不同工具各自发现问题，但最后汇总到同一个人工审核流程。

## 8. 建议阅读顺序

如果只想理解诊断：

1. `doctor-panel.tsx`
2. `src/app/api/local-datasets/[encodedPath]/doctor/route.ts`
3. `src/lib/doctor/runner.ts`
4. `src/lib/doctor/checks/`

如果只想理解 URDF：

1. `episode-viewer.tsx` 里 `URDFViewer` 的挂载条件。
2. `src/lib/so101-robot.ts` 的 robot support 和 joint mapping。
3. `src/components/urdf-viewer.tsx` 的加载、采样和渲染。
4. `src/context/time-context.tsx` 的播放时间来源。

核心判断：**Doctor 负责“数据集是否可信”，Action Insights 负责“动作质量是否可疑”，
URDF Replay 负责“运动在空间中是否符合直觉”。**
