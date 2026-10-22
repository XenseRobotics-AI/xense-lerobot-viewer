import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  candidatePythons,
  compareVersions,
  condaEnvRoots,
  formatUnavailableError,
  interpreterIn,
  isPinned,
  parseProbeOutput,
  pythonSpawnEnv,
  rankProbes,
  satisfies,
  summarizeTried,
  type PythonProbe,
} from "@/lib/python-runtime";

const probeOf = (
  bin: string,
  modules: Record<string, string | null>,
): PythonProbe => ({ bin, version: "3.12.0", modules });

describe("candidatePythons", () => {
  test("PYTHON_BIN is the only candidate when set", () => {
    const list = candidatePythons(
      { PYTHON_BIN: "/opt/py/bin/python", CONDA_PREFIX: "/conda/env" },
      "/repo",
    );
    expect(list).toEqual(["/opt/py/bin/python"]);
  });

  test("blank PYTHON_BIN does not pin", () => {
    expect(isPinned({ PYTHON_BIN: "   " })).toBe(false);
    expect(
      candidatePythons({ PYTHON_BIN: "  " }, "/repo").length,
    ).toBeGreaterThan(1);
  });

  test("prefers project venvs, then the active env, then PATH", () => {
    const list = candidatePythons(
      { VIRTUAL_ENV: "/venvs/a", CONDA_PREFIX: "/conda/env" },
      "/repo",
    );
    expect(list[0]).toBe(interpreterIn(path.join("/repo", ".venv")));
    expect(list[1]).toBe(interpreterIn(path.join("/repo", "venv")));
    expect(list).toContain(interpreterIn("/venvs/a"));
    expect(list).toContain(interpreterIn("/conda/env"));
    expect(list.indexOf("python3")).toBeGreaterThan(
      list.indexOf(interpreterIn("/conda/env")),
    );
  });

  test("deduplicates when the active venv is the project venv", () => {
    const list = candidatePythons({ VIRTUAL_ENV: "/repo/.venv" }, "/repo");
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("pythonSpawnEnv", () => {
  test("strips PYTHONPATH so a sourced ROS setup cannot shadow the venv", () => {
    const env = pythonSpawnEnv({
      PYTHONPATH: "/opt/ros/humble/lib/python3.10/site-packages",
      PATH: "/usr/bin",
    });
    expect("PYTHONPATH" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });

  test("strips PYTHONHOME, which would break a venv outright", () => {
    const env = pythonSpawnEnv({ PYTHONHOME: "/usr" });
    expect("PYTHONHOME" in env).toBe(false);
  });

  test("does not mutate the environment it was given", () => {
    const base = { PYTHONPATH: "/opt/ros" };
    pythonSpawnEnv(base);
    expect(base.PYTHONPATH).toBe("/opt/ros");
  });

  test("compacts huge environments before spawning Python", () => {
    const huge = "x".repeat(80 * 1024);
    const env = pythonSpawnEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      MODELSCOPE_API_TOKEN: "ms_token",
      HF_TOKEN: "hf_token",
      CODEX_CONTEXT: huge,
      PYTHONPATH: "/opt/ros",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.MODELSCOPE_API_TOKEN).toBe("ms_token");
    expect(env.HF_TOKEN).toBe("hf_token");
    expect(env.CODEX_CONTEXT).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
  });
});

describe("condaEnvRoots", () => {
  test("includes the siblings of an active env", () => {
    const roots = condaEnvRoots(
      { CONDA_PREFIX: "/opt/mf/envs/live" },
      "/home/u",
    );
    expect(roots).toContain("/opt/mf/envs");
  });

  test("treats a base prefix as an installation root", () => {
    const roots = condaEnvRoots({ CONDA_PREFIX: "/opt/mf" }, "/home/u");
    expect(roots).toContain(path.join("/opt/mf", "envs"));
  });

  test("covers the usual installers under home", () => {
    const roots = condaEnvRoots({}, "/home/u");
    expect(roots).toContain("/home/u/miniforge3/envs");
    expect(roots).toContain("/home/u/miniconda3/envs");
    expect(roots).toContain("/home/u/anaconda3/envs");
  });

  test("splits CONDA_ENVS_PATH on the platform delimiter", () => {
    const roots = condaEnvRoots(
      { CONDA_ENVS_PATH: ["/a/envs", "/b/envs"].join(path.delimiter) },
      "/home/u",
    );
    expect(roots).toContain("/a/envs");
    expect(roots).toContain("/b/envs");
  });
});

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("1.11.0", "1.7.1")).toBeGreaterThan(0);
    expect(compareVersions("0.36.0", "1.3.4")).toBeLessThan(0);
    expect(compareVersions("1.10.1", "1.10.1")).toBe(0);
  });

  test("treats missing components as zero", () => {
    expect(compareVersions("2", "2.0.0")).toBe(0);
    expect(compareVersions("2.1", "2")).toBeGreaterThan(0);
  });

  test("sorts non-numeric parts below numeric ones", () => {
    expect(compareVersions("1.0.0", "1.0.unknown")).toBeGreaterThan(0);
  });
});

describe("satisfies / rankProbes", () => {
  const required = ["huggingface_hub"];

  test("a probe missing any module does not satisfy", () => {
    expect(satisfies(probeOf("/a", { huggingface_hub: null }), required)).toBe(
      false,
    );
    expect(
      satisfies(probeOf("/a", { pandas: "2.0", pyarrow: null }), [
        "pandas",
        "pyarrow",
      ]),
    ).toBe(false);
  });

  test("picks the highest version of the first required module", () => {
    const ranked = rankProbes(
      [
        probeOf("/envs/homie/bin/python", { huggingface_hub: "1.7.1" }),
        probeOf("/envs/lerobot/bin/python", { huggingface_hub: "1.11.0" }),
        probeOf("/envs/none/bin/python", { huggingface_hub: null }),
      ],
      required,
    );
    expect(ranked.map((p) => p.bin)).toEqual([
      "/envs/lerobot/bin/python",
      "/envs/homie/bin/python",
    ]);
  });

  test("breaks version ties on path so resolution is deterministic", () => {
    const ranked = rankProbes(
      [
        probeOf("/envs/z/bin/python", { huggingface_hub: "1.0.0" }),
        probeOf("/envs/a/bin/python", { huggingface_hub: "1.0.0" }),
      ],
      required,
    );
    expect(ranked[0].bin).toBe("/envs/a/bin/python");
  });
});

describe("parseProbeOutput", () => {
  const line = JSON.stringify({
    version: "3.12.13",
    executable: "/envs/lerobot/bin/python3.12",
    modules: { huggingface_hub: "1.11.0" },
  });

  test("reads the JSON line and prefers sys.executable over the spawn name", () => {
    const probe = parseProbeOutput("python3", line, ["huggingface_hub"]);
    expect(probe).toEqual({
      bin: "/envs/lerobot/bin/python3.12",
      version: "3.12.13",
      modules: { huggingface_hub: "1.11.0" },
    });
  });

  test("ignores noise printed before the JSON line", () => {
    const probe = parseProbeOutput("python3", `warning: something\n${line}\n`, [
      "huggingface_hub",
    ]);
    expect(probe?.modules.huggingface_hub).toBe("1.11.0");
  });

  test("reports a module the probe did not find as null", () => {
    const probe = parseProbeOutput(
      "python3",
      JSON.stringify({ version: "3.12.3", modules: { huggingface_hub: null } }),
      ["huggingface_hub", "pandas"],
    );
    expect(probe?.modules).toEqual({ huggingface_hub: null, pandas: null });
    expect(probe?.bin).toBe("python3");
  });

  test("returns null for empty or unparseable output", () => {
    expect(parseProbeOutput("python3", "", ["pandas"])).toBeNull();
    expect(parseProbeOutput("python3", "{not json", ["pandas"])).toBeNull();
    expect(parseProbeOutput("python3", "Traceback...", ["pandas"])).toBeNull();
  });
});

describe("summarizeTried", () => {
  test("lists everything when the list is short", () => {
    expect(summarizeTried(["a", "b"])).toBe("a, b");
  });

  test("truncates a scanned machine's long list", () => {
    const summary = summarizeTried(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(summary).toBe("a, b, c, d, e, f (+2 more)");
  });
});

describe("formatUnavailableError", () => {
  test("blames PYTHON_BIN when it was pinned, and offers no fallback", () => {
    const message = formatUnavailableError(
      ["huggingface_hub"],
      ["/usr/bin/python3"],
      true,
    );
    expect(message).toContain("PYTHON_BIN=/usr/bin/python3");
    expect(message).toContain("huggingface-hub"); // distribution name, not import name
  });

  test("otherwise names both fixes: install, or set PYTHON_BIN", () => {
    const message = formatUnavailableError(
      ["pandas", "pyarrow"],
      ["python3", "python"],
      false,
    );
    expect(message).toContain("pandas, pyarrow");
    expect(message).toContain("scripts/requirements.txt");
    expect(message).toContain("PYTHON_BIN");
  });
});
