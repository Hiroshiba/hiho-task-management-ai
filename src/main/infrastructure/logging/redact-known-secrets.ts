/** 既知の秘密値を文字列の直列化前に伏せ字にします。 */
export function redactKnownSecrets(
  value: string,
  knownSecrets: readonly string[],
  redactText: (value: string) => string,
): string {
  let sanitized = redactText(value);
  for (const secret of knownSecrets) {
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return sanitized;
}
