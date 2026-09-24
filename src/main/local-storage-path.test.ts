import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const nativePlatform = process.platform;
const descriptorDevice = 1_220_215_771n;
let pathDevice = 0n;
let descriptorInode: bigint | undefined;
let replacedDirectory: {
  readonly path: string;
  readonly inode: bigint;
  initialStatSeen: boolean;
} | undefined;

function pathStats(stats: fs.BigIntStats, path: fs.PathLike): fs.BigIntStats {
  stats.dev = pathDevice;
  if (replacedDirectory != null && path === replacedDirectory.path && replacedDirectory.initialStatSeen) {
    stats.ino = replacedDirectory.inode;
  }
  return stats;
}

mock.module("node:fs", {
  namedExports: {
    ...fs,
    lstatSync: (path: fs.PathLike, options: { readonly bigint: true }): fs.BigIntStats =>
      pathStats(fs.lstatSync(path, options), path),
    statSync: (path: fs.PathLike, options: { readonly bigint: true }): fs.BigIntStats => {
      const stats = pathStats(fs.statSync(path, options), path);
      if (replacedDirectory != null && path === replacedDirectory.path) {
        replacedDirectory.initialStatSeen = true;
      }
      return stats;
    },
    fstatSync: (descriptor: number, options: { readonly bigint: true }): fs.BigIntStats => {
      const stats = fs.fstatSync(descriptor, options);
      stats.dev = descriptorDevice;
      if (descriptorInode != null) {
        stats.ino = descriptorInode;
      }
      return stats;
    },
  },
});

const {
  captureSecurePersistentFile,
  readSecurePersistentTextFile,
} = await import("./local-storage-path.ts");

function withPlatform(platform: string, run: () => void): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: nativePlatform });
    pathDevice = 0n;
    descriptorInode = undefined;
    replacedDirectory = undefined;
  }
}

function withFiles(run: (directory: string, filePath: string) => void): void {
  const directory = fs.mkdtempSync(join(tmpdir(), "taskhub-identity-"));
  const filePath = join(directory, "proposal.json");
  try {
    fs.writeFileSync(filePath, "人工データ", { mode: 0o600 });
    run(directory, filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

void test("Windowsではパス側のdevが0でも同じinodeのファイルを読める", () => {
  withPlatform("win32", () => withFiles((_directory, filePath) => {
    const identity = captureSecurePersistentFile(filePath, "人工ファイル");
    assert.equal(identity.kind, "existing");
    if (identity.kind !== "existing") {
      throw new Error("人工ファイルを確認できません。");
    }
    assert.equal(identity.device, descriptorDevice);
    assert.equal(identity.inode, fs.statSync(filePath, { bigint: true }).ino);
    assert.equal(readSecurePersistentTextFile(filePath, "人工ファイル"), "人工データ");
  }));
});

void test("Windowsでも別ファイルのinodeは拒否する", () => {
  withPlatform("win32", () => withFiles((directory, filePath) => {
    const otherPath = join(directory, "other.json");
    fs.writeFileSync(otherPath, "別ファイル", { mode: 0o600 });
    descriptorInode = fs.statSync(otherPath, { bigint: true }).ino;
    assert.notEqual(descriptorInode, fs.statSync(filePath, { bigint: true }).ino);
    assert.throws(() => captureSecurePersistentFile(filePath, "人工ファイル"), /実体が検証中に変化/u);
  }));
});

void test("Windowsでも両方のdevが非0なら不一致を拒否する", () => {
  withPlatform("win32", () => withFiles((_directory, filePath) => {
    pathDevice = 1n;
    assert.throws(() => captureSecurePersistentFile(filePath, "人工ファイル"), /実体が検証中に変化/u);
  }));
});

void test("Windowsで親ディレクトリの差し替えを拒否する", () => {
  withPlatform("win32", () => withFiles((directory, filePath) => {
    replacedDirectory = {
      path: directory,
      inode: fs.statSync(directory, { bigint: true }).ino + 1n,
      initialStatSeen: false,
    };
    assert.throws(() => captureSecurePersistentFile(filePath, "人工ファイル"), /実体が操作中に変化/u);
  }));
});

void test("Windowsでジャンクションとシンボリックリンクを拒否する", () => {
  withPlatform("win32", () => withFiles((directory, filePath) => {
    const linkPath = join(directory, "linked-directory");
    fs.symlinkSync(directory, linkPath, nativePlatform === "win32" ? "junction" : "dir");
    assert.throws(
      () => captureSecurePersistentFile(join(linkPath, "proposal.json"), "人工ファイル"),
      /シンボリックリンク/u,
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), "人工データ");
  }));
});

void test("Unixではdevの不一致を拒否し、一致するファイルを読める", {
  skip: nativePlatform === "win32",
}, () => {
  withPlatform("linux", () => withFiles((_directory, filePath) => {
    assert.throws(() => captureSecurePersistentFile(filePath, "人工ファイル"), /実体が検証中に変化/u);
    pathDevice = descriptorDevice;
    const identity = captureSecurePersistentFile(filePath, "人工ファイル");
    assert.equal(identity.kind, "existing");
    assert.equal(readSecurePersistentTextFile(filePath, "人工ファイル"), "人工データ");
  }));
});
