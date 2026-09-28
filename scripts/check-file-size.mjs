import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cachePath = resolve(repositoryRoot, ".cache/file-size-check.json");
const reviewPath = resolve(repositoryRoot, "docs/architecture/file-size-review.md");
const cacheVersion = 1;
const sourceExtensions = new Set([".ts", ".tsx", ".vue", ".css", ".html"]);
const scriptExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".sh"]);
const excludedPaths = new Set();

function listCodeFiles(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listCodeFiles(path, extensions);
    }
    if (!entry.isFile() || !extensions.has(extname(path))) {
      return [];
    }
    return [relative(repositoryRoot, path).replaceAll("\\", "/")];
  });
}

function isRootCodeConfiguration(name) {
  return name === "package.json" || name === "electron-builder.yml"
    || /^tsconfig(?:\.[^.]+)?\.json$/.test(name)
    || /(?:^|\.)config\.(?:ts|tsx|js|mjs|cjs|json|yaml|yml)$/.test(name);
}

function listFiles() {
  const rootConfigurations = readdirSync(repositoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isRootCodeConfiguration(entry.name))
    .map((entry) => entry.name);
  return [
    ...listCodeFiles(join(repositoryRoot, "src"), sourceExtensions),
    ...listCodeFiles(join(repositoryRoot, "scripts"), scriptExtensions),
    ...rootConfigurations,
  ].filter((path) => !excludedPaths.has(path)).sort();
}

function countLines(content) {
  if (content.length === 0) {
    return 0;
  }
  let lines = 1;
  for (const character of content) {
    if (character === "\n") {
      lines += 1;
    }
  }
  if (content.endsWith("\n")) {
    lines -= 1;
  }
  return lines;
}

function loadCache() {
  if (!existsSync(cachePath)) {
    return { version: cacheVersion, files: {} };
  }
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  if (cache.version !== cacheVersion) {
    process.stderr.write("行数検査cacheの版が変わったため再計算します。\n");
    return { version: cacheVersion, files: {} };
  }
  if (cache.files == null || typeof cache.files !== "object" || Array.isArray(cache.files)) {
    throw new Error("行数検査cacheの形式が不正です。");
  }
  return cache;
}

function scanFiles(paths) {
  const previous = loadCache();
  const files = {};
  let recounted = 0;
  for (const path of paths) {
    const content = readFileSync(resolve(repositoryRoot, path), "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    const cached = previous.files[path];
    if (cached?.hash === hash && Number.isInteger(cached.lines) && cached.lines >= 0) {
      files[path] = cached;
      continue;
    }
    files[path] = { hash, lines: countLines(content) };
    recounted += 1;
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  const temporaryCachePath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(temporaryCachePath, `${JSON.stringify({ version: cacheVersion, files })}\n`);
  renameSync(temporaryCachePath, cachePath);
  return { files, recounted };
}

function loadReviews() {
  const reviews = new Map();
  const lines = readFileSync(reviewPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("| `")) {
      continue;
    }
    const match = /^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/.exec(line);
    if (match == null || match[2].trim().length === 0 || match[3].trim().length === 0) {
      throw new Error(`行数レビューの記録形式が不正です: ${line}`);
    }
    const path = match[1];
    if (reviews.has(path)) {
      throw new Error(`行数レビューに重複があります: ${path}`);
    }
    reviews.set(path, { responsibility: match[2].trim(), reason: match[3].trim() });
  }
  return reviews;
}

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 1 || !["--changed", "--all"].includes(arguments_[0])) {
  throw new Error("--changedまたは--allを1つ指定してください。");
}
const paths = listFiles();
const { files, recounted } = scanFiles(paths);
const reviews = loadReviews();
let warningCount = 0;
let errorCount = 0;
for (const path of paths) {
  const lines = files[path].lines;
  if (lines > 1000) {
    process.stderr.write(`行数超過 ${path} ${lines}行: 1000行以下へ分割してください。\n`);
    errorCount += 1;
  } else if (lines > 400) {
    process.stderr.write(`分割検討 ${path} ${lines}行\n`);
    warningCount += 1;
    if (!reviews.has(path)) {
      process.stderr.write(`行数レビュー未記録 ${path} ${lines}行: docs/architecture/file-size-review.mdへ記録してください。\n`);
      errorCount += 1;
    }
  }
}
process.stdout.write(`行数検査: ${paths.length}件、再計算${recounted}件、warning${warningCount}件、error${errorCount}件。\n`);
if (errorCount > 0) {
  process.exitCode = 1;
}
