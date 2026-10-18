// 子セッションの工程（task-pipeline）の語彙。統合側の語彙（core/state.mjs）とは混ぜない。
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const TITLE_MAX_LENGTH = 200;
export const MAX_REWORKS_LIMIT = 5;
export const DEFAULT_MAX_REWORKS = 2;

export const TASK_STATE = Object.freeze({
  SUBMITTED: "SUBMITTED",
  NEEDS_PARENT: "NEEDS_PARENT",
});

export const TASK_DETAIL = Object.freeze({
  INVALID_ARGUMENTS: "invalid-arguments",
  NOT_A_REPOSITORY: "not-a-repository",
  WORKTREE_DIRTY: "worktree-dirty",
  WORKTREE_GIT_OPERATION: "worktree-git-operation",
  POLICY_MISSING: "policy-missing",
  IMPLEMENT_FAILED: "implement-failed",
  REVIEW_UNAVAILABLE: "review-unavailable",
  REWORK_EXHAUSTED: "rework-exhausted",
  NOTHING_TO_SUBMIT: "nothing-to-submit",
  SUBMIT_FAILED: "submit-failed",
  SUBMITTED: "submitted",
});

export function taskResult(state, detail, options = {}) {
  const { message = "", submittedHead = null, evidenceRef = null, extra = {} } = options;
  return { state, detail, message, submittedHead, evidenceRef, ...extra };
}

const ALLOWED_KEYS = ["taskId", "title", "prompt", "roles", "verify", "maxReworks", "commitMessage"];
const ROLE_NAMES = ["implementer", "reviewer"];
const ROLE_KEYS = ["model", "reasoningEffort"];

function validateRoles(value) {
  const roles = {};
  for (const name of ROLE_NAMES) {
    roles[name] = {};
  }
  if (value === undefined) return roles;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("roles はオブジェクトで指定してください。");
  }
  const unknown = Object.keys(value).filter((key) => !ROLE_NAMES.includes(key));
  if (unknown.length > 0) {
    throw new Error(`roles の未知の役割です: ${unknown.join(", ")}`);
  }
  for (const name of ROLE_NAMES) {
    const role = value[name];
    if (role === undefined) continue;
    if (role === null || typeof role !== "object" || Array.isArray(role)) {
      throw new Error(`roles.${name} はオブジェクトで指定してください。`);
    }
    const unknownRoleKeys = Object.keys(role).filter((key) => !ROLE_KEYS.includes(key));
    if (unknownRoleKeys.length > 0) {
      throw new Error(`roles.${name} の未知のキーです: ${unknownRoleKeys.join(", ")}`);
    }
    for (const key of ROLE_KEYS) {
      if (role[key] === undefined) continue;
      if (typeof role[key] !== "string" || role[key].trim() === "") {
        throw new Error(`roles.${name}.${key} は空でない文字列で指定してください。`);
      }
      roles[name][key] = role[key];
    }
  }
  return roles;
}

/**
 * verify を指定したときはポリシーの検証コマンドを置き換える。
 * 形はポリシー（core/policy.mjs）と同じにして、同じ実装（core/verify.mjs）で走らせる。
 */
function validateVerify(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("verify は 1 件以上の配列で指定してください。");
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`verify[${index}] はオブジェクトで指定してください。`);
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new Error(`verify[${index}].name が必要です。`);
    }
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      throw new Error(`verify[${index}].command が必要です。`);
    }
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error(`verify[${index}].args は文字列の配列である必要があります。`);
    }
    const timeoutSeconds = entry.timeoutSeconds === undefined ? 600 : entry.timeoutSeconds;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
      throw new Error(`verify[${index}].timeoutSeconds は 1 以上の整数である必要があります。`);
    }
    return { name: entry.name, command: entry.command, args: [...args], timeoutSeconds };
  });
}

function validateMaxReworks(value) {
  if (value === undefined) return DEFAULT_MAX_REWORKS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_REWORKS_LIMIT) {
    throw new Error(`maxReworks は 0〜${MAX_REWORKS_LIMIT} の整数で指定してください。`);
  }
  return value;
}

export function validateTaskArgs(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("引数はオブジェクトで指定してください。");
  }
  const unknown = Object.keys(value).filter((key) => !ALLOWED_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`未知の引数です: ${unknown.join(", ")}`);
  }
  if (typeof value.taskId !== "string" || !TASK_ID_PATTERN.test(value.taskId)) {
    throw new Error("taskId は英数字で始まる 1〜100 文字の [A-Za-z0-9._-] で指定してください。");
  }
  if (typeof value.title !== "string" || value.title.trim() === "" || value.title.length > TITLE_MAX_LENGTH) {
    throw new Error(`title は 1〜${TITLE_MAX_LENGTH} 文字で指定してください。`);
  }
  if (typeof value.prompt !== "string" || value.prompt.trim() === "") {
    throw new Error("prompt（実装指示）は必須です。");
  }
  if (value.commitMessage !== undefined && (typeof value.commitMessage !== "string" || value.commitMessage.trim() === "")) {
    throw new Error("commitMessage は空でない文字列で指定してください。");
  }
  return {
    taskId: value.taskId,
    title: value.title,
    prompt: value.prompt,
    roles: validateRoles(value.roles),
    verify: validateVerify(value.verify),
    maxReworks: validateMaxReworks(value.maxReworks),
    commitMessage: typeof value.commitMessage === "string" ? value.commitMessage : null,
  };
}
