// Pure packet and transition rules; no database, filesystem, or model calls.
import {isHybrid,needsBoundaryReview} from './hybrid-review.mjs';

const string = { type: "string" };
const boundaryStates = ["unchanged", "changed_reviewed", "changed_unreviewed"];

export const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["status", "verdict", "summary", "criteria", "findings", "boundary_review"],
  properties: {
    status: { enum: ["done", "failed"] }, verdict: { enum: ["pass", "reject"] }, summary: string,
    criteria: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["criterion", "result", "evidence"],
      properties: { criterion: string, result: { enum: ["pass", "fail", "unverified"] }, evidence: string } } },
    findings: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["criterion", "problem", "required_change", "files"],
      properties: { criterion: string, problem: string, required_change: string,
        files: { type: "array", items: string } } } },
    boundary_review: { type: "object", additionalProperties: false,
      required: ["paths", "exec", "auth_permissions", "notes"],
      properties: { paths: string, exec: string, auth_permissions: { enum: boundaryStates }, notes: string } },
  },
};

export function normaliseChain(value) {
  if (!value || value.review !== true) throw new Error("chain.review must be true");
  const chain = { max_rounds: 2, review_model: "claude-sonnet-5-5",
    review_effort: "high", review_timeout_ms: 1_200_000, ...value };
  if (!Number.isSafeInteger(chain.max_rounds) || chain.max_rounds < 1) throw new Error("invalid chain.max_rounds");
  if (!Number.isSafeInteger(chain.review_timeout_ms) || chain.review_timeout_ms < 1) throw new Error("invalid chain.review_timeout_ms");
  for (const key of ["review_model", "review_effort"]) {
    if (typeof chain[key] !== "string" || !chain[key].trim()) throw new Error(`invalid chain.${key}`);
  }
  return chain;
}

function textFields(value, fields) {
  return value && fields.every(key => typeof value[key] === "string");
}

/** Validate untrusted review output before deciding the next step. */
export function normaliseReview(input, acceptance = []) {
  const reply = structuredClone(input);
  if (!reply || !["done", "failed"].includes(reply.status) || !["pass", "reject"].includes(reply.verdict)
      || typeof reply.summary !== "string" || !Array.isArray(reply.criteria)
      || reply.criteria.some(c => !textFields(c, ["criterion", "evidence"]) || !["pass", "fail", "unverified"].includes(c.result))
      || !Array.isArray(reply.findings)
      || reply.findings.some(f => !textFields(f, ["criterion", "problem", "required_change"])
        || !Array.isArray(f.files) || f.files.some(file => typeof file !== "string"))) {
    throw new Error("invalid review result");
  }
  const boundary = reply.boundary_review;
  const missing = !textFields(boundary, ["paths", "exec", "auth_permissions", "notes"])
    || !boundaryStates.includes(boundary.auth_permissions);
  if (missing || boundary.auth_permissions === "changed_unreviewed") {
    reply.verdict = "reject";
    reply.findings.push({
      criterion: "boundary_review",
      problem: missing ? "Boundary review is missing or invalid." : "Permission/authentication changes are unreviewed.",
      required_change: "Provide an independent review of paths, execution, authentication and permissions.",
      files: [],
    });
  }
  // A headline pass cannot override missing, duplicated, failed or evidence-free checks.
  // Contract-specific optional criteria remain governed by validateContractReply.
  const required = [...new Set(acceptance)];
  for (const criterion of required) {
    const checks = reply.criteria.filter(check => check.criterion === criterion);
    if (checks.length === 1 && checks[0].result === 'pass' && checks[0].evidence.trim()) continue;
    reply.verdict = 'reject';
    if (!reply.findings.some(finding => finding.criterion === criterion)) reply.findings.push({
      criterion, problem: 'Required criterion lacks one passing check with evidence.',
      required_change: 'Satisfy the original criterion and supply current verification evidence.', files: [],
    });
  }
  if (reply.findings.length) reply.verdict = 'reject';
  if (reply.verdict === "reject" && !reply.findings.length) throw new Error("reject requires findings");
  return reply;
}

function parentOf(task, reply) {
  return { message_id: task.message_id, attempt: task.attempt, reply_id: reply.message_id };
}

function common(root, parent, reply, round) {
  return {
    task_id: root.task_id, project_id:root.body.project_id, root_id: root.message_id, chain: root.body.chain, round,
    parent: parentOf(parent, reply), reply_to: reply.message_id,
    cwd: root.body.cwd, base_revision: root.body.base_revision,
    context_refs:root.body.context_refs,handoff_from:root.body.handoff_from ?? root.body.depends_on,
    browser_context:reply.body.browser_context ?? root.body.browser_context,
    contract:root.body.contract,contract_review_ids:root.body.contract_review_ids,
  };
}

export function reviewTask(root, implementation, reply, threadId = null) {
  const changed = reply.body.changed_files ?? {};
  const hybrid = isHybrid(root.body);
  return {
    ...common(root, implementation, reply, implementation.round),
    ...(root.body.contract?{contract_review_ids:root.body.contract.document.review.criteria.map(c=>c.id)}:{}),
    message_id: `${root.message_id}:review:${implementation.round}`,
    sender: "codex", recipient: "claude-code", role: "review",
    goal: root.body.goal, acceptance: root.body.acceptance,
    ...(hybrid?{review_boundary:needsBoundaryReview(root.body,implementation.body,changed)}:{}),
    implementation: { summary: reply.body.summary ?? "", evidence: reply.body.acceptance ?? [],
      changed_files: changed },
    file_refs: root.body.file_refs.map(ref => ({ ...ref, hash: null })),
    write_files: [], sandbox: "read-only", thread_id: hybrid ? null : threadId,
    model: root.body.chain.review_model, effort: root.body.chain.review_effort,
  };
}

export function reworkTask(root, review, reply, threadId) {
  const round = review.round + 1;
  const findings = reply.body.findings;
  return {
    ...common(root, review, reply, round),
    message_id: `${root.message_id}:rework:${round}`,
    sender: "claude-code", recipient: "codex", role: "implement",
    goal: root.body.goal, acceptance: [...new Set([...root.body.acceptance,...findings.map(f => f.criterion)])],
    findings, file_refs: [...new Set(findings.flatMap(f => f.files))].map(path => ({ path })),
    write_files: [...root.body.write_files], sandbox: root.body.sandbox, thread_id: threadId,
    model: root.body.model, effort: root.body.effort, profile: root.body.profile,
  };
}

export function nextStep(task, reply) {
  if (reply.status === "failed") return null;
  if (task.body.role !== "review") return "review";
  if (reply.verdict === "pass") return "final";
  return task.round < task.body.chain.max_rounds ? "rework" : "exhausted";
}

export function finalReply(root, review, reply, step) {
  return {
    message_id: `${root.message_id}:final`, task_id: root.task_id,
    reply_to: reply.message_id, sender: root.recipient, recipient: root.sender,
    body: { status: step === "exhausted" ? "exhausted" : "done", verdict: reply.body.verdict,
      summary: reply.body.summary, criteria: reply.body.criteria, findings: reply.body.findings,
      boundary_review: reply.body.boundary_review, root_id: root.message_id, round: review.round,
      parent: parentOf(review, reply),communication_receipt:reply.body.communication_receipt,browser_context:reply.body.browser_context,
      ...(root.body.contract?{contract_receipt:reply.body.contract_receipt,contract_hash:root.body.contract.hash}:{}) },
  };
}
