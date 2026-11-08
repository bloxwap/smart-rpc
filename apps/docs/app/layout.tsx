import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "Smart RPC",
    template: "%s | Smart RPC",
  },
  description: "Performance-optimized, multi-chain JSON-RPC routing for Ethereum, Solana, HyperEVM, and more.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
