const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readRelease, needsPublish, createGithubRelease } = require("./release.cjs");

const release = { name: "@bloxwap/smart-rpc", version: "1.2.3", notes: "Release notes" };

test("only an absent npm version needs publishing", async () => {
  assert.equal(await needsPublish(release, async (url) => {
    assert.equal(url, "https://registry.npmjs.org/%40bloxwap%2Fsmart-rpc/1.2.3");
    return new Response(null, { status: 404 });
  }), true);
  assert.equal(await needsPublish(release, async () => Response.json(release)), false);
});

test("registry failures cannot be mistaken for unpublished versions", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(needsPublish(release, async () => new Response(null, { status })), /npm registry returned HTTP/);
  }
  await assert.rejects(needsPublish(release, async () => { throw new Error("Network failure"); }), /Network failure/);
  await assert.rejects(needsPublish(release, async () => Response.json({ ...release, version: "1.2.2" })), /unexpected package metadata/);
});

test("release notes include only the current package version", () => {
  const current = readRelease();
  assert.equal(current.name, "@bloxwap/smart-rpc");
  assert.ok(current.notes.length > 0);
  assert.doesNotMatch(current.notes, /^## /m);
});

function client(getReleaseByTag) {
  const created = [];
  return {
    created,
    context: { repo: { owner: "bloxwap", repo: "smart-rpc" }, sha: "release-commit" },
    github: { rest: { repos: {
      getReleaseByTag,
      createRelease: async (input) => created.push(input),
    } } },
  };
}

test("GitHub release uses package tag, changelog, and exact workflow commit", async () => {
  const api = client(async () => { throw Object.assign(new Error("Not found"), { status: 404 }); });
  await createGithubRelease(api, release);
  assert.deepEqual(api.created, [{
    owner: "bloxwap", repo: "smart-rpc", tag_name: "@bloxwap/smart-rpc@1.2.3",
    target_commitish: "release-commit", name: "@bloxwap/smart-rpc@1.2.3",
    body: "Release notes", prerelease: false,
  }]);
});

test("rerunning a completed GitHub release does not create duplicates", async () => {
  const api = client(async () => ({ data: { id: 123 } }));
  await createGithubRelease(api, release);
  assert.deepEqual(api.created, []);
});

test("GitHub lookup failures fail without attempting release creation", async () => {
  const api = client(async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); });
  await assert.rejects(createGithubRelease(api, release), /Forbidden/);
  assert.deepEqual(api.created, []);
});
