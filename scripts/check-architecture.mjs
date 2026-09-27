import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  analyzeSource,
  contentHash,
  listSourceFiles,
  ownerForPath,
  readSource,
  repositoryRoot,
} from "./architecture-source.mjs";

const cachePath = resolve(repositoryRoot, ".cache/architecture-check.json");
const baselinePath = resolve(repositoryRoot, "docs/architecture/structure-migration-baseline.json");
const execFileAsync = promisify(execFile);
const cacheVersion = 3;
const originBaselineChecksum = "a05c8ca7f4886829bd723cfcd27752aac0ffce88181be7a796df6dc182faf132";
const sourceSuffixes = [".ts", ".tsx", ".vue", ".css", ".html"];
const allowedTemporaryPaths = new Set([
  "src/main/bootstrap/legacy-runtime-port.ts",
]);

function isFinalPath(path) {
  if (allowedTemporaryPaths.has(path)) return true;
  if (/\/(?:legacy-|compat-|adapter-old-)/.test(path)) return false;
  if (path === "src/main/index.ts" || path === "src/preload/index.ts") return true;
  if (path === "src/renderer/index.html" || path === "src/renderer/env.d.ts") return true;
  if (path.startsWith("src/main/domain/")) return true;
  if (path.startsWith("src/main/bootstrap/")) return true;
  if (path.startsWith("src/main/application/common/")) return true;
  if (/^src\/main\/application\/(task-read|task-write|proposal-generate|proposal-apply|gui-edit|settings|system|github-integration|obsidian-integration)\//.test(path)) return true;
  if (/^src\/main\/infrastructure\/(asana|github|obsidian|ai|persistence|logging|clock)\//.test(path)) return true;
  if (path === "src/main/ipc/register-ipc.ts" || path.startsWith("src/main/ipc/handlers/")) return true;
  if (path === "src/preload/bridge.ts") return true;
  if (path.startsWith("src/renderer/app/")) return true;
  if (/^src\/renderer\/features\/(tasks|proposals|settings|github-integration|obsidian-integration)\//.test(path)) return true;
  if (/^src\/renderer\/shared\/(api|components|logging|mock)\//.test(path)) return true;
  if (path.startsWith("src/shared/ipc-contracts/")) return true;
  return false;
}

function loadCache() {
  if (!existsSync(cachePath)) {
    return { version: cacheVersion, files: {} };
  }
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  if (cache.version !== cacheVersion) {
    process.stderr.write("構造検査cacheの版が変わったため再解析します。\n");
    return { version: cacheVersion, files: {} };
  }
  if (cache.files == null || typeof cache.files !== "object") {
    throw new Error("構造検査cacheの形式が不正です。");
  }
  return cache;
}

function scanSources(paths) {
  const previous = loadCache();
  const files = {};
  let reparsed = 0;
  for (const path of paths) {
    const content = readSource(path);
    const hash = contentHash(content);
    const cached = previous.files[path];
    if (cached?.hash === hash && Array.isArray(cached.imports)
      && Array.isArray(cached.mutable) && Array.isArray(cached.componentState)
      && Array.isArray(cached.instanceState)) {
      files[path] = cached;
      continue;
    }
    files[path] = { hash, ...analyzeSource(path, content) };
    reparsed += 1;
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  const temporaryCachePath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(temporaryCachePath, `${JSON.stringify({ version: cacheVersion, files })}\n`);
  renameSync(temporaryCachePath, cachePath);
  return { files, reparsed };
}

function resolveInternalImport(fromPath, specifier, allPaths) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const pathSpecifier = specifier.split("?")[0];
  const absolute = resolve(repositoryRoot, dirname(fromPath), pathSpecifier);
  const base = relative(repositoryRoot, absolute).replaceAll("\\", "/");
  const typescriptBase = base.replace(/\.(?:mjs|cjs|js)$/, "");
  if (base.startsWith("../") || base === "..") {
    throw new Error(`repository外へのimportです: ${fromPath}: ${specifier}`);
  }
  for (const candidate of [base, ...sourceSuffixes.map((suffix) => `${base}${suffix}`),
    ...sourceSuffixes.map((suffix) => `${base}/index${suffix}`),
    ...sourceSuffixes.map((suffix) => `${typescriptBase}${suffix}`)]) {
    if (allPaths.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function category(owner) {
  if (owner.startsWith("main/application/") && owner !== "main/application/common") {
    return "workflow";
  }
  if (owner.startsWith("main/infrastructure/")) return "infrastructure";
  if (owner.startsWith("renderer/features/")) return "renderer-feature";
  if (owner.startsWith("renderer/shared/")) return "renderer-shared";
  return owner;
}

function isPublicEntry(owner, path) {
  return path === `src/${owner}/index.ts`;
}

function isAllowedInternalImport(fromOwner, targetOwner, targetPath) {
  if (fromOwner === targetOwner) return true;
  const from = category(fromOwner);
  const target = category(targetOwner);
  if (from === "main/bootstrap") {
    return targetOwner.startsWith("main/") || targetOwner === "shared/ipc-contracts";
  }
  if (from === "main/domain") return targetOwner === "main/domain";
  if (from === "main/application/common") {
    return targetOwner === "main/domain" || targetOwner === "main/application/common";
  }
  if (from === "workflow") {
    return targetOwner === "main/domain" || targetOwner === "main/application/common";
  }
  if (from === "infrastructure") {
    return targetOwner === "main/domain"
      || targetPath.startsWith("src/main/application/common/ports/")
      || targetPath === "src/main/application/common/errors/error-reporter.ts"
      || targetPath === "src/main/application/common/errors/diagnostic-failure.ts";
  }
  if (from === "main/ipc") {
    return targetOwner === "shared/ipc-contracts"
      || targetPath === "src/main/application/common/errors/diagnostic-failure.ts"
      || target === "workflow" && isPublicEntry(targetOwner, targetPath);
  }
  if (from === "preload") return targetOwner === "shared/ipc-contracts";
  if (from === "renderer-feature") {
    return target === "renderer-shared" || targetOwner === "shared/ipc-contracts";
  }
  if (from === "renderer/app") {
    return target === "renderer-shared"
      || targetOwner === "shared/ipc-contracts"
      || target === "renderer-feature" && isPublicEntry(targetOwner, targetPath);
  }
  if (from === "renderer-shared") return targetOwner === "shared/ipc-contracts";
  if (from === "shared/ipc-contracts") return targetOwner === "shared/ipc-contracts";
  throw new Error(`import規則のないownerです: ${fromOwner}`);
}

function isForbiddenExternalImport(owner, specifier) {
  const layer = category(owner);
  if (layer === "main/domain" || layer === "main/application/common" || layer === "workflow") {
    return specifier !== "zod";
  }
  if (layer === "renderer-feature" || layer === "renderer/app" || layer === "renderer-shared") {
    return !["vue", "reka-ui", "zod"].includes(specifier);
  }
  if (layer === "preload") return specifier !== "electron";
  if (layer === "main/ipc") return !["electron", "zod"].includes(specifier);
  if (layer === "shared/ipc-contracts") {
    return specifier !== "zod";
  }
  return false;
}

function diagnostic(path, rule, symbol) {
  return { path, rule, symbol };
}

function isAllowedLegacyBridgeViolation(path, rule, symbol) {
  return path === "src/main/bootstrap/legacy-runtime-port.ts"
    && rule === "old-import"
    && symbol === "src/main/application/service.ts";
}

function collectCycles(graph) {
  const indices = new Map();
  const lowlinks = new Map();
  const stack = [];
  const inStack = new Set();
  const result = [];
  let nextIndex = 0;

  function visit(path) {
    indices.set(path, nextIndex);
    lowlinks.set(path, nextIndex);
    nextIndex += 1;
    stack.push(path);
    inStack.add(path);
    for (const target of graph.get(path)) {
      if (!indices.has(target)) {
        visit(target);
        lowlinks.set(path, Math.min(lowlinks.get(path), lowlinks.get(target)));
      } else if (inStack.has(target)) {
        lowlinks.set(path, Math.min(lowlinks.get(path), indices.get(target)));
      }
    }
    if (lowlinks.get(path) !== indices.get(path)) return;
    const members = new Set();
    let member;
    do {
      member = stack.pop();
      inStack.delete(member);
      members.add(member);
    } while (member !== path);
    if (members.size === 1 && !graph.get(path).has(path)) return;
    for (const source of members) {
      for (const target of graph.get(source)) {
        if (members.has(target)) {
          result.push(diagnostic(source, "cycle", target));
        }
      }
    }
  }

  for (const path of graph.keys()) {
    if (!indices.has(path)) visit(path);
  }
  return result;
}

function collectDiagnostics(paths, files) {
  const diagnostics = [];
  const allPaths = new Set(paths);
  const graph = new Map(paths.map((path) => [path, new Set()]));
  for (const path of paths) {
    const owner = ownerForPath(path);
    if (!isFinalPath(path)) {
      diagnostics.push(diagnostic(path, "old-path", path));
    }
    for (const symbol of files[path].mutable) {
      diagnostics.push(diagnostic(path, "module-mutable", symbol));
    }
    for (const specifier of files[path].imports) {
      const targetPath = resolveInternalImport(path, specifier, allPaths);
      if (targetPath == null) {
        if (!specifier.startsWith(".") && isForbiddenExternalImport(owner, specifier)) {
          diagnostics.push(diagnostic(path, "external-import", specifier));
        }
        continue;
      }
      graph.get(path).add(targetPath);
      if (!isFinalPath(targetPath)
        && !isAllowedLegacyBridgeViolation(path, "old-import", targetPath)) {
        diagnostics.push(diagnostic(path, "old-import", targetPath));
      }
      if (!isAllowedInternalImport(owner, ownerForPath(targetPath), targetPath)) {
        diagnostics.push(diagnostic(path, "import-boundary", targetPath));
      }
      if (owner === "main/bootstrap" && ownerForPath(targetPath) !== "main/bootstrap"
        && (category(ownerForPath(targetPath)) === "workflow"
          || category(ownerForPath(targetPath)) === "infrastructure")
        && !isPublicEntry(ownerForPath(targetPath), targetPath)) {
        diagnostics.push(diagnostic(path, "private-entry", targetPath));
      }
    }
  }
  diagnostics.push(...collectCycles(graph));
  return diagnostics.sort((left, right) => left.path.localeCompare(right.path)
    || left.rule.localeCompare(right.rule) || left.symbol.localeCompare(right.symbol));
}

async function loadBaseline() {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const entries = baseline.entries;
  const originHashes = baseline.originHashes;
  if (!Array.isArray(originHashes) || originHashes.some((hash) => typeof hash !== "string")
    || !Array.isArray(entries)) {
    throw new Error("構造検査baselineの形式が不正です。");
  }
  const entryHashes = baselineEntryHashes(entries);
  const checksum = createHash("sha256").update(originHashes.join("\n")).digest("hex");
  if (checksum !== originBaselineChecksum || new Set(originHashes).size !== originHashes.length) {
    throw new Error("構造検査baselineの初期集合が変更されました。");
  }
  const originSet = new Set(originHashes);
  if (entryHashes.size > originSet.size || [...entryHashes].some((hash) => !originSet.has(hash))) {
    throw new Error("初期の既存違反以外を構造検査baselineへ追加できません。");
  }
  await assertBaselineMonotonic(entryHashes, originSet);
  return entries;
}

function key(entry) {
  return JSON.stringify([entry.path, entry.rule, entry.symbol]);
}

function entryHash(entry) {
  return createHash("sha256").update(key(entry)).digest("hex");
}

function baselineEntryHashes(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => entry == null
    || typeof entry.path !== "string" || typeof entry.rule !== "string"
    || typeof entry.symbol !== "string" || Object.keys(entry).length !== 3)) {
    throw new Error("構造検査baselineの形式が不正です。");
  }
  const hashes = entries.map(entryHash);
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("構造検査baselineに重複があります。");
  }
  return new Set(hashes);
}

function assertSubset(current, previous) {
  if ([...current].some((hash) => !previous.has(hash))) {
    throw new Error("構造検査baselineへ解消済みの違反が再追加されました。");
  }
}

async function assertBaselineMonotonic(current, origin) {
  const { stdout: shallow } = await execFileAsync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (shallow.trim() !== "false") {
    throw new Error("構造検査baselineの履歴を確認するにはGitの全履歴が必要です。");
  }
  const { stdout: history } = await execFileAsync("git", ["log", "--first-parent", "--format=%H", "--",
    "docs/architecture/structure-migration-baseline.json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const revisions = history.trim().split("\n").filter((revision) => revision.length > 0).reverse();
  let previous;
  for (const revision of revisions) {
    const { stdout: committedSource } = await execFileAsync("git", ["show",
      `${revision}:docs/architecture/structure-migration-baseline.json`], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    const committed = JSON.parse(committedSource);
    const hashes = baselineEntryHashes(committed.entries);
    if (previous == null) {
      if (hashes.size !== origin.size) {
        throw new Error("構造検査baselineの初期集合が既存違反と一致しません。");
      }
      assertSubset(origin, hashes);
    } else {
      assertSubset(hashes, previous);
    }
    previous = hashes;
  }
  if (previous == null) {
    if (current.size !== origin.size) {
      throw new Error("構造検査baselineの初期集合が既存違反と一致しません。");
    }
    assertSubset(origin, current);
  } else {
    assertSubset(current, previous);
  }
}

const mode = process.argv.includes("--changed") ? "changed" : process.argv.includes("--all") ? "all" : undefined;
if (mode == null || process.argv.includes("--changed") && process.argv.includes("--all")) {
  throw new Error("--changedまたは--allを1つ指定してください。");
}
const reportJson = process.argv.includes("--report-json");
const paths = listSourceFiles();
const { files, reparsed } = scanSources(paths);
const diagnostics = collectDiagnostics(paths, files);
const baseline = await loadBaseline();
const baselineKeys = new Set(baseline.map(key));
const diagnosticKeys = new Set(diagnostics.map(key));
const newViolations = diagnostics.filter((entry) => !baselineKeys.has(key(entry)));
const resolvedViolations = baseline.filter((entry) => !diagnosticKeys.has(key(entry)));
if (reportJson) {
  process.stdout.write(`${JSON.stringify({ diagnostics, newViolations, resolvedViolations, reparsed })}\n`);
} else {
  for (const entry of newViolations) {
    process.stderr.write(`新規違反 ${entry.path} ${entry.rule} ${entry.symbol}\n`);
  }
  for (const entry of resolvedViolations) {
    process.stderr.write(`解消済みbaselineを削除してください ${entry.path} ${entry.rule} ${entry.symbol}\n`);
  }
  process.stdout.write(`構造検査: ${paths.length}件、再解析${reparsed}件、既存違反${diagnostics.length - newViolations.length}件、新規違反${newViolations.length}件、解消済みbaseline${resolvedViolations.length}件。\n`);
}
if (newViolations.length > 0 || resolvedViolations.length > 0) {
  process.exitCode = 1;
}
