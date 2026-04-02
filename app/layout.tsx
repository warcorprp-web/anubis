import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ANUBIS - AI Proxy Manager",
  description: "Управление AI провайдерами и прокси",
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
