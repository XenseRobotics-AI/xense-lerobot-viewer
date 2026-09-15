# 术语表

本文解释本项目文档中反复出现的核心概念。它不替代源码讲解，只提供阅读时需要的背景。

## 项目与运行

| 术语                     | 解释                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| LeRobot                  | Hugging Face 的机器人学习数据集和训练生态。本项目主要读取它的本地数据集格式。                   |
| local-only               | 本 viewer 的浏览、解析、播放路径只读本地磁盘，不从 Hub 远程拉数据。首页的手动 Sync 是显式例外。 |
| Bun                      | 本仓库使用的包管理器和测试运行器。命令是 `bun install`、`bun dev`、`bun test`。                 |
| Next.js                  | 前端和 API route 框架。页面在 `src/app`，服务端 API 也在 `src/app/api`。                        |
| client component         | 带 `"use client"` 的 React 组件，可以使用浏览器状态、视频元素和事件监听。                       |
| server route / API route | Next.js 的服务端接口，用来扫描本地目录、读取文件、运行 Doctor、保存 sidecar。                   |

## 本地数据集定位

| 术语                             | 解释                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `LOCAL_DATASET_ROOT`             | 服务端读取的本地 LeRobot 数据集根目录。优先级最高。                                                            |
| `NEXT_PUBLIC_LOCAL_DATASET_ROOT` | 可被服务端和客户端读取的数据集根目录配置。                                                                     |
| 默认根目录                       | 未显式配置时使用 `${HOME}/.cache/huggingface/lerobot`。                                                        |
| dataset relative path            | 数据集相对根目录的路径，例如 `lerobot/svla_so101_pickplace`。                                                  |
| `encodedPath`                    | dataset relative path 的 base64url 编码，用在 `/_local/<encodedPath>` 和 `/api/local-datasets/<encodedPath>`。 |
| `repoId`                         | 项目内部沿用的仓库标识。当前本地数据集写成 `local:<relative-path>`。                                           |
| `_local` 路由                    | 本地数据集的页面入口。`/_local/<encodedPath>/episode_0` 会打开第 0 个 episode。                                |

## LeRobot 数据集格式

| 术语                         | 解释                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `meta/info.json`             | 数据集总说明，包含版本、fps、episode 数、frames 数、features、data/video path 模板。  |
| feature                      | 数据表字段定义。例如 `action`、`observation.state`、`observation.images.left_wrist`。 |
| `dtype`                      | feature 的数据类型，例如 `float32`、`video`、`image`。                                |
| `shape`                      | feature 的形状，例如状态向量 `[20]` 或图像 `[480, 640, 3]`。                          |
| `names`                      | 向量维度的名字，例如 `left_tcp.x`、`right_gripper.pos`。图表和 3D 回放会依赖它。      |
| parquet                      | 列式表格文件。LeRobot 的 `data/**/*.parquet` 通常一行是一帧。                         |
| `data/**/*.parquet`          | episode 的逐帧数据，包含 action、observation.state 和图像引用等。                     |
| `videos/**`                  | 视频文件目录。`video` dtype 的相机数据会编码成 mp4 等文件。                           |
| `meta/episodes/**/*.parquet` | v3.0 数据集的 episode 账本，记录 episode 属于哪个 data/video shard 和行范围。         |
| chunk / file                 | LeRobot 的分片概念，用于避免单个 parquet 或视频过大。                                 |

## 版本差异

| 术语            | 解释                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| v2.0 / v2.1     | 一般是每个 episode 拥有独立 parquet 和视频文件。路径由 `info.data_path` 模板计算。                            |
| v3.0            | 多个 episode 可共享一个 data parquet 和一组分片视频，通过 `meta/episodes` 记录行范围和视频时间段。            |
| segmented video | v3.0 中视频文件可能包含多个 episode 的连续片段。播放时需要用 `segmentStart` / `segmentEnd` 截出当前 episode。 |
| row range       | 从共享 parquet 中只读取当前 episode 的 `[dataset_from_index, dataset_to_index)` 行。                          |
| BigInt          | parquet 里的整数读出后可能是 `bigint`，需要转成安全的 JS number 后再用于 UI。                                 |

## Viewer UI

| 术语            | 解释                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| Episode Viewer  | 打开某个 episode 后的主界面，包含视频、图表、侧边 episode 列表和多个 tab。              |
| `EpisodeData`   | `fetch-data.ts` 返回给前端的主数据包，包含视频信息、曲线数据、任务、episode 列表等。    |
| chart data      | 供 Recharts 渲染的时间序列数据。通常来自 `action`、`observation.state` 等数值 feature。 |
| flat chart data | 扁平化后的时间序列行，适合 Action Insights、过滤和 3D pose 类逻辑复用。                 |
| `TimeContext`   | 全局播放时间上下文。视频、播放条、图表点击、URDF 回放都通过它同步。                     |
| primary video   | 当前可见视频里第一个视频。它负责把真实播放时间回报给 `TimeContext`。                    |
| external seek   | 用户拖动滑条、点击图表或代码主动 seek。会推动所有视频跳到同一 episode 时间。            |

## 分析与标注

| 术语            | 解释                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Action Insights | 跨 episode 的动作统计面板，用于发现低运动、抖动、速度分布和对齐问题。                                 |
| Doctor          | 本地 TypeScript 数据集诊断器，检查 metadata、文件、视频结构、动作连续性、训练准备度等。               |
| flagged episode | 被用户或分析工具标记的问题 episode，可用于后续筛选或导出处理命令。                                    |
| Annotations     | 语言 atom 标注界面，使用 `meta/lerobot_annotations.json` sidecar 保存。                               |
| Subtasks        | Pi-style 子任务区间标注，使用 `meta/annotations.json` JSONL sidecar，可导出为训练用 `subtask_index`。 |
| sidecar         | 附加在 `meta/` 下的本项目 JSON/JSONL 文件，不直接改写原始 parquet。                                   |

## 3D 与姿态

| 术语                      | 解释                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| URDF                      | 机器人结构描述文件，定义 link、joint、mesh 和关节树。                       |
| mesh                      | 机器人外观几何，一般是 STL/DAE/OBJ 等文件。                                 |
| 3D Replay                 | 根据 episode 的关节或姿态数据，在 Three.js 中同步回放机器人状态。           |
| SO-100 / SO-101 / OpenArm | 当前 viewer 支持的机器人类型之一，能进入 URDF 回放路径。                    |
| 6D rotation               | 用 `r1..r6` 表示旋转矩阵前两列，常见于机器人学习中的连续姿态表示。          |
| TCP                       | Tool Center Point，末端执行器位置/姿态，例如 `left_tcp.x`、`right_tcp.r1`。 |
