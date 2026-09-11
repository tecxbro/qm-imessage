#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "docs/imessage/sources/photon");
const lockPath = resolve(root, "docs/imessage/source-lock.json");
const indexUrl = "https://photon.codes/docs/llms.txt";
const provenanceEnd = "\n---\n";

const fixedPaths = [
  "cli/installation",
  "cli/authentication",
  "cli/projects",
  "cli/spectrum",
  "api-reference/introduction",
  "spectrum-ts/getting-started",
  "spectrum-ts/messages",
  "spectrum-ts/spaces-and-users",
  "spectrum-ts/platform-narrowing",
  "spectrum-ts/custom-events-and-lifecycle",
  "spectrum-ts/providers/imessage/connection-and-routing",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertCompleteMarkdown(body, url) {
  const trimmed = body.trim();
  if (Buffer.byteLength(body) < 128) throw new Error(`EMPTY_OR_SHORT:${url}`);
  if (!/^#\s|\n#\s|^##\s|\n##\s/m.test(body)) throw new Error(`MISSING_HEADINGS:${url}`);
  if (/page not found|application error|internal server error|gateway timeout/iu.test(trimmed)) {
    throw new Error(`ERROR_PAGE:${url}`);
  }
  const fences = body.match(/^```/gmu)?.length ?? 0;
  if (fences % 2 !== 0) throw new Error(`TRUNCATED_CODE_FENCE:${url}`);
  return body.endsWith("\n") ? body : `${body}\n`;
}

function decodeEntities(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(value) {
  return decodeEntities(value.replace(/<[^>]+>/gu, ""))
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function htmlToMarkdown(html, url) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/iu)?.[1];
  if (main === undefined) throw new Error(`HTML_MAIN_MISSING:${url}`);
  let value = main
    .replace(/<script\b[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[\s\S]*?<\/style>/giu, "")
    .replace(
      /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/giu,
      (_, code) => `\n\n\`\`\`\n${decodeEntities(code).replace(/<[^>]+>/gu, "")}\n\`\`\`\n\n`,
    )
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu,
      (_, level, text) => `\n\n${"#".repeat(Number(level))} ${stripTags(text)}\n\n`,
    )
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
      (_, href, text) => `[${stripTags(text)}](${new URL(decodeEntities(href), url)})`,
    )
    .replace(
      /<img\b[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/giu,
      (_, src, alt) => `![${decodeEntities(alt)}](${new URL(decodeEntities(src), url)})`,
    )
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/giu, (_, code) => `\`${stripTags(code)}\``)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/giu, (_, item) => `\n- ${stripTags(item)}`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/giu, (_, quote) => `\n\n> ${stripTags(quote)}\n\n`)
    .replace(
      /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu,
      (_, row) =>
        `\n| ${[...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/giu)].map((cell) => stripTags(cell[1])).join(" | ")} |`,
    )
    .replace(/<br\s*\/?\s*>/giu, "  \n")
    .replace(/<hr\b[^>]*>/giu, "\n\n---\n\n")
    .replace(/<\/(p|div|section|article|ul|ol|table|details)>/giu, "\n\n")
    .replace(/<[^>]+>/gu, "");
  value = decodeEntities(value)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return assertCompleteMarkdown(`${value}\n`, url);
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "text/markdown, text/plain;q=0.9, text/html;q=0.5" },
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
  const body = await response.text();
  return { response, body };
}

async function retrievePage(originUrl) {
  const markdownUrl = `${originUrl}.md`;
  try {
    const { response, body } = await fetchText(markdownUrl);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/(markdown|plain)/iu.test(contentType)) throw new Error(`NOT_MARKDOWN:${markdownUrl}`);
    return {
      body: assertCompleteMarkdown(body, markdownUrl),
      resolvedUrl: response.url,
      retrievalFormat: "official-markdown",
    };
  } catch (markdownError) {
    const { response, body } = await fetchText(originUrl);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) throw markdownError;
    return {
      body: htmlToMarkdown(body, response.url),
      resolvedUrl: response.url,
      retrievalFormat: "html-to-markdown",
    };
  }
}

function discoverPaths(indexBody) {
  const links = [...indexBody.matchAll(/\]\(https:\/\/photon\.codes\/docs\/([^)?#]+)[^)]*\)/gu)].map(
    (match) => match[1],
  );
  const discovered = links.filter(
    (entry) =>
      /^spectrum-ts\/content(?:\/|$)/u.test(entry) ||
      /^spectrum-ts\/providers\/imessage\/messaging-features(?:\/|$)/u.test(entry) ||
      /^advanced-kits\/imessage\//u.test(entry),
  );
  const paths = [...new Set([...fixedPaths, ...discovered])].sort();
  const families = [
    ["spectrum-content", /^spectrum-ts\/content(?:\/|$)/u],
    ["imessage-features", /^spectrum-ts\/providers\/imessage\/messaging-features(?:\/|$)/u],
    ["advanced-imessage", /^advanced-kits\/imessage\//u],
  ];
  for (const [name, pattern] of families) {
    if (!paths.some((entry) => pattern.test(entry))) throw new Error(`INDEX_FAMILY_MISSING:${name}`);
  }
  for (const required of fixedPaths) {
    if (!paths.includes(required)) throw new Error(`REQUIRED_SOURCE_MISSING:${required}`);
  }
  return paths;
}

function provenance(entry) {
  return [
    "---",
    `source_origin: ${JSON.stringify(entry.originUrl)}`,
    `source_resolved: ${JSON.stringify(entry.resolvedUrl)}`,
    `retrieved_at: ${JSON.stringify(entry.retrievedAt)}`,
    `source_sha256: ${JSON.stringify(entry.sha256)}`,
    `retrieval_format: ${JSON.stringify(entry.retrievalFormat)}`,
    "---",
    "",
  ].join("\n");
}

async function fetchSources() {
  const retrievedAt = new Date().toISOString();
  const index = await fetchText(indexUrl);
  const indexBody = assertCompleteMarkdown(index.body, indexUrl);
  const officialPaths = discoverPaths(indexBody);
  await mkdir(sourceRoot, { recursive: true });
  const indexEntry = {
    originUrl: indexUrl,
    resolvedUrl: index.response.url,
    retrievedAt,
    sha256: sha256(indexBody),
    localMarkdownPath: "docs/imessage/sources/photon/llms.txt.md",
    retrievalFormat: "official-index",
  };
  await writeFile(resolve(root, indexEntry.localMarkdownPath), `${provenance(indexEntry)}${indexBody}`);
  const sources = [];
  for (const officialPath of officialPaths) {
    const originUrl = `https://photon.codes/docs/${officialPath}`;
    const retrieved = await retrievePage(originUrl);
    const entry = {
      officialPath,
      originUrl,
      resolvedUrl: retrieved.resolvedUrl,
      retrievedAt,
      sha256: sha256(retrieved.body),
      localMarkdownPath: `docs/imessage/sources/photon/${officialPath}.md`,
      retrievalFormat: retrieved.retrievalFormat,
    };
    const destination = resolve(root, entry.localMarkdownPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${provenance(entry)}${retrieved.body}`);
    sources.push(entry);
  }
  const lock = { schemaVersion: 1, discoverySource: indexEntry, sources };
  const temporary = `${lockPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`);
  await rename(temporary, lockPath);
  process.stdout.write(`FETCHED:${sources.length}\n`);
}

function sourceBody(file) {
  if (!file.startsWith("---\n")) throw new Error("PROVENANCE_MISSING");
  const boundary = file.indexOf(provenanceEnd, 4);
  if (boundary === -1) throw new Error("PROVENANCE_TRUNCATED");
  return file.slice(boundary + provenanceEnd.length);
}

async function validateEntry(entry) {
  const local = await readFile(resolve(root, entry.localMarkdownPath), "utf8");
  const body = sourceBody(local);
  assertCompleteMarkdown(body, entry.localMarkdownPath);
  if (sha256(body) !== entry.sha256) throw new Error(`SOURCE_HASH_MISMATCH:${entry.localMarkdownPath}`);
}

async function validateSources() {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources)) throw new Error("SOURCE_LOCK_INVALID");
  const indexLocal = await readFile(resolve(root, lock.discoverySource.localMarkdownPath), "utf8");
  const expected = discoverPaths(sourceBody(indexLocal));
  const actual = lock.sources.map((entry) => entry.officialPath).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("SOURCE_COVERAGE_DRIFT");
  await validateEntry(lock.discoverySource);
  for (const entry of lock.sources) await validateEntry(entry);
  process.stdout.write(`VALID:${lock.sources.length}\n`);
}

const command = process.argv[2] ?? "fetch";
if (command === "fetch") await fetchSources();
else if (command === "validate") await validateSources();
else throw new Error(`UNKNOWN_COMMAND:${command}`);
