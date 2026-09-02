import { describe, expect, test } from "bun:test";
import {
  createDefaultWorkbenchMailDraft,
  readWorkbenchMailDraft,
  saveWorkbenchMailDraft,
  validateWorkbenchMailDraft,
  workbenchMailDraftStorageKey,
} from "@/lib/workbench-mail-draft";

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe("workbench mail draft", () => {
  test("provides the default sender, recipient, subject, and body", () => {
    expect(createDefaultWorkbenchMailDraft()).toEqual({
      sender: "1796262052@qq.com",
      recipient: "frank@xenserobotics.com",
      subject: "SMTP smoketest",
      body: "",
    });
  });

  test("saves and restores drafts per organization", () => {
    const storage = createMemoryStorage();
    const draft = {
      sender: "ignored@example.com",
      recipient: " ops@xenserobotics.com ",
      subject: " SMTP smoketest extra ",
      body: "Plain text body",
    };

    const saved = saveWorkbenchMailDraft("TacVerse", draft, storage);

    expect(saved).toEqual({
      sender: "1796262052@qq.com",
      recipient: "ops@xenserobotics.com",
      subject: "SMTP smoketest extra",
      body: "Plain text body",
    });
    expect(readWorkbenchMailDraft("TacVerse", storage)).toEqual(saved);
    expect(readWorkbenchMailDraft("OtherOrg", storage)).toEqual(
      createDefaultWorkbenchMailDraft(),
    );
    expect(storage.getItem(workbenchMailDraftStorageKey("TacVerse"))).toContain(
      '"org":"TacVerse"',
    );
  });

  test("rejects missing required fields", () => {
    const draft = createDefaultWorkbenchMailDraft();

    expect(validateWorkbenchMailDraft({ ...draft, recipient: " " })).toBe(
      "收件人不能为空。",
    );
    expect(validateWorkbenchMailDraft({ ...draft, subject: " " })).toBe(
      "主题不能为空。",
    );
    expect(validateWorkbenchMailDraft({ ...draft, body: "   " })).toBe(
      "正文不能为空。",
    );
  });
});
