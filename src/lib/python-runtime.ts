import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Picks the Python interpreter the server-side scripts run under.
 *
 * The routes used to hardcode `PYTHON_BIN || "python3"`, which is wrong on any
 * machine where the first `python3` on PATH isn't the one holding the
 * dependencies — a shell venv, a system Python, a bare conda base. The symptom
 * is a useless `No module named 'huggingface_hub'` from a script that has no
 * idea which interpreter it landed in.
 *
 * Resolution is deliberately ordered rather than clever:
 *
 *   1. `PYTHON_BIN` — explicit config wins, and is *exclusive*: if it lacks the
 *      modules we fail naming it, instead of silently running something else.
 *   2. The obvious local interpreters: `./.venv`, `./venv`, `$VIRTUAL_ENV`,
 *      `$CONDA_PREFIX`, then `python3` / `python` from PATH.
 *   3. Only if none of those satisfy the requirement do we go looking: conda /
 *      mamba env directories are scanned and the best match is used.
 *
 * Step 3 is a fallback, not the strategy. Discovery picks the highest module
 * version purely as a deterministic tiebreak (path order breaks ties after
 * that), it logs the interpreter it chose, and `PYTHON_BIN` overrides it. When
 * nothing on the machine has the modules, the error says what to install and
 * where to point `PYTHON_BIN` — which is the situation on a fresh machine.
 */

/** Distribution names differ from import names for some packages. */
const DISTRIBUTION_ALIASES: Record<string, string> = {
  huggingface_hub: "huggingface-hub",
};

const PROBE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_DISCOVERY_PROBES = 24;
const MAX_SPAWN_ENV_BYTES = 512 * 1024;
const MAX_SPAWN_ENV_ENTRY_BYTES = 64 * 1024;

const ESSENTIAL_PYTHON_ENV_KEYS = new Set([
  "ALL_PROXY",
  "CONDA_DEFAULT_ENV",
  "CONDA_ENVS_DIRS",
  "CONDA_ENVS_PATH",
  "CONDA_EXE",
  "CONDA_PREFIX",
  "CONDA_ROOT",
  "CONDA_SHLVL",
  "CONDA_PYTHON_EXE",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "MAMBA_ROOT_PREFIX",
  "MODELSCOPE_API_TOKEN",
  "MODELSCOPE_DATASET_REPO",
  "NO_PROXY",
  "PATH",
  "PYTHON_BIN",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "VIRTUAL_ENV",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

export interface PythonProbe {
  bin: string;
  /** Interpreter version, e.g. "3.12.13". */
  version: string;
  /** Module import name → installed version, or null when absent. */
  modules: Record<string, string | null>;
}

export type PythonSource =
  | "PYTHON_BIN"
  | "project-venv"
  | "active-env"
  | "path"
  | "discovered";

export interface ResolvedPython {
  bin: string;
  version: string;
  source: PythonSource;
  modules: Record<string, string | null>;
}

export class PythonUnavailableError extends Error {
  readonly tried: string[];
  constructor(message: string, tried: string[]) {
    super(message);
    this.name = "PythonUnavailableError";
    this.tried = tried;
  }
}

interface EnvLike {
  [key: string]: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

const isWindows = process.platform === "win32";

/**
 * Environment for a spawned interpreter, with the two variables that can
 * silently defeat the interpreter we just picked removed.
 *
 * `PYTHONPATH` is prepended to `sys.path` of *every* Python, whatever its
 * version — so a sourced ROS setup (`/opt/ros/humble/.../python3.10/
 * site-packages`, which is the normal state of a robotics workstation, this
 * one included) injects 3.10 packages into a 3.12 venv. Same-named modules
 * shadow the ones we installed, and a 3.10-built C extension imported into
 * 3.12 fails outright.
 *
 * `PYTHONHOME` is worse: it overrides the interpreter's own prefix, which
 * breaks a venv entirely.
 *
 * Neither is something `sync_hf_dataset.py` or `export_subtasks.py` wants —
 * they import stdlib plus what the resolved environment holds, and nothing
 * else. Stripping both is what makes "resolve the interpreter" actually mean
 * "run against that interpreter's packages".
 */
export function pythonSpawnEnv(base: EnvLike = process.env): NodeJS.ProcessEnv {
  const entries = Object.entries(base).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      entry[0] !== "PYTHONPATH" &&
      entry[0] !== "PYTHONHOME",
  );
  const sized = entries.map(([key, value], index) => ({
    key,
    value,
    index,
    bytes: envEntryBytes(key, value),
  }));
  const totalBytes = sized.reduce((sum, entry) => sum + entry.bytes, 0);
  const oversized = sized.some(
    (entry) => entry.bytes > MAX_SPAWN_ENV_ENTRY_BYTES,
  );

  if (!oversized && totalBytes <= MAX_SPAWN_ENV_BYTES) {
    // Cast rather than build: Next's ProcessEnv marks NODE_ENV required, which
    // a structural copy of an EnvLike cannot prove it carries.
    return Object.fromEntries(entries) as NodeJS.ProcessEnv;
  }

  // A Next/dev shell can contain very large injected variables. Passing the
  // entire environment to Python can fail before the interpreter starts with
  // E2BIG, so compact it while preserving runtime-critical configuration.
  const env = {} as NodeJS.ProcessEnv;
  let usedBytes = 0;
  const add = (entry: (typeof sized)[number]): void => {
    if (env[entry.key] !== undefined) return;
    if (entry.bytes > MAX_SPAWN_ENV_ENTRY_BYTES) return;
    if (usedBytes + entry.bytes > MAX_SPAWN_ENV_BYTES) return;
    env[entry.key] = entry.value;
    usedBytes += entry.bytes;
  };

  for (const entry of sized.filter((item) => essentialPythonEnvKey(item.key))) {
    add(entry);
  }
  for (const entry of sized
    .filter((item) => !essentialPythonEnvKey(item.key))
    .sort((a, b) => a.bytes - b.bytes || a.index - b.index)) {
    add(entry);
  }

  return env;
}

function envEntryBytes(key: string, value: string): number {
  return Buffer.byteLength(`${key}=${value}`, "utf8") + 1;
}

function essentialPythonEnvKey(key: string): boolean {
  return (
    ESSENTIAL_PYTHON_ENV_KEYS.has(key) ||
    key.startsWith("HF_") ||
    key.startsWith("HUGGINGFACE_") ||
    key.startsWith("MODELSCOPE_") ||
    key.startsWith("XENSE_")
  );
}

/** Interpreter path inside an env/venv directory. */
export function interpreterIn(envDir: string): string {
  return isWindows
    ? path.join(envDir, "python.exe")
    : path.join(envDir, "bin", "python");
}

/**
 * Ordered, deduplicated list of interpreters to try before falling back to
 * discovery. When `PYTHON_BIN` is set it is the only candidate — an explicit
 * choice that turns out to be wrong should be reported, not worked around.
 */
export function candidatePythons(env: EnvLike, cwd: string): string[] {
  const explicit = env.PYTHON_BIN?.trim();
  if (explicit) return [explicit];

  const candidates = [
    interpreterIn(path.join(cwd, ".venv")),
    interpreterIn(path.join(cwd, "venv")),
    env.VIRTUAL_ENV ? interpreterIn(env.VIRTUAL_ENV) : null,
    env.CONDA_PREFIX ? interpreterIn(env.CONDA_PREFIX) : null,
    isWindows ? "python.exe" : "python3",
    isWindows ? null : "python",
  ].filter((c): c is string => Boolean(c));

  return [...new Set(candidates)];
}

/** True when `PYTHON_BIN` pinned the interpreter, so no fallback applies. */
export function isPinned(env: EnvLike): boolean {
  return Boolean(env.PYTHON_BIN?.trim());
}

/**
 * Directories that hold conda/mamba environments. Every common installer
 * layout, plus whatever the current shell already exposes — a machine with
 * conda active tells us where its envs live without us guessing.
 */
export function condaEnvRoots(env: EnvLike, home: string): string[] {
  const roots: string[] = [];

  for (const key of ["CONDA_ENVS_PATH", "CONDA_ENVS_DIRS"] as const) {
    const raw = env[key];
    if (raw) roots.push(...raw.split(path.delimiter).filter(Boolean));
  }

  for (const key of ["MAMBA_ROOT_PREFIX", "CONDA_ROOT"] as const) {
    const raw = env[key];
    if (raw) roots.push(path.join(raw, "envs"));
  }

  // An active env is usually `<base>/envs/<name>`; its siblings are the rest.
  const prefix = env.CONDA_PREFIX;
  if (prefix) {
    const parent = path.dirname(prefix);
    if (path.basename(parent) === "envs") roots.push(parent);
    else roots.push(path.join(prefix, "envs"));
  }

  for (const install of [
    "miniforge3",
    "mambaforge",
    "miniconda3",
    "anaconda3",
    "micromamba",
    ".conda",
    ".micromamba",
  ]) {
    roots.push(path.join(home, install, "envs"));
  }

  return [...new Set(roots)];
}

/** Compare dotted versions numerically; non-numeric parts sort last. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.split(/[.+-]/).map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isNaN(n) ? -1 : n;
    });
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function satisfies(probe: PythonProbe, required: string[]): boolean {
  return required.every((mod) => probe.modules[mod] != null);
}

/**
 * Best-first ordering among interpreters that satisfy the requirement:
 * highest version of the first required module, then path order. Both keys are
 * deterministic — the same machine always resolves to the same interpreter.
 */
export function rankProbes(
  probes: PythonProbe[],
  required: string[],
): PythonProbe[] {
  const key = required[0];
  return probes
    .filter((p) => satisfies(p, required))
    .sort((a, b) => {
      const versionDiff = compareVersions(
        b.modules[key] ?? "0",
        a.modules[key] ?? "0",
      );
      if (versionDiff !== 0) return versionDiff;
      return a.bin.localeCompare(b.bin);
    });
}

/** Source code for the probe: `find_spec` only, so heavy imports never run. */
export function buildProbeScript(): string {
  return [
    "import json,sys",
    "from importlib.util import find_spec",
    "from importlib.metadata import version as _v",
    "out={}",
    "for m in sys.argv[1:]:",
    "    try:",
    "        found=find_spec(m) is not None",
    "    except Exception:",
    "        found=False",
    "    if not found:",
    "        out[m]=None; continue",
    "    for name in (m, m.replace('_','-')):",
    "        try:",
    "            out[m]=_v(name); break",
    "        except Exception:",
    "            out[m]='unknown'",
    "info={'version':sys.version.split()[0],'executable':sys.executable,'modules':out}",
    "print(json.dumps(info))",
  ].join("\n");
}

export function parseProbeOutput(
  bin: string,
  stdout: string,
  required: string[],
): PythonProbe | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as {
      version?: unknown;
      executable?: unknown;
      modules?: unknown;
    };
    const modules: Record<string, string | null> = {};
    const raw = (parsed.modules ?? {}) as Record<string, unknown>;
    for (const mod of required) {
      const value = raw[mod];
      modules[mod] = typeof value === "string" ? value : null;
    }
    return {
      // Prefer the interpreter's own view of itself: `python3` from PATH tells
      // us nothing about which one actually ran.
      bin: typeof parsed.executable === "string" ? parsed.executable : bin,
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
      modules,
    };
  } catch {
    return null;
  }
}

function packageHint(required: string[]): string {
  return required.map((m) => DISTRIBUTION_ALIASES[m] ?? m).join(" ");
}

/** Keep the error readable: a scanned machine can yield a dozen interpreters. */
export function summarizeTried(tried: string[], limit = 6): string {
  if (tried.length <= limit) return tried.join(", ");
  return `${tried.slice(0, limit).join(", ")} (+${tried.length - limit} more)`;
}

/** The message a fresh machine gets: what is missing, and both ways to fix it. */
export function formatUnavailableError(
  required: string[],
  tried: string[],
  pinned: boolean,
): string {
  const modules = required.join(", ");
  const install = `python3 -m pip install ${packageHint(required)}`;
  if (pinned) {
    return (
      `PYTHON_BIN=${tried[0]} does not have ${modules} installed. ` +
      `Install it there (${tried[0]} -m pip install ${packageHint(required)}), ` +
      `or point PYTHON_BIN at an interpreter that has it.`
    );
  }
  return (
    `No Python with ${modules} found. Tried: ${summarizeTried(tried)}. ` +
    `Install the dependencies (${install}, or from scripts/requirements.txt), ` +
    `or set PYTHON_BIN in .env.local to an interpreter that already has them ` +
    `(e.g. a conda env: PYTHON_BIN=/path/to/envs/<name>/bin/python).`
  );
}

/* ------------------------------------------------------------------ */
/* Probing                                                             */
/* ------------------------------------------------------------------ */

async function probe(
  bin: string,
  required: string[],
): Promise<PythonProbe | null> {
  return new Promise((resolve) => {
    let child;
    try {
      // Probe under the same environment the real run will get, or a module
      // visible only through PYTHONPATH would make an interpreter look usable.
      child = spawn(bin, ["-c", buildProbeScript(), ...required], {
        stdio: ["ignore", "pipe", "pipe"],
        env: pythonSpawnEnv(),
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (value: PythonProbe | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.resume();
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseProbeOutput(bin, stdout, required)));
  });
}

/** Interpreters inside every conda/mamba env directory we can find. */
async function discoverEnvInterpreters(env: EnvLike): Promise<string[]> {
  const found: string[] = [];
  for (const root of condaEnvRoots(env, os.homedir())) {
    let entries: string[];
    try {
      entries = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name);
    } catch {
      continue; // root doesn't exist on this machine — expected, not an error
    }
    for (const name of entries.sort()) {
      found.push(interpreterIn(path.join(root, name)));
    }
  }
  return [...new Set(found)].slice(0, MAX_DISCOVERY_PROBES);
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  at: number;
  value: Promise<ResolvedPython>;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(required: string[], env: EnvLike): string {
  return `${[...required].sort().join(",")}|${env.PYTHON_BIN ?? ""}`;
}

/** Drop memoised resolutions — used by tests, and after a config change. */
export function clearPythonCache(): void {
  cache.clear();
}

async function resolveUncached(
  required: string[],
  env: EnvLike,
  cwd: string,
): Promise<ResolvedPython> {
  const candidates = candidatePythons(env, cwd);
  const pinned = isPinned(env);
  const tried: string[] = [];

  const sourceOf = (index: number): PythonSource => {
    if (pinned) return "PYTHON_BIN";
    if (index <= 1) return "project-venv";
    const value = candidates[index];
    return value === "python3" || value === "python" || value === "python.exe"
      ? "path"
      : "active-env";
  };

  for (let i = 0; i < candidates.length; i++) {
    tried.push(candidates[i]);
    const result = await probe(candidates[i], required);
    if (result && satisfies(result, required)) {
      return { ...result, source: sourceOf(i) };
    }
  }

  // Explicit config is never silently overridden.
  if (pinned) {
    throw new PythonUnavailableError(
      formatUnavailableError(required, tried, true),
      tried,
    );
  }

  const discovered = await discoverEnvInterpreters(env);
  const probes = (
    await Promise.all(discovered.map((bin) => probe(bin, required)))
  ).filter((p): p is PythonProbe => p !== null);
  tried.push(...discovered);

  const best = rankProbes(probes, required)[0];
  if (best) {
    console.info(
      `[python-runtime] ${required.join(", ")} not found on PATH; using ` +
        `${best.bin} (${required
          .map((m) => `${m} ${best.modules[m]}`)
          .join(", ")}). Set PYTHON_BIN to pin a different interpreter.`,
    );
    return { ...best, source: "discovered" };
  }

  throw new PythonUnavailableError(
    formatUnavailableError(required, tried, false),
    tried,
  );
}

/**
 * Resolve an interpreter that can import every module in `required`.
 * Memoised for {@link CACHE_TTL_MS} so a click doesn't re-probe the machine.
 *
 * @throws {PythonUnavailableError} when no interpreter satisfies the modules.
 */
export function resolvePython(
  required: string[],
  env: EnvLike = process.env,
  cwd: string = process.cwd(),
): Promise<ResolvedPython> {
  const key = cacheKey(required, env);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = resolveUncached(required, env, cwd);
  cache.set(key, { at: Date.now(), value });
  // A failure shouldn't be remembered: the user is likely fixing it right now.
  value.catch(() => cache.delete(key));
  return value;
}
