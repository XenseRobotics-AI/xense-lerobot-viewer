/**
 * The calibration window a recording's gripper values were normalized against.
 *
 * `{side}_gripper.pos` in a dataset is `0..1`, and it is tempting to read 1 as
 * "the jaw wide open". It is not: the converter normalizes the encoder angle
 * against the two bounds in the raw filename — `..._openv2_-16.55_10.77.hdf5`,
 * closed at -16.55°, open at 10.77° — so **1 means as open as that station was
 * calibrated**, which is a window inside the jaw's mechanical travel.
 *
 * Drawing 1 at the URDF's own joint limit therefore renders the jaw wider than
 * it ever was, consistently at every value, which looks plausible rather than
 * broken: on the RDT rig the vendor limit is 0.7 rad (40.1°, 88 mm between the
 * pads) against a calibrated window of about 27°, so the replay showed a jaw
 * some 45% further open than the hardware managed.
 *
 * `hdf52lerobot` records the window per episode in `meta/sources.json` as
 * `episodes[].grippers.{side}_gripper.travel_rad`. It is per episode because it
 * is per station: across one 30-episode dataset the windows span 25.1°-27.4°.
 *
 * Datasets converted before that block existed simply have no entry, and the
 * caller falls back to the joint limit — the old, too-wide rendering. That is
 * deliberate: they are wrong in a known way rather than newly broken. The
 * converter version is **not** a usable signal for this; it reads `0.1.0` both
 * before and after the block was added.
 */

export type GripperCalibrationWindow = {
  /** Travel from closed to the calibrated open end, radians. */
  travelRad: number;
};

/** Calibration windows for one episode, keyed `left_gripper` / `right_gripper`. */
export type EpisodeGripperCalibration = Record<
  string,
  GripperCalibrationWindow
>;

type SourcesEpisode = {
  episode_index?: unknown;
  grippers?: unknown;
};

/**
 * Pull one episode's calibration windows out of a parsed `meta/sources.json`.
 *
 * Keyed on each entry's own `episode_index` rather than its position: the array
 * is written in episode order today, but the field is there and costs nothing
 * to honour.
 *
 * Returns an empty object when the dataset predates the block, when the episode
 * is absent, or when a value is not a usable number — every one of those means
 * "no calibration known", which the caller handles the same way.
 */
export function readEpisodeGripperCalibration(
  sources: unknown,
  episodeIndex: number,
): EpisodeGripperCalibration {
  const episodes = (sources as { episodes?: unknown } | null)?.episodes;
  if (!Array.isArray(episodes)) return {};

  const entry = episodes.find(
    (candidate): candidate is SourcesEpisode =>
      !!candidate &&
      typeof candidate === "object" &&
      (candidate as SourcesEpisode).episode_index === episodeIndex,
  );
  const grippers = entry?.grippers;
  if (!grippers || typeof grippers !== "object") return {};

  const windows: EpisodeGripperCalibration = {};
  for (const [key, value] of Object.entries(
    grippers as Record<string, unknown>,
  )) {
    const travel = (value as { travel_rad?: unknown } | null)?.travel_rad;
    if (typeof travel === "number" && Number.isFinite(travel) && travel > 0) {
      windows[key] = { travelRad: travel };
    }
  }
  return windows;
}

/** The window driving `{side}_gripper.pos`, or null when none is recorded. */
export function gripperTravelForSide(
  calibration: EpisodeGripperCalibration | null | undefined,
  side: "left" | "right",
): number | null {
  return calibration?.[`${side}_gripper`]?.travelRad ?? null;
}
