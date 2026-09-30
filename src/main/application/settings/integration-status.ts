type IntegrationStatus = {
  readonly github_app: {
    readonly kind: "unavailable";
    readonly reason_code: "client_unavailable";
  };
};

/** 現行アプリの外部連携設定状態を返します。 */
export function readIntegrationStatus(): IntegrationStatus {
  return { github_app: { kind: "unavailable", reason_code: "client_unavailable" } };
}
