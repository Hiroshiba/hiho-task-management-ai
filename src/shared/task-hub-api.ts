export interface TaskHubApi {
  readonly app: {
    readonly getVersion: () => Promise<string>;
  };
}
