import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const {
  assertCompleteMarkdown,
  assertDiscoveryPreserved,
  assertHttpResponseBody,
  discoverPaths,
  htmlToMarkdown,
  sourceSnapshotPath,
  shouldFallbackToHtml,
  validateLockEntry,
  validateSources,
} = (await import(new URL("../scripts/imessage-sources.mjs", import.meta.url).href)) as {
  assertCompleteMarkdown(body: string, sourceUrl: string, expectedSha256?: string): string;
  assertDiscoveryPreserved(previous: { officialPath: string }[], discovered: string[]): void;
  assertHttpResponseBody(body: string, headers: Headers, sourceUrl: string): void;
  discoverPaths(indexBody: string): string[];
  htmlToMarkdown(html: string, sourceUrl: string): string;
  shouldFallbackToHtml(error: unknown): boolean;
  sourceSnapshotPath(stagingRoot: string, officialPath: string): string;
  validateLockEntry(value: unknown, officialPath: string): void;
  validateSources(validationRoot: string, validationLockPath: string): Promise<void>;
};

const filler =
  "This paragraph supplies enough official documentation context to pass the completeness floor without hiding a truncated response.";

test("HTML fallback preserves escaped TypeScript, JSX, operators, whitespace, and nested syntax spans", () => {
  const markdown = htmlToMarkdown(
    `<html><main><h1>SDK example</h1><p>${filler}</p><pre><code><span>async function load(): Promise&lt;string&gt; {</span>\n  return &lt;Card value={a &lt; b &amp;&amp; b &gt; c} /&gt;;\n}</code></pre></main></html>`,
    "https://photon.codes/docs/example",
  );
  assert.match(markdown, /Promise<string>/u);
  assert.match(markdown, /<Card value=\{a < b && b > c\} \/>/u);
  assert.match(markdown, /async function load\(\): Promise<string> \{\n {2}return/u);
  assert.equal(markdown.includes("<span>"), false);
});

test("HTML fallback selects safe inline and fenced code delimiters", () => {
  const markdown = htmlToMarkdown(
    `<main><h1>Delimiters</h1><p>${filler}</p><p><code>value\`with\`ticks</code></p><pre><code>const fence = \`\`\`;</code></pre></main>`,
    "https://photon.codes/docs/example",
  );
  assert.match(markdown, /``value`with`ticks``/u);
  assert.match(markdown, /````\nconst fence = ```;\n````/u);
});

test("HTML fallback retains headings, lists, links, and table structure", () => {
  const markdown = htmlToMarkdown(
    `<main><h1>Reference</h1><p>${filler}</p><ul><li>First</li><li><a href="/docs/next">Next</a></li></ul><table><tr><th>Name</th><th>Value</th></tr><tr><td>mode</td><td>safe</td></tr></table></main>`,
    "https://photon.codes/docs/example",
  );
  assert.match(markdown, /^# Reference/mu);
  assert.match(markdown, /- First/u);
  assert.match(markdown, /\[Next\]\(https:\/\/photon\.codes\/docs\/next\)/u);
  assert.match(markdown, /\| Name \| Value \|\n\| --- \| --- \|\n\| mode \| safe \|/u);
  const lists = htmlToMarkdown(
    `<main><h1>Lists</h1><p>${filler}</p><ol><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol></main>`,
    "https://photon.codes/docs/example",
  );
  assert.match(lists, /1\. First\n {2}- Nested\n2\. Second/u);
});

test("HTML fallback rejects missing, incomplete, and error-page main content", () => {
  assert.throws(() =>
    htmlToMarkdown(`<article><h1>Missing</h1><p>${filler}</p></article>`, "https://photon.codes/docs/example"),
  );
  assert.throws(() => htmlToMarkdown(`<main><h1>Incomplete</h1><p>${filler}</p>`, "https://photon.codes/docs/example"));
  assert.throws(() =>
    htmlToMarkdown(`<main><h1>Application error</h1><p>${filler}</p></main>`, "https://photon.codes/docs/example"),
  );
  assert.throws(() =>
    htmlToMarkdown(
      `<main><h1>Incomplete</h1><p>${filler}</p><div>balanced text that never closes</main>`,
      "https://photon.codes/docs/example",
    ),
  );
  const complete = `# Complete\n\n${filler}\n\nFinal paragraph.\n`;
  const digest = createHash("sha256").update(complete).digest("hex");
  assert.equal(assertCompleteMarkdown(complete, "locked", digest), complete);
  assert.throws(() => assertCompleteMarkdown(`# Complete\n\n${filler}\n`, "locked", digest));
});

test("source retrieval rejects partial and length-mismatched HTTP bodies", () => {
  assert.doesNotThrow(() => assertHttpResponseBody("complete", new Headers({ "content-length": "8" }), "source"));
  assert.throws(() => assertHttpResponseBody("complete", new Headers(), "source"));
  assert.throws(() => assertHttpResponseBody("partial", new Headers({ "content-range": "bytes 0-6/20" }), "source"));
  assert.throws(() => assertHttpResponseBody("short", new Headers({ "content-length": "20" }), "source"));
  assert.throws(() =>
    assertHttpResponseBody("complete", new Headers({ "content-length": "8", "content-encoding": "gzip" }), "source"),
  );
  assert.equal(shouldFallbackToHtml(new Error("HTTP_404:source")), true);
  assert.equal(shouldFallbackToHtml(new Error("PARTIAL_HTTP_BODY:source")), false);
  assert.equal(shouldFallbackToHtml(new Error("UNSTABLE_HTTP_BODY:source")), false);
  assert.doesNotThrow(() =>
    assertDiscoveryPreserved([{ officialPath: "spectrum-ts/messages" }], ["spectrum-ts/messages", "new"]),
  );
  assert.throws(() => assertDiscoveryPreserved([{ officialPath: "spectrum-ts/messages" }], ["new"]));
});

test("source discovery rejects traversal before a staging destination can be written", async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), "qm-imessage-source-traversal-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const index = "[escape](https://photon.codes/docs/advanced-kits/imessage/../../outside)";
  assert.throws(() => discoverPaths(index), /SOURCE_DISCOVERY_PATH_UNSAFE/u);
  assert.throws(
    () => sourceSnapshotPath(temporary, "advanced-kits/imessage/../../outside"),
    /SOURCE_DISCOVERY_PATH_UNSAFE/u,
  );
  await assert.rejects(() => access(resolve(temporary, "docs/imessage/outside.md")));
});

test("source lock entries reject unsafe paths and contradictory provenance", () => {
  const valid = {
    officialPath: "spectrum-ts/messages",
    originUrl: "https://photon.codes/docs/spectrum-ts/messages",
    resolvedUrl: "https://photon.codes/docs/spectrum-ts/messages.md",
    retrievedAt: "2026-09-10T12:00:00.000Z",
    sha256: "a".repeat(64),
    localMarkdownPath: "docs/imessage/sources/photon/spectrum-ts/messages.md",
    retrievalFormat: "official-markdown",
  };
  assert.doesNotThrow(() => validateLockEntry(valid, valid.officialPath));
  assert.throws(() =>
    validateLockEntry({ ...valid, localMarkdownPath: "docs/imessage/sources/photon/../secret" }, valid.officialPath),
  );
  assert.throws(() => validateLockEntry({ ...valid, originUrl: "https://example.com/messages" }, valid.officialPath));
  assert.throws(() => validateLockEntry({ ...valid, resolvedUrl: "https://example.com/messages" }, valid.officialPath));
  assert.throws(() =>
    validateLockEntry({ ...valid, resolvedUrl: "https://photon.codes/docs/unrelated" }, valid.officialPath),
  );
  assert.throws(() => validateLockEntry({ ...valid, retrievalFormat: "copied" }, valid.officialPath));
  assert.throws(() => validateLockEntry({ ...valid, retrievedAt: "yesterday" }, valid.officialPath));
});

test("source validation rejects symbolic lock and snapshot files", async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), "qm-imessage-source-links-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const root = resolve(temporary, "root");
  const outside = resolve(temporary, "outside");
  await mkdir(resolve(root, "docs/imessage/sources/photon"), { recursive: true });
  await mkdir(outside, { recursive: true });
  const discovery = {
    originUrl: "https://photon.codes/docs/llms.txt",
    resolvedUrl: "https://photon.codes/docs/llms.txt",
    retrievedAt: "2026-09-10T12:00:00.000Z",
    sha256: "a".repeat(64),
    localMarkdownPath: "docs/imessage/sources/photon/llms.txt.md",
    retrievalFormat: "official-index",
  };
  const lock = resolve(root, "docs/imessage/source-lock.json");
  await writeFile(lock, `${JSON.stringify({ schemaVersion: 1, discoverySource: discovery, sources: [] })}\n`);
  const outsideSource = resolve(outside, "llms.txt.md");
  await writeFile(outsideSource, `---\n---\n\n# Outside\n\n${filler}\n`);
  await symlink(outsideSource, resolve(root, discovery.localMarkdownPath));
  await assert.rejects(() => validateSources(root, lock), /SOURCE_FILE_INVALID/u);
  const outsideLock = resolve(outside, "source-lock.json");
  await writeFile(outsideLock, `${JSON.stringify({ schemaVersion: 1, discoverySource: discovery, sources: [] })}\n`);
  const linkedLock = resolve(root, "docs/imessage/linked-lock.json");
  await symlink(outsideLock, linkedLock);
  await assert.rejects(() => validateSources(root, linkedLock), /SOURCE_LOCK_FILE_INVALID/u);
});
