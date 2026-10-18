import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

import { createIntegrationRun, integrationMeta } from "./integrate/engine.mjs";
import { createProjectPorts } from "./integrate/ports.mjs";

// 拡張の stdout は JSON-RPC が使うため console.log は禁止。記録は session.log へ送る。
let session = null;
const log = (message) => {
  try {
    session?.log?.(`[integrate-task] ${message}`);
  } catch {
    // ログ送信の失敗でワークフローを落とさない。
  }
};

const integrationTask = defineWorkflow({
  meta: integrationMeta,
  run: createIntegrationRun(createProjectPorts({ log })),
});

session = await joinSession({ workflows: [integrationTask] });
