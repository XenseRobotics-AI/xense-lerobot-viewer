export type ModelScopeDownloadScope = "all" | "meta";

export type ModelScopeDownloadRequest = {
  source: string;
  destinationRoot: string;
  scope: ModelScopeDownloadScope;
  concurrency?: number;
  token?: string;
};

export type ModelScopeDownloadCheck = {
  source: string;
  repoId: string;
  hubRepoId: string;
  repoPath: string;
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

export type ModelScopeDownloadProgress = {
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

export type ModelScopeDownloadResult = {
  source: string;
  repoId: string;
  hubRepoId: string;
  repoPath: string;
  subfolder: string | null;
  scope: ModelScopeDownloadScope;
  revisionSha: string;
  targetPath: string;
  backupPath: string | null;
  fileCount: number;
  sizeBytes: number;
  concurrency: number;
  metaOnly: boolean;
};

export type ModelScopeDownloadStreamEvent =
  | { type: "progress"; progress: ModelScopeDownloadProgress }
  | { type: "result"; result: ModelScopeDownloadResult }
  | { type: "error"; error: string; code?: string };
