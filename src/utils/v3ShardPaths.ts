/** Helpers for the segmented LeRobot v3 episode metadata layout. */

const EPISODE_METADATA_SHARD_RE =
  /^meta\/episodes\/chunk-(\d+)\/file-(\d+)\.parquet$/i;

export type V3EpisodeMetadataShard = {
  relPath: string;
  chunkIndex: number;
  fileIndex: number;
};

export function parseV3EpisodeMetadataShard(
  relPath: string,
): V3EpisodeMetadataShard | null {
  const match = EPISODE_METADATA_SHARD_RE.exec(relPath);
  if (!match) return null;

  const chunkIndex = Number(match[1]);
  const fileIndex = Number(match[2]);
  if (!Number.isSafeInteger(chunkIndex) || !Number.isSafeInteger(fileIndex)) {
    return null;
  }

  return { relPath, chunkIndex, fileIndex };
}

export function compareV3EpisodeMetadataShards(
  left: string,
  right: string,
): number {
  const leftShard = parseV3EpisodeMetadataShard(left);
  const rightShard = parseV3EpisodeMetadataShard(right);
  if (!leftShard || !rightShard) return left.localeCompare(right);

  return (
    leftShard.chunkIndex - rightShard.chunkIndex ||
    leftShard.fileIndex - rightShard.fileIndex ||
    left.localeCompare(right)
  );
}

export function sortV3EpisodeMetadataShards(paths: string[]): string[] {
  return paths
    .filter((relPath) => parseV3EpisodeMetadataShard(relPath) !== null)
    .sort(compareV3EpisodeMetadataShards);
}

/** Whether fixed probing from chunk-0/file-0 would discover every shard. */
export function matchesFixedV3EpisodeMetadataProbing(
  paths: string[],
  maxChunks = 64,
  maxFilesPerChunk = 4096,
): boolean {
  const shards = paths.map(parseV3EpisodeMetadataShard);
  if (shards.some((shard) => shard === null)) return false;
  if (shards.length === 0) return true;

  const fileIndexesByChunk = new Map<number, Set<number>>();
  for (const shard of shards) {
    if (!shard) continue;
    const fileIndexes = fileIndexesByChunk.get(shard.chunkIndex) ?? new Set();
    fileIndexes.add(shard.fileIndex);
    fileIndexesByChunk.set(shard.chunkIndex, fileIndexes);
  }

  const chunkIndexes = [...fileIndexesByChunk.keys()].sort((a, b) => a - b);
  if (chunkIndexes.some((chunkIndex) => chunkIndex >= maxChunks)) return false;
  if (chunkIndexes.some((chunkIndex, index) => chunkIndex !== index))
    return false;

  for (const fileIndexes of fileIndexesByChunk.values()) {
    const sortedIndexes = [...fileIndexes].sort((a, b) => a - b);
    if (sortedIndexes.some((fileIndex) => fileIndex >= maxFilesPerChunk)) {
      return false;
    }
    if (sortedIndexes.some((fileIndex, index) => fileIndex !== index))
      return false;
  }
  return true;
}
