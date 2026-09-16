export type HfDownloadScope = "all" | "meta";

export type HfDownloadRequest = {
  source: string;
  destinationRoot: string;
  scope: HfDownloadScope;
  endpoint: string;
  concurrency?: number;
  token?: string;
};

export type HfDownloadCheck = {
  source: string;
  repoId: string;
  subfolder: string | null;
  revisionSha: string;
  destinationRoot: string;
  targetPath: string;
  fileCount: number;
  sizeBytes: number;
  unknownSizeFiles: number;
  targetExists: boolean;
  scopeExists: boolean;
  localScopeSha: string | null;
  matchesRevision: boolean;
};

export type HfDownloadProgress = {
  phase: "downloading" | "promoting";
  currentFile?: string | null;
  filesDone?: number;
  filesTotal?: number;
  bytes?: number;
  totalBytes?: number;
  currentFileBytes?: number | null;
  currentFileTotalBytes?: number | null;
  activeFiles?: string[];
  concurrency?: number;
  bytesPerSecond?: number;
  percent?: number;
};

export type HfDownloadResult = {
  source: string;
  repoId: string;
  subfolder: string | null;
  scope: HfDownloadScope;
  revisionSha: string;
  targetPath: string;
  backupPath: string | null;
  fileCount: number;
  sizeBytes: number;
  concurrency: number;
  metaOnly: boolean;
};

export type HfDownloadStreamEvent =
  | { type: "progress"; progress: HfDownloadProgress }
  | { type: "result"; result: HfDownloadResult }
  | { type: "error"; error: string; code?: string };
