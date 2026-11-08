import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

export default withMDX({
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  basePath,
  images: { unoptimized: true },
});
