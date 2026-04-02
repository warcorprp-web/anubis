import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ANUBIS - Универсальный AI прокси",
  description: "Управление AI провайдерами и прокси",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" }
    ],
    apple: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
