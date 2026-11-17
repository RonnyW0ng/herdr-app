// The TUI owns its agents; these are not herdr-core terminal records.
const basename = (s) => String(s ?? "").split(/[\\/]/).pop().toLowerCase();

export function sources(terminals, panes) {
  const kept = new Set(panes.map(p => p.terminal));
  const found = new Map();
  for (const terminal of terminals) {
    const address = terminal.address;
    if (typeof address !== "string" || !address.includes("/") || !kept.has(address) || terminal.state !== "live") continue;
    const foreground = terminal.foreground;
    const argv = foreground?.argv ?? terminal.argv ?? [];
    const command = argv[0];
    if (!["herdr", "herdr.exe"].includes(basename(command))) continue;
    // A TUI attached to a third machine is not this machine's local server.
    if (argv.some(a => a === "--remote" || a.startsWith("--remote=") || a === "--machine" || a.startsWith("--machine="))) continue;
    let session = null;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--session") session = argv[++i] ?? null;
      else if (argv[i].startsWith("--session=")) session = argv[i].slice(10);
    }
    const on = address.split("/")[0];
    const key = JSON.stringify([on, session]);
    const source = found.get(key) ?? { key, on, command, args: [...(session ? ["--session", session] : []), "agent", "list"], terminals: [] };
    source.terminals.push(address);
    found.set(key, source);
  }
  return found;
}

export function parseAgents(result) {
  if (result.code !== 0) throw new Error(result.stderr?.trim() || `herdr agent list exited with ${result.code}`);
  const response = JSON.parse(result.stdout);
  if (response.error) throw new Error(response.error.message || "herdr agent list failed");
  const list = response.result?.agents;
  if (!Array.isArray(list) || list.some(a => !a || typeof a.terminal_id !== "string" || typeof a.agent_status !== "string")) {
    throw new Error("herdr agent list returned an unsupported response");
  }
  return list;
}

export class Attention {
  constructor() { this.previous = null; }
  reset() { this.previous = null; }

  update(agents, looking) {
    const next = new Map(), alerts = [];
    for (const agent of agents) {
      const before = this.previous?.get(agent.terminal_id);
      const state = agent.agent_status;
      next.set(agent.terminal_id, { state, completion: agent.completion_seq, seq: agent.state_change_seq });
      // Initial connection and recovery establish a quiet baseline.
      if (this.previous === null) continue;
      if (state === "blocked" && (before?.state !== "blocked" || (agent.state_change_seq > before.seq))) {
        alerts.push("blocked");
      } else if (!looking(agent) && ["idle", "done"].includes(state) && before && (
        ["working", "blocked"].includes(before.state) ||
        (typeof agent.completion_seq === "number" && agent.completion_seq > (before.completion ?? -1))
      )) {
        alerts.push("done");
      }
    }
    this.previous = next;
    // Several agents in one snapshot share one sound; requests take priority.
    return alerts.includes("blocked") ? "blocked" : alerts.includes("done") ? "done" : null;
  }
}
