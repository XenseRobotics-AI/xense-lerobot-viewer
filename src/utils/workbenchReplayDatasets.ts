export const TACCAP_WORKBENCH_REPLAY_DATASET =
  "TacVerse/taccap-g1-operate-shoe-box-0812";

export const XTAC_UMI_WORKBENCH_REPLAY_DATASET =
  "TacVerse/xtac-umi-g1-block-to-box";

export const XTAC_UMI_WORKBENCH_REPLAY_DATASETS = Object.freeze([
  "TacVerse/xtac-umi-g1-block-to-box",
  "TacVerse/xtac-umi-g1-bottle-to-cup",
  "TacVerse/xtac-umi-g1-insert-optical-module",
  "TacVerse/xtac-umi-g1-insert-rubber-stopper",
  "TacVerse/xtac-umi-g1-parts-sorting",
]);

export const WORKBENCH_REPLAY_DATASETS = Object.freeze([
  TACCAP_WORKBENCH_REPLAY_DATASET,
  ...XTAC_UMI_WORKBENCH_REPLAY_DATASETS,
]);

export const WORKBENCH_REPLAY_DATASET_LEAVES = Object.freeze(
  WORKBENCH_REPLAY_DATASETS.map((dataset) => dataset.split("/").at(-1) ?? ""),
);

export function workbenchReplayDatasetLeaf(relativePath: string): string {
  return (
    relativePath
      .split(/[\\/]+/u)
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

export function workbenchReplayDatasetRank(relativePath: string): number {
  const leaf = workbenchReplayDatasetLeaf(relativePath);
  const index = WORKBENCH_REPLAY_DATASET_LEAVES.indexOf(leaf);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

export function isWorkbenchReplayDatasetPath(relativePath: string): boolean {
  return workbenchReplayDatasetRank(relativePath) !== Number.POSITIVE_INFINITY;
}
