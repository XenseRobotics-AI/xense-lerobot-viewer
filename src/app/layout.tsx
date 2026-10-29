import type { Metadata } from "next";
import "./globals.css";
import ChunkErrorReload from "@/components/chunk-error-reload";
import { LocaleProvider } from "@/context/locale-context";
import { htmlLang } from "@/i18n/config";
import { getServerLocale } from "@/i18n/locale-server";
import { MESSAGES } from "@/i18n/messages";

export async function generateMetadata(): Promise<Metadata> {
  const messages = MESSAGES[await getServerLocale()];
  return {
    title: messages["app.title"],
    description: messages["app.description"],
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getServerLocale();

  return (
    <html lang={htmlLang(locale)}>
      <body>
        <ChunkErrorReload />
        <LocaleProvider initialLocale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
