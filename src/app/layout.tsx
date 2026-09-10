import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import ChunkErrorReload from "@/components/chunk-error-reload";
import { LocaleProvider } from "@/context/locale-context";
import { htmlLang } from "@/i18n/config";
import { getServerLocale } from "@/i18n/locale-server";
import { MESSAGES } from "@/i18n/messages";

// Exposed as a CSS variable rather than a class so `globals.css` can append the
// CJK fallbacks. The font is local so builds do not depend on Google Fonts.
const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

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
    <html lang={htmlLang(locale)} className={inter.variable}>
      <body>
        <ChunkErrorReload />
        <LocaleProvider initialLocale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
