import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse as parseVue } from "vue/compiler-sfc";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const sourceExtensions = new Set([".ts", ".tsx", ".vue", ".css", ".html"]);

const ownerRules = [
  [/^src\/main\/index\.ts$/, "main/bootstrap"],
  [/^src\/main\/(application-update|security|startup-gate)\.ts$/, "main/bootstrap"],
  [/^src\/main\/(local-storage-path|window-state)\.ts$/, "main/infrastructure/persistence"],
  [/^src\/main\/(persistent-error-log|redact-sensitive-text)\.ts$/, "main/infrastructure/logging"],
  [/^src\/main\/application\/service\.ts$/, "main/bootstrap"],
  [/^src\/main\/application\/checkpoint\.ts$/, "main/infrastructure/persistence"],
  [/^src\/main\/application\/cleanup-aggregation\.ts$/, "main/application/task-read"],
  [/^src\/main\/application\/codex-adapter\.ts$/, "main/infrastructure/ai"],
  [/^src\/main\/application\/diagnostics\.ts$/, "main/infrastructure/logging"],
  [/^src\/main\/application\/schemas\.ts$/, "main/application/common"],
  [/^src\/main\/ai\/proposal-application\//, "main/application/proposal-apply"],
  [/^src\/main\/ai\//, "main/application/proposal-generate"],
  [/^src\/main\/asana\//, "main/infrastructure/asana"],
  [/^src\/main\/auth\/asana-oauth\//, "main/infrastructure/asana"],
  [/^src\/main\/codex\//, "main/infrastructure/ai"],
  [/^src\/main\/domain\//, "main/domain"],
  [/^src\/main\/external-agent\/service\.ts$/, "main/application/proposal-generate"],
  [/^src\/main\/external-agent\//, "main/infrastructure/ai"],
  [/^src\/main\/external-tools\//, "main/infrastructure/ai"],
  [/^src\/main\/gui-edit\//, "main/application/gui-edit"],
  [/^src\/main\/ipc\//, "main/ipc"],
  [/^src\/main\/obsidian\//, "main/infrastructure/obsidian"],
  [/^src\/main\/read-model\//, "main/application/task-read"],
  [/^src\/main\/setup\//, "main/application/settings"],
  [/^src\/main\/storage\//, "main/infrastructure/persistence"],
  [/^src\/main\/bootstrap\//, "main/bootstrap"],
  [/^src\/main\/application\/common\//, "main/application/common"],
  [/^src\/main\/application\/(task-read|task-write|proposal-generate|proposal-apply|gui-edit|settings|system|github-integration|obsidian-integration)\//, null],
  [/^src\/main\/infrastructure\/(asana|github|obsidian|ai|persistence|logging|clock)\//, null],
  [/^src\/main\/ipc\//, "main/ipc"],
  [/^src\/preload\//, "preload"],
  [/^src\/renderer\/index\.html$|^src\/renderer\/env\.d\.ts$/, "renderer/app"],
  [/^src\/renderer\/app\//, "renderer/app"],
  [/^src\/renderer\/features\/(tasks|proposals|settings|system|github-integration|obsidian-integration)\//, null],
  [/^src\/renderer\/shared\/(api|components|format|logging|mock)\//, null],
  [/^src\/shared\/domain\//, "main/domain"],
  [/^src\/shared\/ai\/(index|proposal)\.ts$/, "main/domain"],
  [/^src\/shared\/storage\/schemas\.ts$/, "main/infrastructure/persistence"],
  [/^src\/shared\//, "shared/ipc-contracts"],
];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    if (!entry.isFile() || !sourceExtensions.has(extname(path))) {
      return [];
    }
    return [relative(repositoryRoot, path).replaceAll("\\", "/")];
  });
}

/** 手編集するアプリsourceを列挙します。 */
export function listSourceFiles() {
  return walk(join(repositoryRoot, "src")).sort();
}

/** sourceの最終owner候補を返します。 */
export function ownerForPath(path) {
  for (const [pattern, owner] of ownerRules) {
    if (pattern.test(path)) {
      if (owner !== null) {
        return owner;
      }
      if (path.startsWith("src/main/application/")) {
        return path.split("/").slice(0, 4).join("/").replace(/^src\//, "");
      }
      if (path.startsWith("src/main/infrastructure/")) {
        return path.split("/").slice(0, 4).join("/").replace(/^src\//, "");
      }
      if (path.startsWith("src/renderer/features/")) {
        return path.split("/").slice(0, 4).join("/").replace(/^src\//, "");
      }
      return path.split("/").slice(0, 4).join("/").replace(/^src\//, "");
    }
  }
  throw new Error(`sourceのowner候補がありません: ${path}`);
}

function literalFromCall(node, name) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
    return undefined;
  }
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== name) {
    return undefined;
  }
  const [argument] = node.arguments;
  return argument != null && ts.isStringLiteral(argument) ? argument.text : undefined;
}

function candidateInitializer(node) {
  if (node == null) {
    return false;
  }
  if (ts.isNewExpression(node)) {
    return true;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return /^(ref|shallowRef|reactive|create.*(Gate|Store|Registry|Runtime|Client|Service|Controller|Logger|Cache))$/.test(node.expression.text);
  }
  return false;
}

function rootIdentifier(node) {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function mutatedConstNames(sourceFile) {
  const constNames = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        constNames.add(declaration.name.text);
      }
    }
  }
  const mutated = new Set();
  function mark(node) {
    const name = rootIdentifier(node);
    if (name != null && constNames.has(name)) {
      mutated.add(name);
    }
  }
  function visit(node) {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      mark(node.left);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))) {
      mark(node.operand);
    }
    if (ts.isDeleteExpression(node)) {
      mark(node.expression);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (ts.isIdentifier(receiver) && receiver.text === "Object"
        && ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(method)) {
        if (node.arguments[0] != null) mark(node.arguments[0]);
      } else if (ts.isIdentifier(receiver) && receiver.text === "Reflect" && method === "set") {
        if (node.arguments[0] != null) mark(node.arguments[0]);
      } else if (["add", "clear", "copyWithin", "delete", "fill", "pop", "push", "reverse", "set", "shift", "sort", "splice", "unshift"].includes(method)) {
        mark(receiver);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return mutated;
}

function collectVariableCandidates(sourceFile, componentSetup) {
  const candidates = [];
  const mutated = mutatedConstNames(sourceFile);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const declarationList = statement.declarationList;
    const isMutableDeclaration = (declarationList.flags & ts.NodeFlags.Const) === 0;
    for (const declaration of declarationList.declarations) {
      if (!isMutableDeclaration && !candidateInitializer(declaration.initializer)
        && (!ts.isIdentifier(declaration.name) || !mutated.has(declaration.name.text))) {
        continue;
      }
      const symbol = declaration.name.getText(sourceFile);
      candidates.push({ symbol, componentSetup });
    }
  }
  return candidates;
}

function collectInstanceState(sourceFile) {
  const entries = [];
  function visit(node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const className = node.name?.text ?? "anonymous";
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member)
          && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
          entries.push(`${className}.${member.name.getText(sourceFile)}`);
        }
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (parameter.modifiers?.some((modifier) => [
              ts.SyntaxKind.PublicKeyword,
              ts.SyntaxKind.ProtectedKeyword,
              ts.SyntaxKind.PrivateKeyword,
              ts.SyntaxKind.ReadonlyKeyword,
            ].includes(modifier.kind))) {
              entries.push(`${className}.${parameter.name.getText(sourceFile)}`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...new Set(entries)].sort();
}

function collectImports(sourceFile) {
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier != null
      && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)
      && node.arguments.length === 1
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [argument] = node.arguments;
      if (argument != null && ts.isStringLiteral(argument)) {
        imports.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...new Set(imports)].sort();
}

/** TypeScriptとVue SFCからimportと状態候補を解析します。 */
export function analyzeSource(path, content) {
  const extension = extname(path);
  if (extension !== ".ts" && extension !== ".tsx" && extension !== ".vue") {
    return { imports: [], mutable: [], componentState: [], instanceState: [] };
  }
  if (extension !== ".vue") {
    const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    return {
      imports: collectImports(sourceFile),
      mutable: collectVariableCandidates(sourceFile, false).map((item) => item.symbol),
      componentState: [],
      instanceState: collectInstanceState(sourceFile),
    };
  }
  const parsed = parseVue(content, { filename: path });
  if (parsed.errors.length > 0) {
    throw new Error(`Vue SFCの解析に失敗しました: ${path}: ${String(parsed.errors[0])}`);
  }
  const scripts = [parsed.descriptor.script, parsed.descriptor.scriptSetup].filter((script) => script != null);
  const imports = [];
  const mutable = [];
  const componentState = [];
  const instanceState = [];
  for (const script of scripts) {
    const sourceFile = ts.createSourceFile(path, script.content, ts.ScriptTarget.Latest, true);
    imports.push(...collectImports(sourceFile));
    const candidates = collectVariableCandidates(sourceFile, script === parsed.descriptor.scriptSetup);
    instanceState.push(...collectInstanceState(sourceFile));
    for (const candidate of candidates) {
      if (candidate.componentSetup) {
        componentState.push(candidate.symbol);
      } else {
        mutable.push(candidate.symbol);
      }
    }
  }
  return {
    imports: [...new Set(imports)].sort(),
    mutable: [...new Set(mutable)].sort(),
    componentState: [...new Set(componentState)].sort(),
    instanceState: [...new Set(instanceState)].sort(),
  };
}

/** source内容のSHA-256を計算します。 */
export function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** リポジトリ内のsourceを読みます。 */
export function readSource(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

/** 名前付きobjectの文字列値をsourceから抽出します。 */
export function objectStringValues(path, variableName) {
  const sourceFile = ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue;
      const initializer = declaration.initializer;
      const object = initializer != null && ts.isSatisfiesExpression(initializer)
        ? initializer.expression : initializer;
      if (object == null || !ts.isObjectLiteralExpression(object)) break;
      return object.properties.map((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) {
          throw new Error(`文字列以外のobject要素があります: ${path}: ${variableName}`);
        }
        return property.initializer.text;
      });
    }
  }
  throw new Error(`objectを抽出できません: ${path}: ${variableName}`);
}

/** 変更案schemaの操作識別子を抽出します。 */
export function proposalOperationKinds() {
  const path = "src/shared/ai/proposal.ts";
  const sourceFile = ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true);
  const kinds = new Set();
  function visit(node) {
    if (ts.isPropertyAssignment(node)
      && node.name.getText(sourceFile) === "operation"
      && node.initializer != null) {
      const kind = literalFromCall(node.initializer, "literal");
      if (kind != null) {
        kinds.add(kind);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...kinds].sort();
}
