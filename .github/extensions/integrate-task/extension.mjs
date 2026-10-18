import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

import { createIntegrationRun, integrationMeta } from "./integrate/engine.mjs";
import { createProjectPorts } from "./integrate/ports.mjs";
import { createTaskPipelineRun, taskPipelineMeta } from "./task/engine.mjs";
import { createTaskPorts } from "./task/ports.mjs";

// 拡張の stdout は JSON-RPC が使うため console.log は禁止。記録は session.log へ送る。
let session = null;
const log = (message) => {
  try {
    session?.log?.(`[integrate-task] ${message}`);
  } catch {
    // ログ送信の失敗でワークフローを落とさない。
  }
};

// 親セッション用: 提出コミットを統合待ちキューとして 1 件ずつ検証・反映する。
const integrationTask = defineWorkflow({
  meta: integrationMeta,
  run: createIntegrationRun(createProjectPorts({ log })),
});

// 子セッション用: 実装 → 検証 → レビュー → 修正ループ → 提出コミット。
const taskPipeline = defineWorkflow({
  meta: taskPipelineMeta,
  run: createTaskPipelineRun(createTaskPorts({ log })),
});

session = await joinSession({ workflows: [integrationTask, taskPipeline] });
