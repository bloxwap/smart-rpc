const { readFileSync } = require("node:fs");

const packageDirectory = "packages/smart-rpc";

function readRelease() {
  const { name, version } = JSON.parse(
    readFileSync(`${packageDirectory}/package.json`, "utf8"),
  );
  const changelog = readFileSync(`${packageDirectory}/CHANGELOG.md`, "utf8");
  const section = changelog.split(/^## /m).find((entry) => entry.startsWith(`${version}\n`));
  if (!section) throw new Error(`Missing changelog for ${name}@${version}`);
  return { name, version, notes: section.slice(version.length).trim() };
}

async function needsPublish({ name, version }, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return true;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const published = await response.json();
  if (published.name !== name || published.version !== version) {
    throw new Error("npm registry returned unexpected package metadata");
  }
  return false;
}

async function createGithubRelease({ github, context }, release = readRelease()) {
  const tag = `${release.name}@${release.version}`;
  try {
    await github.rest.repos.getReleaseByTag({ ...context.repo, tag });
    return; // A rerun after publication must not duplicate the release.
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  // GitHub creates the tag at this workflow's commit when it creates the release.
  await github.rest.repos.createRelease({
    ...context.repo,
    tag_name: tag,
    target_commitish: context.sha,
    name: tag,
    body: release.notes,
    prerelease: release.version.includes("-"),
  });
}

module.exports = { readRelease, needsPublish, createGithubRelease };
