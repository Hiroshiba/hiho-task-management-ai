/** 現行構成で利用できるGitHub連携状態を返します。 */
export function getGithubIntegrationStatus(): {
  readonly kind: "unavailable";
  readonly reason_code: "client_unavailable";
} {
  return { kind: "unavailable", reason_code: "client_unavailable" };
}
