import Link from "next/link";

const features = [
  {
    title: "Fast by default",
    copy: "Latency-aware routing, safe-read racing, hot caching, and in-flight coalescing reduce response times and upstream traffic.",
  },
  {
    title: "One clean install",
    copy: "Every transport ships in one tree-shakeable package. Import only the chains your application uses.",
  },
  {
    title: "Built for real networks",
    copy: "Identity checks, request budgets, circuit breakers, and provider capabilities keep public and dedicated RPCs reliable.",
  },
];

export default function HomePage() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <Link href="/">Smart RPC</Link>
        <nav>
          <Link href="/docs">Documentation</Link>
          <a href="https://github.com/bloxwap/smart-rpc">GitHub</a>
        </nav>
      </header>
      <main className="landing-main">
        <div className="landing-eyebrow">Multi-chain JSON-RPC</div>
        <h1>Every chain.<br />One faster RPC.</h1>
        <p className="landing-copy">
          Smart RPC routes requests across providers using live performance data, bounded caches,
          and network-aware failover—all through one small TypeScript API.
        </p>
        <div className="landing-actions">
          <Link className="landing-button landing-button-primary" href="/docs">Explore the features</Link>
          <Link className="landing-button" href="/docs/quick-start">Quick start</Link>
        </div>
        <div className="landing-install">npm install @bloxwap/smart-rpc</div>
        <section className="landing-features" aria-label="Highlights">
          {features.map((feature) => (
            <article className="landing-feature" key={feature.title}>
              <h2>{feature.title}</h2>
              <p>{feature.copy}</p>
            </article>
          ))}
        </section>
      </main>
      <footer className="landing-footer">MIT licensed · Built by Bloxwap</footer>
    </div>
  );
}
