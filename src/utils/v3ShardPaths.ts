/**
 * Helpers for the segmented LeRobot v3 episode metadata layout.
 *
 * The numeric suffixes are identifiers, not an assertion that every dataset
 * starts at zero or contains every intermediate file.
 */

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
