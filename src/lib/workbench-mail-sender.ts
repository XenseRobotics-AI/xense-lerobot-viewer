export type WorkbenchSmtpProvider = "qq" | "163";

export type WorkbenchMailSenderConfig = {
  sender: string;
  provider: WorkbenchSmtpProvider;
  host: "smtp.qq.com" | "smtp.163.com";
  port: 465;
};

export type WorkbenchMailSenderResult =
  | { ok: true; config: WorkbenchMailSenderConfig }
  | { ok: false; error: string };

const MAIL_ADDRESS_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u;

/**
 * Resolve the only sender identities supported by the Workbench. Keeping this
 * helper free of Node APIs lets the composer and both server routes enforce
 * exactly the same allowlist.
 */
export function resolveWorkbenchMailSender(
  value: unknown,
): WorkbenchMailSenderResult {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: "发件人不能为空。" };
  }

  const sender = value.trim();
  if (!MAIL_ADDRESS_PATTERN.test(sender)) {
    return { ok: false, error: "发件人邮箱格式无效。" };
  }

  const domain = sender.slice(sender.lastIndexOf("@") + 1).toLowerCase();
  if (domain === "xenserobotics.com") {
    return { ok: false, error: "严禁使用飞书邮箱作为发件人。" };
  }
  if (domain === "qq.com") {
    return {
      ok: true,
      config: { sender, provider: "qq", host: "smtp.qq.com", port: 465 },
    };
  }
  if (domain === "163.com") {
    return {
      ok: true,
      config: { sender, provider: "163", host: "smtp.163.com", port: 465 },
    };
  }
  return {
    ok: false,
    error: "发件人仅支持 @qq.com 或 @163.com 邮箱。",
  };
}

export function validateWorkbenchMailSender(value: unknown): string | null {
  const result = resolveWorkbenchMailSender(value);
  return result.ok ? null : result.error;
}
