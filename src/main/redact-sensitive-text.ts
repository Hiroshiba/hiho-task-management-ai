const credentialAssignmentPattern =
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|bot[_ -]?token|token|client[_ -]?secret|authorization|password|secret|credential)\b(\s*[:=])\s*(?:bearer\s+)?(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]&#?]+)/giu;
const jsonCredentialPattern =
  /((?:["'])(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|bot[_ -]?token|token|client[_ -]?secret|authorization|password|secret|credential)(?:["'])\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/giu;
const bearerPattern = /\b(bearer\s+)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]]+)/giu;
const credentialQueryPattern =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|client[_-]?secret|authorization|password|secret|token|code)=)[^&#\s]+/giu;
const obviousCredentialPattern =
  /\b(?:sk|rk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu;
const jwtPattern =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;

/** 診断文字列に含まれる認証情報を伏せ字にします。 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(credentialQueryPattern, "$1<伏せ字>")
    .replace(jsonCredentialPattern, "$1<伏せ字>")
    .replace(bearerPattern, "$1<伏せ字>")
    .replace(credentialAssignmentPattern, "$1$2<伏せ字>")
    .replace(obviousCredentialPattern, "<伏せ字>")
    .replace(jwtPattern, "<伏せ字>");
}
