#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export function assertCompleteMarkdown(body, url, expectedSha256) {
  const trimmed = body.trim();
  if (Buffer.byteLength(body) < 128) throw new Error(`EMPTY_OR_SHORT:${url}`);
  if (!/^#\s|\n#\s|^##\s|\n##\s/m.test(body)) throw new Error(`MISSING_HEADINGS:${url}`);
  if (/page not found|application error|internal server error|gateway timeout/iu.test(trimmed)) {
    throw new Error(`ERROR_PAGE:${url}`);
  }
  const fences = body.match(/^```/gmu)?.length ?? 0;
  if (fences % 2 !== 0) throw new Error(`TRUNCATED_CODE_FENCE:${url}`);
  if (expectedSha256 !== undefined && sha256(body.endsWith("\n") ? body : `${body}\n`) !== expectedSha256) {
    throw new Error(`INCOMPLETE_LOCKED_EXTRACT:${url}`);
  }
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
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function tokenizeHtml(html) {
  const tokens = [];
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening === -1) {
      tokens.push({ type: "text", value: html.slice(cursor) });
      break;
    }
    if (opening > cursor) tokens.push({ type: "text", value: html.slice(cursor, opening) });
    if (html.startsWith("<!--", opening)) {
      const end = html.indexOf("-->", opening + 4);
      if (end === -1) throw new Error("HTML_COMMENT_UNTERMINATED");
      cursor = end + 3;
      continue;
    }
    let quote = "";
    let end = opening + 1;
    while (end < html.length) {
      const character = html[end];
      if (quote !== "") {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      end += 1;
    }
    if (end >= html.length) throw new Error("HTML_TAG_UNTERMINATED");
    tokens.push({ type: "tag", value: html.slice(opening, end + 1) });
    cursor = end + 1;
  }
  return tokens;
}

function parseAttributes(tag) {
  const attributes = {};
  const body = tag.replace(/^<\/?\s*[\w:-]+/u, "").replace(/\/?>$/u, "");
  for (const match of body.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function parseHtml(html) {
  const rootNode = { type: "element", tag: "root", attributes: {}, children: [], closed: true };
  const stack = [rootNode];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source"]);
  for (const token of tokenizeHtml(html)) {
    if (token.type === "text") {
      stack.at(-1).children.push(token);
      continue;
    }
    if (token.value.startsWith("<!")) continue;
    const closing = token.value.match(/^<\/\s*([\w:-]+)/u);
    if (closing !== null) {
      const tag = closing[1].toLowerCase();
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index === -1) continue;
      stack[index].closed = true;
      stack.length = index;
      continue;
    }
    const opening = token.value.match(/^<\s*([\w:-]+)/u);
    if (opening === null) continue;
    const tag = opening[1].toLowerCase();
    const node = { type: "element", tag, attributes: parseAttributes(token.value), children: [], closed: false };
    stack.at(-1).children.push(node);
    if (voidTags.has(tag) || /\/\s*>$/u.test(token.value)) node.closed = true;
    else stack.push(node);
  }
  return rootNode;
}

function findElement(node, tag) {
  if (node.type === "element" && node.tag === tag) return node;
  if (node.type !== "element") return undefined;
  for (const child of node.children) {
    const found = findElement(child, tag);
    if (found !== undefined) return found;
  }
  return undefined;
}

function hasUnclosedDescendant(node) {
  return (
    node.type === "element" &&
    node.children.some((child) => child.type === "element" && (!child.closed || hasUnclosedDescendant(child)))
  );
}

function backtickDelimiter(value, minimum) {
  const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
  return "`".repeat(Math.max(minimum, longest + 1));
}

function textContent(node, preserveWhitespace = false) {
  if (node.type === "text") return decodeEntities(node.value);
  const value = node.children.map((child) => textContent(child, preserveWhitespace)).join("");
  return preserveWhitespace ? value : value.replace(/\s+/gu, " ").trim();
}

function descendants(node, tags) {
  if (node.type !== "element") return [];
  return node.children.flatMap((child) => [
    ...(child.type === "element" && tags.has(child.tag) ? [child] : []),
    ...descendants(child, tags),
  ]);
}

function renderNode(node, url, codeBlocks) {
  if (node.type === "text") return decodeEntities(node.value).replace(/[ \t\r\n]+/gu, " ");
  if (node.tag === "script" || node.tag === "style") return "";
  if (node.tag === "pre") {
    const code = textContent(node, true).replace(/^\n|\n$/gu, "");
    const marker = `PHOTON_CODE_BLOCK_${codeBlocks.length}`;
    const fence = backtickDelimiter(code, 3);
    codeBlocks.push(`${fence}\n${code}\n${fence}`);
    return `\n\n${marker}\n\n`;
  }
  const rendered = () => node.children.map((child) => renderNode(child, url, codeBlocks)).join("");
  if (/^h[1-6]$/u.test(node.tag)) return `\n\n${"#".repeat(Number(node.tag[1]))} ${rendered().trim()}\n\n`;
  if (node.tag === "a") return `[${rendered().trim()}](${new URL(node.attributes.href ?? "", url)})`;
  if (node.tag === "img") return `![${node.attributes.alt ?? ""}](${new URL(node.attributes.src ?? "", url)})`;
  if (node.tag === "code") {
    const code = textContent(node, true);
    const delimiter = backtickDelimiter(code, 1);
    const padding = code.startsWith("`") || code.endsWith("`") ? " " : "";
    return `${delimiter}${padding}${code}${padding}${delimiter}`;
  }
  if (node.tag === "ul" || node.tag === "ol") return `\n\n${renderList(node, url, codeBlocks)}\n\n`;
  if (node.tag === "li") return rendered().trim();
  if (node.tag === "blockquote") {
    return `\n\n${rendered()
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\n`;
  }
  if (node.tag === "table") {
    const rows = descendants(node, new Set(["tr"]));
    const renderedRows = rows.map((row) => descendants(row, new Set(["th", "td"])).map((cell) => textContent(cell)));
    if (renderedRows.length === 0) return "";
    const width = Math.max(...renderedRows.map((row) => row.length));
    const lines = renderedRows.map((row) => `| ${[...row, ...Array(width - row.length).fill("")].join(" | ")} |`);
    lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
    return `\n\n${lines.join("\n")}\n\n`;
  }
  if (node.tag === "tr" || node.tag === "th" || node.tag === "td") return "";
  if (node.tag === "br") return "  \n";
  if (node.tag === "hr") return "\n\n---\n\n";
  if (["p", "div", "section", "article", "details"].includes(node.tag)) {
    return `\n\n${rendered().trim()}\n\n`;
  }
  return rendered();
}

function renderList(node, url, codeBlocks, depth = 0) {
  const items = node.children.filter((child) => child.type === "element" && child.tag === "li");
  return items
    .map((item, index) => {
      const nested = item.children.filter(
        (child) => child.type === "element" && (child.tag === "ul" || child.tag === "ol"),
      );
      const body = item.children
        .filter((child) => !nested.includes(child))
        .map((child) => renderNode(child, url, codeBlocks))
        .join("")
        .trim();
      const prefix = node.tag === "ol" ? `${index + 1}.` : "-";
      const line = `${"  ".repeat(depth)}${prefix} ${body}`;
      const descendants = nested.map((child) => renderList(child, url, codeBlocks, depth + 1)).join("\n");
      return descendants.length === 0 ? line : `${line}\n${descendants}`;
    })
    .join("\n");
}

export function htmlToMarkdown(html, url) {
  const main = findElement(parseHtml(html), "main");
  if (main === undefined || !main.closed || hasUnclosedDescendant(main)) throw new Error(`HTML_MAIN_MISSING:${url}`);
  const codeBlocks = [];
  let value = renderNode(main, url, codeBlocks)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  codeBlocks.forEach((block, index) => {
    value = value.replace(`PHOTON_CODE_BLOCK_${index}`, block);
  });
  return assertCompleteMarkdown(`${value}\n`, url);
}

export function assertHttpResponseBody(body, headers, url) {
  const contentRange = headers.get("content-range");
  if (contentRange !== null) throw new Error(`PARTIAL_HTTP_BODY:${url}:${contentRange}`);
  const contentLength = headers.get("content-length");
  if (contentLength === null) throw new Error(`HTTP_LENGTH_MISSING:${url}`);
  const contentEncoding = headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding !== "identity") {
    throw new Error(`HTTP_CONTENT_ENCODING_UNEXPECTED:${url}:${contentEncoding}`);
  }
  if (Number(contentLength) !== Buffer.byteLength(body)) {
    throw new Error(`HTTP_LENGTH_MISMATCH:${url}:${contentLength}:${Buffer.byteLength(body)}`);
  }
}

export function shouldFallbackToHtml(error) {
  return error instanceof Error && /^(?:HTTP_(?:404|406|415)|NOT_MARKDOWN):/u.test(error.message);
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "text/markdown, text/plain;q=0.9, text/html;q=0.5", "accept-encoding": "identity" },
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
  const body = await response.text();
  assertHttpResponseBody(body, response.headers, url);
  return { response, body };
}

async function fetchConfirmedText(url) {
  const first = await fetchText(url);
  const second = await fetchText(url);
  if (first.response.url !== second.response.url || sha256(first.body) !== sha256(second.body)) {
    throw new Error(`UNSTABLE_HTTP_BODY:${url}`);
  }
  return first;
}

async function retrievePage(originUrl) {
  const markdownUrl = `${originUrl}.md`;
  try {
    const { response, body } = await fetchConfirmedText(markdownUrl);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/(markdown|plain)/iu.test(contentType)) throw new Error(`NOT_MARKDOWN:${markdownUrl}`);
    return {
      body: assertCompleteMarkdown(body, markdownUrl),
      resolvedUrl: response.url,
      retrievalFormat: "official-markdown",
    };
  } catch (markdownError) {
    if (!shouldFallbackToHtml(markdownError)) throw markdownError;
    const { response, body } = await fetchConfirmedText(originUrl);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) throw markdownError;
    return {
      body: htmlToMarkdown(body, response.url),
      resolvedUrl: response.url,
      retrievalFormat: "html-to-markdown",
    };
  }
}

export function discoverPaths(indexBody) {
  const links = [...indexBody.matchAll(/\]\(https:\/\/photon\.codes\/docs\/([^)?#]+)[^)]*\)/gu)].map(
    (match) => match[1],
  );
  const discovered = links.filter(
    (entry) =>
      /^spectrum-ts\/content(?:\/|$)/u.test(entry) ||
      /^spectrum-ts\/providers\/imessage\/messaging-features(?:\/|$)/u.test(entry) ||
      entry.startsWith("advanced-kits/imessage/"),
  );
  for (const entry of discovered) assertOfficialPath(entry);
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

export function assertOfficialPath(officialPath) {
  if (
    typeof officialPath !== "string" ||
    officialPath.length === 0 ||
    officialPath.split("/").some((segment) => !/^[a-z0-9][a-z0-9._-]*$/iu.test(segment))
  ) {
    throw new Error(`SOURCE_DISCOVERY_PATH_UNSAFE:${officialPath}`);
  }
}

export function sourceSnapshotPath(stagingRoot, officialPath) {
  assertOfficialPath(officialPath);
  const stagingSourceRoot = resolve(stagingRoot, "docs/imessage/sources/photon");
  const destination = resolve(stagingSourceRoot, `${officialPath}.md`);
  if (!destination.startsWith(`${stagingSourceRoot}/`)) {
    throw new Error(`SOURCE_DISCOVERY_PATH_UNSAFE:${officialPath}`);
  }
  return destination;
}

export function assertDiscoveryPreserved(previousSources, discoveredPaths) {
  const missing = previousSources
    .map((entry) => entry.officialPath)
    .filter((officialPath) => !discoveredPaths.includes(officialPath));
  if (missing.length > 0) throw new Error(`DISCOVERY_REGRESSION:${missing.join(",")}`);
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
  const index = await fetchConfirmedText(indexUrl);
  const indexBody = assertCompleteMarkdown(index.body, indexUrl);
  const officialPaths = discoverPaths(indexBody);
  let previousLock;
  try {
    previousLock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assertDiscoveryPreserved(previousLock?.sources ?? [], officialPaths);
  const stagingRoot = await mkdtemp(resolve(dirname(sourceRoot), ".photon-fetch-"));
  const stagingSourceRoot = resolve(stagingRoot, "docs/imessage/sources/photon");
  const stagingLockPath = resolve(stagingRoot, "docs/imessage/source-lock.json");
  await mkdir(stagingSourceRoot, { recursive: true });
  let sourceCount;
  try {
    const indexEntry = {
      originUrl: indexUrl,
      resolvedUrl: index.response.url,
      retrievedAt,
      sha256: sha256(indexBody),
      localMarkdownPath: "docs/imessage/sources/photon/llms.txt.md",
      retrievalFormat: "official-index",
    };
    await writeFile(resolve(stagingRoot, indexEntry.localMarkdownPath), `${provenance(indexEntry)}${indexBody}`);
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
      const destination = sourceSnapshotPath(stagingRoot, officialPath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, `${provenance(entry)}${retrieved.body}`);
      sources.push(entry);
    }
    const lock = { schemaVersion: 1, discoverySource: indexEntry, sources };
    await mkdir(dirname(stagingLockPath), { recursive: true });
    await writeFile(stagingLockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await validateSources(stagingRoot, stagingLockPath);
    const backupSourceRoot = resolve(stagingRoot, "previous-sources");
    const backupLockPath = resolve(stagingRoot, "previous-lock.json");
    let previousSourcesMoved = false;
    let previousLockMoved = false;
    try {
      if (previousLock !== undefined) {
        await rename(sourceRoot, backupSourceRoot);
        previousSourcesMoved = true;
        await rename(lockPath, backupLockPath);
        previousLockMoved = true;
      }
      await rename(stagingSourceRoot, sourceRoot);
      await rename(stagingLockPath, lockPath);
    } catch (error) {
      if (previousSourcesMoved) {
        await rm(sourceRoot, { recursive: true, force: true });
        await rename(backupSourceRoot, sourceRoot);
      }
      if (previousLockMoved) {
        await rm(lockPath, { force: true });
        await rename(backupLockPath, lockPath);
      }
      throw error;
    }
    sourceCount = sources.length;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  process.stdout.write(`FETCHED:${sourceCount}\n`);
}

export function sourceBody(file) {
  if (!file.startsWith("---\n")) throw new Error("PROVENANCE_MISSING");
  const boundary = file.indexOf(provenanceEnd, 4);
  if (boundary === -1) throw new Error("PROVENANCE_TRUNCATED");
  return file.slice(boundary + provenanceEnd.length);
}

export function validateLockEntry(entry, expectedOfficialPath) {
  if (typeof entry !== "object" || entry === null) throw new Error("SOURCE_LOCK_ENTRY_INVALID");
  const expectedPath =
    expectedOfficialPath === undefined
      ? "docs/imessage/sources/photon/llms.txt.md"
      : `docs/imessage/sources/photon/${expectedOfficialPath}.md`;
  if (entry.localMarkdownPath !== expectedPath || entry.localMarkdownPath.includes("..")) {
    throw new Error(`SOURCE_PATH_UNSAFE:${entry.localMarkdownPath}`);
  }
  const expectedOrigin =
    expectedOfficialPath === undefined ? indexUrl : `https://photon.codes/docs/${expectedOfficialPath}`;
  if (entry.originUrl !== expectedOrigin) throw new Error(`SOURCE_ORIGIN_CONTRADICTION:${entry.localMarkdownPath}`);
  const resolved = new URL(entry.resolvedUrl);
  if (resolved.protocol !== "https:" || resolved.hostname !== "photon.codes") {
    throw new Error(`SOURCE_RESOLVED_UNTRUSTED:${entry.localMarkdownPath}`);
  }
  const permittedResolved =
    expectedOfficialPath === undefined ? [expectedOrigin] : [expectedOrigin, `${expectedOrigin}.md`];
  if (!permittedResolved.includes(resolved.href)) {
    throw new Error(`SOURCE_RESOLVED_CONTRADICTION:${entry.localMarkdownPath}`);
  }
  const permittedFormats =
    expectedOfficialPath === undefined ? ["official-index"] : ["official-markdown", "html-to-markdown"];
  if (!permittedFormats.includes(entry.retrievalFormat)) {
    throw new Error(`SOURCE_FORMAT_INVALID:${entry.localMarkdownPath}`);
  }
  if (typeof entry.retrievedAt !== "string" || new Date(entry.retrievedAt).toISOString() !== entry.retrievedAt) {
    throw new Error(`SOURCE_RETRIEVED_AT_INVALID:${entry.localMarkdownPath}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error(`SOURCE_HASH_INVALID:${entry.localMarkdownPath}`);
}

function sourceProvenance(file) {
  if (!file.startsWith("---\n")) throw new Error("PROVENANCE_MISSING");
  const boundary = file.indexOf(provenanceEnd, 4);
  if (boundary === -1) throw new Error("PROVENANCE_TRUNCATED");
  const values = {};
  for (const line of file.slice(4, boundary).split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) throw new Error("PROVENANCE_INVALID");
    values[line.slice(0, separator)] = JSON.parse(line.slice(separator + 2));
  }
  return values;
}

async function validateEntry(entry, expectedOfficialPath, validationRoot = root) {
  validateLockEntry(entry, expectedOfficialPath);
  const path = resolve(validationRoot, entry.localMarkdownPath);
  const [entryLstat, entryStat, canonicalRoot, canonicalPath] = await Promise.all([
    lstat(path),
    stat(path),
    realpath(validationRoot),
    realpath(path),
  ]);
  if (entryLstat.isSymbolicLink() || !entryStat.isFile() || !canonicalPath.startsWith(`${canonicalRoot}/`)) {
    throw new Error(`SOURCE_FILE_INVALID:${entry.localMarkdownPath}`);
  }
  const local = await readFile(path, "utf8");
  const metadata = sourceProvenance(local);
  for (const [metadataKey, entryKey] of [
    ["source_origin", "originUrl"],
    ["source_resolved", "resolvedUrl"],
    ["retrieved_at", "retrievedAt"],
    ["source_sha256", "sha256"],
    ["retrieval_format", "retrievalFormat"],
  ]) {
    if (metadata[metadataKey] !== entry[entryKey])
      throw new Error(`SOURCE_PROVENANCE_CONTRADICTION:${entry.localMarkdownPath}:${metadataKey}`);
  }
  const body = sourceBody(local);
  assertCompleteMarkdown(body, entry.localMarkdownPath, entry.sha256);
  if (sha256(body) !== entry.sha256) throw new Error(`SOURCE_HASH_MISMATCH:${entry.localMarkdownPath}`);
}

export async function validateSources(validationRoot = root, validationLockPath = lockPath) {
  const [lockLstat, lockStat, canonicalRoot, canonicalLock] = await Promise.all([
    lstat(validationLockPath),
    stat(validationLockPath),
    realpath(validationRoot),
    realpath(validationLockPath),
  ]);
  if (lockLstat.isSymbolicLink() || !lockStat.isFile() || !canonicalLock.startsWith(`${canonicalRoot}/`)) {
    throw new Error(`SOURCE_LOCK_FILE_INVALID:${validationLockPath}`);
  }
  const lock = JSON.parse(await readFile(validationLockPath, "utf8"));
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources)) throw new Error("SOURCE_LOCK_INVALID");
  validateLockEntry(lock.discoverySource);
  const indexPath = resolve(validationRoot, lock.discoverySource.localMarkdownPath);
  const indexLstat = await lstat(indexPath);
  if (indexLstat.isSymbolicLink()) throw new Error(`SOURCE_FILE_INVALID:${lock.discoverySource.localMarkdownPath}`);
  const indexLocal = await readFile(indexPath, "utf8");
  const expected = discoverPaths(sourceBody(indexLocal));
  const actual = lock.sources.map((entry) => entry.officialPath).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("SOURCE_COVERAGE_DRIFT");
  await validateEntry(lock.discoverySource, undefined, validationRoot);
  for (const entry of lock.sources) await validateEntry(entry, entry.officialPath, validationRoot);
  process.stdout.write(`VALID:${lock.sources.length}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const command = process.argv[2] ?? "fetch";
  if (command === "fetch") await fetchSources();
  else if (command === "validate") await validateSources();
  else throw new Error(`UNKNOWN_COMMAND:${command}`);
}
