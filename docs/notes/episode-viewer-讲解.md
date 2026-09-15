# Episode Viewer 从零讲解

> 主要源码：
> [episode-viewer.tsx](../../src/app/%5Borg%5D/%5Bdataset%5D/%5Bepisode%5D/episode-viewer.tsx) ·
> [fetch-data.ts](../../src/app/%5Borg%5D/%5Bdataset%5D/%5Bepisode%5D/fetch-data.ts) ·
> [time-context.tsx](../../src/context/time-context.tsx) ·
> [simple-videos-player.tsx](../../src/components/simple-videos-player.tsx) ·
> [playback-bar.tsx](../../src/components/playback-bar.tsx)

## 0. 这个页面是做什么的

一句话：**打开一个 episode，把它的视频、状态/动作曲线、统计分析和标注工具放在同一个时间轴上。**

用户看到的是一个页面，但源码上它分成两段：

```text
fetch-data.ts
  -> 从本地文件 API 读取 metadata / parquet / video 信息
  -> 组装 EpisodeData

episode-viewer.tsx
  -> 接收 EpisodeData
  -> 渲染视频、图表、sidebar 和各个 tab
  -> 用 TimeProvider 统一播放时间
```

## 1. 打开 episode 的整体流程

```text
浏览器访问 /_local/<encodedPath>/episode_0
  -> _local page 把 encodedPath 解成 org/dataset 参数
  -> EpisodeViewer({ org, dataset, episodeId })
  -> getEpisodeDataSafe(org, dataset, episodeId)
  -> getEpisodeData()
  -> getDatasetVersionAndInfo(repoId)
  -> 按 v2/v3 分支读取 parquet 和视频路径
  -> 返回 EpisodeData
  -> TimeProvider(duration)
  -> SimpleVideosPlayer + DataRecharts + 各 tab
```

这里的 `org` 对本地数据集通常是 `_local`，`dataset` 是 encodedPath。`repoIdFromRouteParams()`
会把它还原成：

```text
local:<relative-path>
```

## 2. `EpisodeData` 是页面的数据合同

`fetch-data.ts` 返回的 `EpisodeData` 是前后端之间最重要的数据结构：

| 字段                      | 含义                                                    |
| ------------------------- | ------------------------------------------------------- |
| `datasetInfo`             | 数据集版本、fps、robot type、相机列表等展示信息。       |
| `episodeId`               | 当前 episode 编号。                                     |
| `videosInfo`              | 当前 episode 的视频 URL、是否 segmented、片段起止时间。 |
| `chartDataGroups`         | 分组后的 telemetry 曲线数据，给 Recharts 用。           |
| `velocityChartDataGroups` | 姿态/动作速度衍生曲线。                                 |
| `flatChartData`           | 扁平行数据，给 Insights、过滤、部分分析逻辑复用。       |
| `episodes`                | 可跳转的 episode id 列表。                              |
| `duration`                | 当前 episode 播放时长。                                 |
| `task`                    | 当前 episode 的任务文本。                               |
| `languageAtoms`           | v3.1 语言标注初始数据。                                 |
| `frameTimestamps`         | 原始帧时间戳，用于标注 snap-to-frame。                  |

读 UI 代码时，如果不知道某个组件的数据从哪来，先回到这个结构里找。

## 3. v2 和 v3 的 episode 读取区别

LeRobot v2 和 v3 的最大差异是“episode 是否独占文件”。

### 3.1 v2.0 / v2.1

v2 通常按 episode 组织 parquet：

```text
data/{episode_chunk}/episode_{episode_index}.parquet
videos/{video_key}/{episode_chunk}/episode_{episode_index}.mp4
```

读取方式是：

```text
episodeId
  -> 根据 chunks_size 算 episode_chunk
  -> 用 info.data_path / info.video_path 模板拼路径
  -> 读取整份 episode parquet
```

### 3.2 v3.0

v3 会把多个 episode 放进共享 shard：

```text
data/chunk-000/file-000.parquet
videos/chunk-000/<video_key>/file-000.mp4
meta/episodes/chunk-000/file-000.parquet
```

读取方式变成：

```text
episodeId
  -> 遍历 meta/episodes/chunk-*/file-*.parquet
  -> 找到 episode_index 对应行
  -> 取 data_chunk_index / data_file_index
  -> 取 dataset_from_index / dataset_to_index
  -> 只读取共享 data parquet 的这一段行
  -> 视频用 video_from_timestamp / video_to_timestamp 截片段
```

这就是为什么 `VideoInfo` 里有 `isSegmented`、`segmentStart`、`segmentEnd`。

## 4. 曲线数据如何生成

parquet 的一行通常包含很多列：

```text
timestamp
action
observation.state
observation.images.left_wrist
...
```

图表不直接画原始结构，而是做几步整理：

```text
读取 episode rows
  -> 根据 info.features 找出可画的 numeric feature
  -> 展开向量维度，比如 action[0] -> action | left_tcp.x
  -> 加入 timestamp
  -> 过滤不适合画的列
  -> 按前缀/后缀分组
  -> 采样到 MAX_EPISODE_POINTS
```

为什么要采样：一个 episode 可能几千到几万帧，直接把每个点都交给浏览器图表会变慢。
采样保留趋势，同时让页面响应更稳定。

速度曲线是衍生数据：`buildPoseVelocityChartGroups()` 会根据 source timestamp 和 fps 估算
相邻帧变化速度，用来发现突变或动作不连续。

## 5. 视频和播放条如何同步

`TimeContext` 是同步中心：

```text
TimeProvider
  currentTime
  isPlaying
  seek(t)
  externalSeekVersion
  subscribe(cb)
```

三个典型方向：

### 5.1 用户拖动播放条

```text
PlaybackBar slider onChange
  -> seek(t, "external")
  -> externalSeekVersion +1
  -> SimpleVideosPlayer 看到版本变化
  -> 所有 video.currentTime 调到目标时间
```

### 5.2 视频自然播放

```text
primary video timeupdate
  -> seek(globalTime, "video")
  -> TimeContext 更新 currentTime
  -> 播放条和图表读到新时间
```

这里 `source="video"` 不会增加 `externalSeekVersion`，否则每个 `timeupdate` 都会反过来强制 seek
所有视频，造成抖动。

### 5.3 v3 segmented video 到达片段末尾

```text
primary video currentTime 接近 segmentEnd
  -> loopAllVideos()
  -> 所有视频同步回到各自 segmentStart
  -> seek(0, "video")
```

这样多相机不会出现一个已经循环、另一个还停在上一段末尾的短暂错位。

## 6. 为什么组件里大量使用 ref

播放期间时间会频繁变化。如果整个 `EpisodeViewerInner` 每 80ms 重渲染一次，页面会卡。
所以代码把高频状态放进 ref 或小组件里：

| 技巧                   | 目的                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `UrlTimeSync` 独立组件 | 只有它订阅 `currentTime`，避免父组件频繁重渲染。           |
| `keyStateRef`          | 键盘事件只绑定一次，但能读到最新 active tab / episode。    |
| `onVideosReadyRef`     | 避免父组件传入的新函数身份导致视频 ready effect 反复重建。 |
| `firstVisibleIdxRef`   | 隐藏相机时不重置所有视频 ready 监听。                      |

可以把这些 ref 理解成：**事件处理器需要最新值，但不一定需要触发 React 重渲染。**

## 7. Tab 的懒加载策略

页面打开时，最重要的是先看到视频和当前 episode 曲线。其他内容按需加载：

```text
切到 Statistics -> loadStats()
切到 Frames     -> loadFrames()
切到 Insights   -> loadInsights()
切到 Filtering  -> loadStats() + loadInsights()
切到 Doctor     -> DoctorPanel 自己发起诊断
```

这样避免首页因为跨 episode 分析、parquet 表格或 Doctor 扫描而阻塞。

## 8. 常见调试入口

视频不同步：

1. 看 `videosInfo` 是否正确标记 `isSegmented`。
2. 看 `segmentStart` / `segmentEnd` 是否来自正确的 v3 episode metadata。
3. 看 `SimpleVideosPlayer` 的 primary video 是否是当前第一个可见视频。

曲线为空：

1. 看 `info.features` 里对应字段是否是 numeric 且 shape 为一维。
2. 看 parquet rows 是否真的包含 `action` 或 `observation.state`。
3. 看是否被 `EXCLUDED_COLUMNS` 或图表采样逻辑过滤。

episode 打不开：

1. 先请求 `/api/local-datasets/<encodedPath>/meta/info.json`。
2. v3 再检查 `meta/episodes/chunk-*/file-*.parquet`。
3. 确认 `dataset_from_index` / `dataset_to_index` 是有效区间。

读懂这个页面的关键是：**`fetch-data.ts` 负责把磁盘格式翻译成 `EpisodeData`，
`episode-viewer.tsx` 负责把 `EpisodeData` 变成可交互页面。**
