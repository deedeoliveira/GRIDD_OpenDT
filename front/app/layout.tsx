import type { Metadata } from "next";
import { HeroProvider } from "./HeroProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Plataforma de Gestão de Edifícios | Universidade do Minho",
  description: "Demonstração local de investigação para gestão de edifícios.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-PT">
      <body className="antialiased">
        <HeroProvider>{children}</HeroProvider>
      </body>
    </html>
  );
}
