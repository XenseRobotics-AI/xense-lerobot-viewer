import { afterEach, describe, expect, test } from "bun:test";
import {
  MODELSCOPE_DEFAULT_REPO,
  resolveModelScopeTarget,
} from "@/utils/modelscopeValidation";

const previousRepo = process.env.MODELSCOPE_DATASET_REPO;

afterEach(() => {
  if (previousRepo === undefined) delete process.env.MODELSCOPE_DATASET_REPO;
  else process.env.MODELSCOPE_DATASET_REPO = previousRepo;
});

describe("ModelScope repository validation", () => {
  test("maps the logical TacVerse organization to its nested repository", () => {
    delete process.env.MODELSCOPE_DATASET_REPO;
    expect(resolveModelScopeTarget("TacVerse")).toEqual({
      owner: "XenseRobotics",
      name: "TacVerse",
      repoId: MODELSCOPE_DEFAULT_REPO,
      logicalOrg: "TacVerse",
    });
  });

  test("accepts an explicit owner/repository identifier", () => {
    expect(resolveModelScopeTarget("XenseRobotics/TacVerse")).toMatchObject({
      owner: "XenseRobotics",
      name: "TacVerse",
      repoId: "XenseRobotics/TacVerse",
      logicalOrg: "TacVerse",
    });
  });

  test("allows a server configured nested repository", () => {
    process.env.MODELSCOPE_DATASET_REPO = "ExampleOrg/RobotData";
    expect(resolveModelScopeTarget("")).toMatchObject({
      owner: "ExampleOrg",
      name: "RobotData",
      logicalOrg: "RobotData",
    });
  });
});
