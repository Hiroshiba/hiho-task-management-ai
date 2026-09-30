import type { AsanaReadClient } from "./client/client";
import type { AsanaSetupClient } from "./client/setup-client";
import type { AsanaTaskWriteClient } from "./client/task-write-client";
import type { AsanaDisplayOrderService, AsanaDisplayOrderUnexpectedErrorNotifier } from "./display-order/service";
import type { AsanaOAuthCoordinator } from "./oauth/coordinator";
import type { AsanaOperationQueue } from "./operation-queue";
import type { AsanaCapabilityCheckService } from "./setup/capability-check";
import type { AsanaSetupResourceCoordinator } from "./setup/resource-coordinator";
import type { AsanaTransportPriorityPort } from "./transport/types";

export type AsanaCommunicationRuntime = {
  readonly setTokenProvider: (clientId: string) => void;
  readonly highPriorityTransport: AsanaTransportPriorityPort;
  readonly readClient: AsanaReadClient;
  readonly interactiveReadClient: AsanaReadClient;
  readonly writeClient: AsanaTaskWriteClient;
  readonly setupClient: AsanaSetupClient;
  readonly setupResources: AsanaSetupResourceCoordinator;
  readonly setupCapability: AsanaCapabilityCheckService;
  readonly operationQueue: AsanaOperationQueue;
  readonly oauth: AsanaOAuthCoordinator;
  readonly createDisplayOrder: (
    notifyUnexpectedError: AsanaDisplayOrderUnexpectedErrorNotifier,
  ) => AsanaDisplayOrderService;
};
