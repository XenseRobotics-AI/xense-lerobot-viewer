# Xense LeRobot Viewer 学习文档索引

这个目录收集 `xense-lerobot-viewer` 的基础核心学习文档。写法参考
`/home/chuang/xense/xense-taccap-lerobot/docs`：先解释概念，再串源码链路，最后给出
可验证的阅读路径。

本项目不是采集工具，而是一个 **本地 LeRobot 数据集可视化器**：

- 从本机 `LOCAL_DATASET_ROOT` 扫描 LeRobot 数据集。
- 读取 `meta/info.json`、`data/**/*.parquet` 和 `videos/**`。
- 在浏览器里同步播放多路视频和 telemetry 曲线。
- 提供统计、Action Insights、Doctor、Annotations、Subtasks、Parquet 原表和 URDF 3D 回放。

## 推荐阅读顺序

1. [GLOSSARY.md](./GLOSSARY.md)：先补齐术语，比如 `repoId`、`encodedPath`、parquet、v3.0 分片视频。
2. [project-overview-讲解.md](./notes/project-overview-讲解.md)：理解项目定位、目录分层和运行方式。
3. [local-dataset-flow-讲解.md](./notes/local-dataset-flow-讲解.md)：理解首页如何发现数据集、API 如何安全读取本地文件。
4. [episode-viewer-讲解.md](./notes/episode-viewer-讲解.md)：理解打开一个 episode 后，视频、曲线、tab、播放时间如何协作。
5. [diagnostics-and-3d-replay-讲解.md](./notes/diagnostics-and-3d-replay-讲解.md)：理解 Doctor 诊断、Action Insights 和 URDF 回放。

## 核心源码地图

| 主题                   | 入口源码                                                                                                                                                                            | 配套讲解                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 项目结构与运行         | [README.md](../README.md)、[package.json](../package.json)                                                                                                                          | [project-overview-讲解.md](./notes/project-overview-讲解.md)                   |
| 本地数据集扫描         | [local-datasets-discovery.ts](../src/lib/local-datasets-discovery.ts)、[api/local-datasets/route.ts](../src/app/api/local-datasets/route.ts)                                        | [local-dataset-flow-讲解.md](./notes/local-dataset-flow-讲解.md)               |
| 本地文件读取与安全边界 | [local-dataset-paths.ts](../src/lib/local-dataset-paths.ts)、[[...filePath]/route.ts](../src/app/api/local-datasets/%5BencodedPath%5D/%5B...filePath%5D/route.ts)                   | [local-dataset-flow-讲解.md](./notes/local-dataset-flow-讲解.md)               |
| episode 数据加载       | [fetch-data.ts](../src/app/%5Borg%5D/%5Bdataset%5D/%5Bepisode%5D/fetch-data.ts)                                                                                                     | [episode-viewer-讲解.md](./notes/episode-viewer-讲解.md)                       |
| 播放同步               | [time-context.tsx](../src/context/time-context.tsx)、[simple-videos-player.tsx](../src/components/simple-videos-player.tsx)、[playback-bar.tsx](../src/components/playback-bar.tsx) | [episode-viewer-讲解.md](./notes/episode-viewer-讲解.md)                       |
| 诊断与 3D 回放         | [doctor-panel.tsx](../src/components/doctor-panel.tsx)、[doctor/runner.ts](../src/lib/doctor/runner.ts)、[urdf-viewer.tsx](../src/components/urdf-viewer.tsx)                       | [diagnostics-and-3d-replay-讲解.md](./notes/diagnostics-and-3d-replay-讲解.md) |

## 最小启动流程

```shell
bun install
LOCAL_DATASET_ROOT=/path/to/lerobot bun dev
```

打开 `http://localhost:3000`。如果没有设置 `LOCAL_DATASET_ROOT`，项目默认扫描：

```text
~/.cache/huggingface/lerobot
```

期望的数据集结构：

```text
<LOCAL_DATASET_ROOT>/
  <org-or-source>/<dataset-name>/
    meta/info.json
    data/...
    videos/...
```

## 学习时的主线

这个 viewer 可以按一条数据链路理解：

```text
磁盘上的 LeRobot 数据集
  -> 首页扫描 meta/info.json
  -> 生成 local: repoId 和 /_local/<encodedPath> 路由
  -> API 安全读取 parquet / json / video
  -> fetch-data.ts 组装 EpisodeData
  -> EpisodeViewer 渲染视频、曲线和各类分析 tab
  -> TimeContext 保持视频、滑条、图表、URDF 回放同步
```

先把这条链路跑通，再看具体 tab 的实现，阅读成本会低很多。
