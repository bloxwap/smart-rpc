import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Smart RPC",
    },
    links: [
      {
        text: "GitHub",
        url: "https://github.com/bloxwap/smart-rpc",
        external: true,
      },
    ],
  };
}
