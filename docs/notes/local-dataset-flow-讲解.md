# 本地数据集读取链路讲解

> 主要源码：
> [datasetRoute.ts](../../src/utils/datasetRoute.ts) ·
> [local-datasets-discovery.ts](../../src/lib/local-datasets-discovery.ts) ·
> [local-dataset-paths.ts](../../src/lib/local-dataset-paths.ts) ·
> [[...filePath]/route.ts](../../src/app/api/local-datasets/%5BencodedPath%5D/%5B...filePath%5D/route.ts)

## 0. 这个链路解决什么问题

一句话：**把“磁盘上的某个数据集目录”安全地变成“浏览器可以请求的 JSON、parquet 和视频 URL”。**

难点有三个：

- 数据集在用户本机，不在固定服务器路径。
- 浏览器不能直接读任意本地文件，必须经过 Next.js API route。
- API route 必须防止路径穿越和 symlink 越界，不能让一个 URL 读出数据集外的文件。

所以项目把问题拆成两步：

```text
发现数据集
  -> 只扫描 LOCAL_DATASET_ROOT 下的 meta/info.json

读取数据集文件
  -> 只允许 /api/local-datasets/<encodedPath>/<filePath> 读数据集内部文件
```

## 1. 首页如何发现数据集

入口是 `/api/local-datasets`，核心逻辑在 `src/lib/local-datasets-discovery.ts`。

扫描流程：

```text
resolveLocalDatasetRoot()
  -> 确定根目录
  -> walkForDatasets(root, currentDir, depth)
  -> 最多向下扫描 3 层
  -> 遇到 meta/info.json 且 codebase_version 存在
  -> 记录 LocalDatasetSummary
```

它会跳过一些不应当当成数据集递归的目录：

```text
calibration
.cache
.git
node_modules
__pycache__
```

这样既减少扫描量，也避免把 Hugging Face cache 内部结构误认为数据集。

## 2. `LocalDatasetSummary` 是首页卡片的数据源

扫描到一个数据集后，项目会读几类信息：

| 字段                                      | 来源                            | 用途                              |
| ----------------------------------------- | ------------------------------- | --------------------------------- |
| `relativePath`                            | 数据集相对 root 的路径          | 显示和生成内部 repoId             |
| `encodedPath`                             | relative path 的 base64url 编码 | 生成页面和 API URL                |
| `codebase_version`                        | `meta/info.json`                | 判断 v2/v3 读取逻辑               |
| `robot_type`                              | `meta/info.json`                | 判断 URDF 支持和过滤              |
| `total_episodes` / `total_frames` / `fps` | `meta/info.json`                | 首页统计和卡片信息                |
| `thumbnailVideoUrl`                       | `video_path` + 相机选择         | 首页 hover 预览                   |
| `integrity`                               | `data/`、`videos/`、episode 数  | 区分 healthy / empty / incomplete |
| `tags`                                    | `meta/xense_tags.json`          | 任务、场景、对象过滤              |
| `sizeBytes`                               | 递归遍历目录                    | 显示磁盘占用                      |

注意 `sizeBytes` 会统计数据集目录下的全部文件，包括 `.cache/huggingface` bookkeeping。
这是有意的：首页显示的是这个数据集实际占了多少磁盘。

## 3. 为什么 URL 里不用原始路径

本地相对路径可能包含 `/`、空格、中文等字符，不适合直接塞进 URL 层级。项目用
base64url 编码：

```text
lerobot/svla_so101_pickplace
  -> bGVyb2JvdC9zdmxhX3NvMTAxX3BpY2twbGFjZQ
```

页面 URL：

```text
/_local/<encodedPath>/episode_0
```

文件 API：

```text
/api/local-datasets/<encodedPath>/meta/info.json
/api/local-datasets/<encodedPath>/videos/chunk-000/...
```

相关函数集中在 `src/utils/datasetRoute.ts`：

| 函数                        | 作用                                                  |
| --------------------------- | ----------------------------------------------------- |
| `encodeLocalDatasetPath()`  | relative path -> encodedPath                          |
| `decodeLocalDatasetPath()`  | encodedPath -> relative path                          |
| `makeLocalRepoId()`         | relative path -> `local:<path>`                       |
| `getLocalDatasetFileBase()` | `local:<path>` -> `/api/local-datasets/<encodedPath>` |
| `routePathFromRepoId()`     | repoId -> 页面路由                                    |

## 4. 文件 API 如何读视频和 parquet

通用文件读取 route 是：

```text
src/app/api/local-datasets/[encodedPath]/[...filePath]/route.ts
```

请求例子：

```text
GET /api/local-datasets/<encodedPath>/meta/info.json
GET /api/local-datasets/<encodedPath>/data/chunk-000/file-000.parquet
GET /api/local-datasets/<encodedPath>/videos/chunk-000/observation.images.left_wrist/file-000.mp4
```

它做三件事：

1. 调用 `statDatasetFile(encodedPath, filePath)` 确认文件存在且在数据集内部。
2. 根据扩展名设置 content-type。
3. 对带 `Range` header 的请求返回 `206 Partial Content`，支持浏览器分段加载视频。

视频不能每次整文件读入内存，否则大文件播放会慢且费内存。Range 支持让浏览器按需拉取片段。

## 5. 路径安全边界

安全逻辑集中在 `src/lib/local-dataset-paths.ts`，不要分散写在每个 route 里。

它分两层防御：

### 5.1 词法防御

`resolveInsideDataset(root, ...segments)` 会拒绝：

- `..` 逃逸。
- 绝对路径逃逸。
- 指向数据集根目录本身的请求。

也就是先从字符串层面判断：

```text
datasetRoot + requestedPath
  -> path.resolve(...)
  -> path.relative(root, target)
  -> 必须仍在 root 内部
```

### 5.2 symlink 防御

仅靠字符串不够，因为数据集内部可能有 symlink：

```text
dataset/videos/outside -> /etc/passwd
```

所以 `statDatasetFile()` 会额外 `realpath`：

```text
realRoot = realpath(datasetRoot)
realTarget = realpath(requestedFile)
realTarget 必须仍在 realRoot 内部
```

这意味着：数据集通过 symlink root 挂载是可以的，但数据集内部的 out-of-tree symlink 会被拒绝。

## 6. v2 和 v3 的读取差异在哪里出现

文件 API 本身不关心 v2/v3，它只负责“给你一个 path，我安全返回文件”。

真正的版本差异在 `fetch-data.ts`：

| 版本        | 读取策略                                                                            |
| ----------- | ----------------------------------------------------------------------------------- |
| v2.0 / v2.1 | 根据 `info.data_path` 和 episode index 拼出单集 parquet。                           |
| v3.0        | 先读 `meta/episodes/...parquet`，找到当前 episode 的 data chunk/file 和 row range。 |

因此理解链路时要分清：

```text
local file route
  只负责安全读文件

fetch-data.ts
  负责知道应该读哪个文件、哪几行、哪些列
```

## 7. 调试时看哪里

如果首页不显示数据集，按顺序查：

1. `LOCAL_DATASET_ROOT` 是否指向包含 `meta/info.json` 的根目录。
2. 数据集是否超过 3 层扫描深度。
3. `meta/info.json` 是否有 `codebase_version`。
4. `data/` 和 `videos/` 是否存在且非空。

如果 episode 页面打不开文件，按顺序查：

1. URL 里的 `encodedPath` 是否能解码成正确相对路径。
2. `/api/local-datasets/<encodedPath>/meta/info.json` 是否返回 200。
3. v3.0 数据集的 `meta/episodes` 是否存在。
4. 请求的视频或 parquet path 是否确实位于数据集目录内部。

核心判断：**发现阶段只认 `meta/info.json`，读取阶段只认安全解析后的数据集内部文件。**
