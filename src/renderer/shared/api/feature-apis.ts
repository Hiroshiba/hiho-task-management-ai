import { inject, type InjectionKey } from "vue";
import type { FinalTaskHubApi } from "../../../shared/ipc-contracts";
import type { DiagnosticsApi } from "../../../shared/ipc-contracts/diagnostics";
import type { SystemApi } from "../../../shared/ipc-contracts/system";

export const systemApiInjectionKey: InjectionKey<SystemApi> = Symbol("systemApi");
export const diagnosticsApiInjectionKey: InjectionKey<DiagnosticsApi> = Symbol("diagnosticsApi");

/** 指定した機能の実APIかmock APIを選びます。 */
export function selectFeatureApi<Api>(
  name: keyof FinalTaskHubApi,
  selectedFeatures: ReadonlySet<string>,
  nativeApi: Api | undefined,
  createMock: () => Api,
): Api {
  if (selectedFeatures.has(name)) {
    return createMock();
  }
  if (nativeApi == null) {
    throw new Error(
      `Webフロントでは機能「${name}」のAPIを利用できません。mock=${name}またはmock=allを指定してください。`,
    );
  }
  return nativeApi;
}

/** Vueからsystem APIを取得します。 */
export function useSystemApi(): SystemApi {
  const api = inject(systemApiInjectionKey);
  if (api == null) {
    throw new Error("system APIが提供されていません。");
  }
  return api;
}

/** Vueから診断APIを取得します。 */
export function useDiagnosticsApi(): DiagnosticsApi {
  const api = inject(diagnosticsApiInjectionKey);
  if (api == null) {
    throw new Error("診断APIが提供されていません。");
  }
  return api;
}
