// In-process fixture only: no model, CLI, or child process is started.
export function fakeReviewConnector(reply, calls = []) {
  let resolve;
  return {
    async execute(context) {
      calls.push({ method: "execute", task: context.task });
      context.store.setTurn(context.claimed.message_id, "fixture-review-session", "fixture-turn", context.claimed);
      if (reply === "crash") throw new Error("fixture process exited");
      if (reply === "wait") return new Promise(done => { resolve = done; });
      return structuredClone(reply);
    },
    async resume(context) {
      const result = this.execute(context);
      calls.at(-1).method = "resume";
      return result;
    },
    async interrupt() {
      calls.push({ method: "interrupt" });
      resolve?.({ interrupted: true });
    },
    parse(value) {
      return value.interrupted ? { status: "cancelled", reason: "fixture stopped" }
        : { outcome: "result", reply: value };
    },
    async close() {
      calls.push({ method: "close" });
      resolve?.({ interrupted: true });
    },
  };
}
