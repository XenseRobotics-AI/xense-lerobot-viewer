/**
 * Chart and data visualization type definitions
 */

// Chart data point structure
export interface ChartDataPoint {
  timestamp: number;
  [key: string]: number | Record<string, number>; // Hierarchical data
}

// Chart data group
export type ChartDataGroup = ChartDataPoint[];

/**
 * One row as the graph components consume it: a `ChartDataPoint` without the
 * required `timestamp`, because a row merged or filtered across groups is not
 * guaranteed to carry one.
 */
export type ChartSeriesRow = Record<string, number | Record<string, number>>;

// Series column definition
export interface SeriesColumn {
  key: string;
  value: string[]; // Series names
}

// Group statistics for scale calculation
export interface GroupStats {
  min: number;
  max: number;
}
