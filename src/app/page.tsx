import { cookies } from "next/headers";
import LocalDatasetGrid from "./local-dataset-grid";
import { discoverLocalDatasets } from "@/lib/local-datasets-discovery";
import { BROWSE_PATH_COOKIE } from "@/utils/browsePath";
import { recordDaySnapshot } from "@/lib/corpus-history-store";
import { computeCorpusStats } from "@/utils/corpusStats";
import { groupDatasetsByPrefix } from "@/utils/datasetGrouping";
import {
  computeDailyDelta,
  snapshotFromSources,
  type DailyDelta,
} from "@/utils/corpusHistory";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Which directory to scan: the switcher's cookie, validated against the
  // known locations server-side (an unknown value falls back to the root).
  const cookieStore = await cookies();
  const requestedPath = cookieStore.get(BROWSE_PATH_COOKIE)?.value;
  const { root, browsePath, locations, datasets, errors } =
    await discoverLocalDatasets(requestedPath);

  // Record today's totals and diff against the last day on record. This is the
  // only write the browse path performs; `recordDaySnapshot` swallows its own
  // failures, so a read-only root just means no "new today" figures.
  const stats = computeCorpusStats(groupDatasetsByPrefix(datasets));
  const today = snapshotFromSources(stats.segments, new Date().toISOString());
  const { history, todayKey } = await recordDaySnapshot(today);
  const delta: DailyDelta = computeDailyDelta(history, today, todayKey);

  return (
    <LocalDatasetGrid
      root={root}
      browsePath={browsePath}
      locations={locations}
      datasets={datasets}
      errors={errors}
      delta={delta}
    />
  );
}
