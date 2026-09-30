import type { z } from "zod";
import type { SystemWorkflow } from "../../application/system";
import { systemContracts } from "../../../shared/ipc-contracts/system";
import { createContractHandler, type ContractHandler, type IpcSuccessValue } from "./contract-handler";

type UpdateState = IpcSuccessValue<typeof systemContracts.getUpdateState.response>;
type SystemInvokeName = "getVersion" | "waitForStartup" | "getUpdateState";
export type SystemHandlers = {
  readonly [Name in SystemInvokeName]: ContractHandler<(typeof systemContracts)[Name]>;
} & {
  readonly subscribeUpdateState: (
    payload: unknown,
  ) => z.output<typeof systemContracts.subscribeUpdateState.request>;
  readonly unsubscribeUpdateState: (
    payload: unknown,
  ) => z.output<typeof systemContracts.unsubscribeUpdateState.request>;
  readonly updateState: (
    subscriptionId: string,
    value: UpdateState,
  ) => z.output<typeof systemContracts.updateState.event>;
};

export type SystemHandlerWorkflow = SystemWorkflow<UpdateState>;

/** systemのuse caseに対応するIPC handlerを作成します。 */
export function createSystemHandlers(workflow: SystemHandlerWorkflow): SystemHandlers {
  return {
    getVersion: createContractHandler(systemContracts.getVersion, () => workflow.getVersion()),
    waitForStartup: createContractHandler(systemContracts.waitForStartup, async (_request, signal): Promise<{ completed: true }> => {
      await workflow.waitForStartup(signal);
      return { completed: true };
    }),
    getUpdateState: createContractHandler(systemContracts.getUpdateState, () => workflow.getUpdateState()),
    subscribeUpdateState: (payload: unknown): z.output<typeof systemContracts.subscribeUpdateState.request> =>
      systemContracts.subscribeUpdateState.request.parse(payload),
    unsubscribeUpdateState: (payload: unknown): z.output<typeof systemContracts.unsubscribeUpdateState.request> =>
      systemContracts.unsubscribeUpdateState.request.parse(payload),
    updateState: (
      subscriptionId: string,
      value: UpdateState,
    ): z.output<typeof systemContracts.updateState.event> =>
      systemContracts.updateState.event.parse({ subscription_id: subscriptionId, value }),
  };
}
