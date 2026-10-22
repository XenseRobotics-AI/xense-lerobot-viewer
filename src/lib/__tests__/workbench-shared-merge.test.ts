import { describe, expect, test } from "bun:test";
import { mergeWorkbenchSharedData } from "@/lib/workbench-shared-merge";

describe("Workbench three-way data merge", () => {
  test("merges independent fields on the same record and preserves both inputs", () => {
    const base = { people: [{ id: "a", name: "A", email: "old" }] };
    const local = { people: [{ id: "a", name: "New", email: "old" }] };
    const remote = { people: [{ id: "a", name: "A", email: "new" }] };
    expect(mergeWorkbenchSharedData(local, remote, base)).toEqual({
      data: { people: [{ id: "a", name: "New", email: "new" }] },
      conflicts: [],
    });
    expect(local.people[0].email).toBe("old");
    expect(remote.people[0].name).toBe("A");
  });

  test("combines independent additions without a baseline", () => {
    const local = { people: [{ id: "a", name: "A" }] };
    const remote = { people: [{ id: "b", name: "B" }] };
    expect(mergeWorkbenchSharedData(local, remote, null)).toEqual({
      data: { people: [...local.people, ...remote.people] },
      conflicts: [],
    });
  });

  test("merges one-sided deletions without resurrecting records", () => {
    const base = {
      people: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    };
    const local = { people: [base.people[1]] };
    const remote = { people: [base.people[0], { id: "b", name: "New" }] };
    expect(mergeWorkbenchSharedData(local, remote, base)).toEqual({
      data: { people: [{ id: "b", name: "New" }] },
      conflicts: [],
    });
  });

  test("detects delete-versus-edit conflicts and honors an explicit choice", () => {
    const base = { people: [{ id: "a", name: "A" }] };
    const local = { people: [] };
    const remote = { people: [{ id: "a", name: "New" }] };
    expect(mergeWorkbenchSharedData(local, remote, base).conflicts).toEqual([
      'people["a"]',
    ]);
    expect(mergeWorkbenchSharedData(local, remote, base, "local").data).toEqual(
      local,
    );
    expect(
      mergeWorkbenchSharedData(local, remote, base, "remote").data,
    ).toEqual(remote);
  });

  test("keeps nonconflicting changes when choosing conflicting fields", () => {
    const base = { name: "A", enabled: true, target: 6 };
    const local = { name: "B", enabled: false, target: 6 };
    const remote = { name: "C", enabled: true, target: 8 };
    expect(mergeWorkbenchSharedData(local, remote, base, "remote")).toEqual({
      data: { name: "C", enabled: false, target: 8 },
      conflicts: ["name"],
    });
  });

  test("merges histories by date, staffing by station and date, and members by person", () => {
    const base = {
      devices: [{ id: "d", assignmentHistory: [] }],
      staffingHistory: [],
    };
    const local = {
      devices: [
        {
          id: "d",
          assignmentHistory: [
            { effectiveDate: "2026-09-01", workstationId: "a" },
          ],
        },
      ],
      staffingHistory: [
        {
          workstationId: "a",
          effectiveDate: "2026-09-01",
          members: [{ personId: "p1" }],
        },
      ],
    };
    const remote = {
      devices: [
        {
          id: "d",
          assignmentHistory: [
            { effectiveDate: "2026-09-02", workstationId: "b" },
          ],
        },
      ],
      staffingHistory: [
        {
          workstationId: "a",
          effectiveDate: "2026-09-01",
          members: [{ personId: "p2" }],
        },
      ],
    };
    const result = mergeWorkbenchSharedData(local, remote, base);
    expect(result.conflicts).toEqual([]);
    const data = result.data as typeof local;
    expect(data.devices[0].assignmentHistory).toHaveLength(2);
    expect(data.staffingHistory[0].members).toEqual([
      { personId: "p1" },
      { personId: "p2" },
    ]);
  });

  test("does not treat array reordering as independent field changes", () => {
    const base = {
      people: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    };
    const local = { people: [...base.people].reverse() };
    const remote = { people: [{ id: "a", name: "New" }, base.people[1]] };
    expect(mergeWorkbenchSharedData(local, remote, base)).toEqual({
      data: remote,
      conflicts: [],
    });
  });
});
