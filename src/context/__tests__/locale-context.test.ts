import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider, useLocale, useT } from "../locale-context";
import type { Locale } from "@/i18n/config";
import ViewerErrorBoundary from "@/app/viewer/[encodedPath]/[episode]/error";

const reloadPath = "../locale-context.tsx?locale-reload-regression";
const reloaded: typeof import("../locale-context") = await import(reloadPath);

function withLocale(
  children: ReactNode,
  initialLocale: Locale = "zh",
  Provider = LocaleProvider,
) {
  const props = { initialLocale, children };
  return createElement(Provider, props);
}

function OriginalConsumer() {
  const { locale } = useLocale();
  return createElement("span", { lang: locale }, useT()("review.unchecked"));
}
function ReloadedConsumer() {
  const { locale, t } = reloaded.useLocale();
  return createElement("span", { lang: locale }, t("review.unchecked"));
}

describe("locale context module reloads", () => {
  test("a reloaded consumer reads the already-mounted provider", () => {
    const html = renderToStaticMarkup(
      withLocale(createElement(ReloadedConsumer)),
    );
    expect(html).toContain('lang="zh"');
    expect(html).toContain("未检查");
  });
  test("a reloaded provider still serves existing consumers", () => {
    const html = renderToStaticMarkup(
      withLocale(
        createElement(OriginalConsumer),
        "zh",
        reloaded.LocaleProvider,
      ),
    );
    expect(html).toContain("未检查");
  });
  test("separate renders retain their own locale", () => {
    const render = (locale: Locale) =>
      renderToStaticMarkup(withLocale(createElement(ReloadedConsumer), locale));
    expect(render("zh")).toContain("未检查");
    expect(render("en")).toContain('lang="en"');
    expect(render("en")).not.toContain("未检查");
  });
  test("a truly missing provider still reports the integration error", () => {
    expect(() => renderToStaticMarkup(createElement(OriginalConsumer))).toThrow(
      "useLocale must be used within a LocaleProvider",
    );
  });
  test("nested refreshed providers keep independent translation values", () => {
    const html = renderToStaticMarkup(
      withLocale(
        createElement(
          "div",
          null,
          createElement(OriginalConsumer),
          withLocale(
            createElement(OriginalConsumer),
            "en",
            reloaded.LocaleProvider,
          ),
          createElement(ReloadedConsumer),
        ),
      ),
    );
    expect(html.match(/未检查/g)).toHaveLength(2);
    expect(html).toContain('lang="en"');
  });
  test("the active viewer error boundary renders inside the locale provider", () => {
    const html = renderToStaticMarkup(
      withLocale(
        createElement(ViewerErrorBoundary, {
          error: new Error("fixture viewer failure"),
          reset: () => {},
        }),
      ),
    );
    expect(html).toContain("fixture viewer failure");
    expect(html).toContain("重试");
  });
});
