// Task-scoped Artifact Writer transport, used only when an Artifact Writer server is installed.
// General Codex approvals stay "never".
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { pathKey } from "./store.mjs";

const TOOLS = ["register_artifact", "write_artifact", "artifact_status"];
const EXTENSIONS = new Set([".md", ".txt", ".html", ".json", ".csv", ".xml", ".svg"]);
const SELF = fileURLToPath(import.meta.url);
const json = file => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

export function artifactScopes(task, allowWrite) {
  if (!allowWrite || !["workspace-write", "danger-full-access"].includes(task?.sandbox)) return [];
  return (task.write_files ?? []).flatMap(file => {
    const absolute = path.resolve(task.cwd, file);
    const directory = existsSync(absolute) && statSync(absolute).isDirectory();
    if (!directory && !EXTENSIONS.has(path.extname(absolute).toLowerCase())) return [];
    return [{ path: absolute, key: pathKey(absolute), directory }];
  });
}

export function checkArtifactCall(params, scopes) {
  if (!TOOLS.includes(params?.name)) throw new Error("Artifact Writer tool is not permitted");
  const target = params.arguments?.target;
  if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("An explicit absolute artifact target is required");
  if (!EXTENSIONS.has(path.extname(target).toLowerCase())
      || (existsSync(target) && !statSync(target).isFile())) throw new Error("Expected a supported artifact file");
  const key = pathKey(target);
  if (!scopes.some(scope => pathKey(scope.path) === scope.key
      && (key === scope.key || (scope.directory && key.startsWith(scope.key.endsWith("/") ? scope.key : scope.key + "/"))))) {
    throw new Error("Artifact target is outside this task's write_files");
  }
}

function toml(value) {
  if (Array.isArray(value)) return "[" + value.map(toml).join(",") + "]";
  if (value && typeof value === "object") return "{ " + Object.entries(value)
    .filter(([,v]) => v != null).map(([k,v]) => JSON.stringify(k) + " = " + toml(v)).join(", ") + " }";
  return JSON.stringify(value);
}

async function installedServer(client, cwd) {
  const config = await client.request("config/read", { cwd, includeLayers: false });
  const explicit = config.config.mcp_servers?.artifact_writer;
  if (explicit) return explicit;
  const inventory = await client.request("plugin/installed", { cwds: [cwd] });
  const plugin = inventory.marketplaces?.flatMap(m => m.plugins ?? [])
    .find(p => p.id === "artifact-writer@local-artifact-tools" && p.installed && p.enabled);
  if (plugin?.source?.type !== "local") return null;
  const root = plugin.source.path;
  const manifest = json(path.join(root, ".codex-plugin", "plugin.json"));
  const spec = manifest.mcpServers ?? "./.mcp.json";
  const servers = typeof spec === "string" ? json(path.resolve(root, spec)).mcpServers : spec;
  return servers?.artifact_writer ?? null;
}

/** Only installed local configuration supplies the executable; task text cannot replace it. */
export async function artifactRuntime(client, task, allowWrite) {
  const scopes = artifactScopes(task, allowWrite);
  if (!scopes.length) return null;
  const server = await installedServer(client, task.cwd);
  // Artifact Writer is optional. Without it, Codex writes documents directly inside its sandbox,
  // and the usual write_files scope check still applies after the task.
  if (!server) return null;
  if (server.enabled === false || server.url || typeof server.command !== "string"
      || !Array.isArray(server.args ?? []) || (server.args ?? []).some(a => typeof a !== "string")) {
    throw new Error("Artifact Writer requires an enabled local stdio server");
  }
  const upstream = { command: server.command, args: server.args ?? [], cwd: server.cwd };
  const config = {
    ...server, command: process.execPath, args: [SELF, JSON.stringify({ upstream, scopes })],
    enabled: true, enabled_tools: TOOLS, disabled_tools: [],
    tools: Object.fromEntries(TOOLS.map(name => [name, { approval_mode: "approve" }])),
  };
  return { config, flags: ["-c", "mcp_servers.artifact_writer=" + toml(config)],
    receipt: { tools: [...TOOLS], scopes: scopes.map(({path,directory}) => ({path,directory})) } };
}

/** Check each invocation before forwarding; never create or modify hook tokens. */
export function serveGuard(config) {
  const child = spawn(config.upstream.command, config.upstream.args, {
    cwd: config.upstream.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
  });
  const send = message => process.stdout.write(JSON.stringify(message) + "\n");
  const lists = new Set();
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", line => {
    let message;
    try {
      message = JSON.parse(line);
      if (message.method === "tools/call") checkArtifactCall(message.params, config.scopes);
      else if (!["initialize", "notifications/initialized", "ping", "tools/list"].includes(message.method)) {
        throw new Error("MCP method is not permitted by the artifact transport");
      }
      if (message.method === "tools/list") lists.add(message.id);
      child.stdin.write(JSON.stringify(message) + "\n");
    } catch (error) {
      if (message?.id !== undefined) send({ jsonrpc: "2.0", id: message.id,
        result: { isError: true, content: [{ type: "text", text: error.message }] } });
    }
  });
  input.on("close", () => child.stdin.end());
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    if (lists.delete(message.id) && message.result?.tools) {
      message.result.tools = message.result.tools.filter(tool => TOOLS.includes(tool.name));
    }
    send(message);
  });
  child.on("error", error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; input.close(); });
  child.stdin.on("error", () => { process.exitCode = 1; input.close(); });
  child.on("exit", code => { process.exitCode = code ?? 1; input.close(); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) serveGuard(JSON.parse(process.argv[2]));
