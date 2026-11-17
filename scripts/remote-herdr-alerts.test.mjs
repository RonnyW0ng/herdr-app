import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const directory = new URL("../defaults/mods/remote-herdr-alerts/", import.meta.url);
const monitorSource = await readFile(new URL("monitor.js", directory), "utf8");
// Load the exact shipped JavaScript without requiring GPUI or a running core.
const { sources, parseAgents, Attention } = new Function(monitorSource.replaceAll("export ", "") + "; return { sources, parseAgents, Attention };")();
const agent = (state, rest = {}) => ({ terminal_id: "term-1", agent_status: state, ...rest });
const record = (address, argv = ["/usr/bin/herdr"], rest = {}) => ({ address, state: "live", argv: ["bash"], foreground: { argv }, ...rest });
const panes = (...addresses) => addresses.map(terminal => ({ terminal }));
const reply = agents => ({ code: 0, stdout: JSON.stringify({ id: "cli:agent:list", result: { type: "agent_list", agents } }) });

test("discovers only remote TUI terminals with panes and deduplicates a server", () => {
  const records = [record("remote/t1"), record("remote/t2", ["herdr"]), record("remote/t3", ["claude"]), record("t1"), record("other/t4")];
  const found = [...sources(records, panes("remote/t1", "remote/t2", "remote/t3", "t1")).values()];
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { key: JSON.stringify(["remote", null]), on: "remote", command: "/usr/bin/herdr", args: ["agent", "list"], terminals: ["remote/t1", "remote/t2"] });
  assert.equal(sources([record("remote/t1", undefined, { state: "finished" })], panes("remote/t1")).size, 0);
});

test("keeps named sessions separate and forwards executable and session literally", () => {
  const records = [record("remote/t1", ["C:\\Program Files\\Herdr\\herdr.exe", "--session", "work's repo"]), record("remote/t2", ["herdr", "--session=second"])];
  const found = [...sources(records, panes("remote/t1", "remote/t2")).values()];
  assert.equal(found.length, 2);
  assert.equal(found[0].command, "C:\\Program Files\\Herdr\\herdr.exe");
  assert.deepEqual(found[0].args, ["--session", "work's repo", "agent", "list"]);
  assert.deepEqual(found[1].args, ["--session", "second", "agent", "list"]);
  for (const flag of ["--remote", "--remote=third", "--machine", "--machine=third"]) {
    assert.equal(sources([record("remote/t1", ["herdr", flag])], panes("remote/t1")).size, 0);
  }
});

test("validates the TUI response instead of treating failed reads as empty snapshots", () => {
  assert.deepEqual(parseAgents(reply([agent("working")])), [agent("working")]);
  for (const result of [{ code: 1, stderr: "offline" }, { code: 0, stdout: "bad json" }, { code: 0, stdout: '{"error":{"message":"no server"}}' }, { code: 0, stdout: '{}' }, reply([null])]) {
    assert.throws(() => parseAgents(result));
  }
});

test("startup and reconnect baseline quietly; state transitions sound exactly once", () => {
  const attention = new Attention(), unseen = () => false;
  assert.equal(attention.update([agent("blocked")], unseen), null);
  assert.equal(attention.update([agent("working")], unseen), null);
  assert.equal(attention.update([agent("blocked")], unseen), "blocked");
  assert.equal(attention.update([agent("blocked")], unseen), null);
  assert.equal(attention.update([agent("idle")], unseen), "done");
  assert.equal(attention.update([agent("idle")], unseen), null);
  attention.reset();
  assert.equal(attention.update([agent("done")], unseen), null);
});

test("detects a complete work cycle between polls using completion_seq", () => {
  const attention = new Attention();
  attention.update([agent("idle", { completion_seq: null })], () => false);
  assert.equal(attention.update([agent("idle", { completion_seq: 8 })], () => false), "done");
  assert.equal(attention.update([agent("idle", { completion_seq: 8 })], () => false), null);
  assert.equal(attention.update([agent("idle", { completion_seq: 10 })], () => false), "done");
});

test("a focused agent's completion is quiet; requests take priority across a batch", () => {
  const attention = new Attention();
  attention.update([agent("working")], () => true);
  assert.equal(attention.update([agent("idle")], () => true), null);
  assert.equal(attention.update([agent("blocked")], () => true), "blocked");
  assert.equal(attention.update([agent("idle"), agent("blocked", { terminal_id: "term-2" })], () => false), "blocked");
});

const viewSource = (await readFile(new URL("main.js", directory), "utf8")).replace(/^import .*;\r?\n/gm, "").replace("export default class", "class");
function harness(checking = false) {
  let live = [record("remote/t1")], focusedAddress = null, active = true, enabled = true;
  let respond = async () => reply([agent("working")]);
  const tasks = [], calls = [], sounds = [], errors = [];
  const globals = { View: class {}, div: () => ({}), sources, parseAgents, Attention, checking: () => checking,
    terminals: () => live, panes: () => panes("remote/t1"), focused: () => ({ terminal: focusedAddress }), window: () => ({ active }), settings: () => ({ sounds: { enabled } }),
    exec: (...args) => { calls.push(args); return respond(); }, playSound: sound => sounds.push(sound), notify: error => errors.push(error) };
  const View = new Function(...Object.keys(globals), viewSource + "; return RemoteHerdrAlerts;")(...Object.values(globals));
  const view = new View(), cx = { spawn: task => { tasks.push(task()); }, timer: { every() {} } };
  view.init({}, cx);
  return { view, cx, calls, sounds, errors, flush: async () => { await Promise.all(tasks.splice(0)); },
    respond: fn => { respond = fn; }, live: value => { live = value; }, enabled: value => { enabled = value; }, focus: (address, isActive = true) => { focusedAddress = address; active = isActive; } };
}

test("controller queries remotely, respects mute and focus, and ignores removed sources", async () => {
  const h = harness(); await h.flush();
  assert.deepEqual(h.calls[0], ["/usr/bin/herdr", ["agent", "list"], { on: "remote", timeout: 5000 }]);
  h.enabled(false); h.respond(async () => reply([agent("blocked")])); h.view.refresh(h.cx); await h.flush();
  assert.deepEqual(h.sounds, []);
  h.enabled(true); h.respond(async () => reply([agent("working")])); h.view.refresh(h.cx); await h.flush();
  h.focus("remote/t1"); h.respond(async () => reply([agent("idle", { focused: true })])); h.view.refresh(h.cx); await h.flush();
  assert.deepEqual(h.sounds, []);
  h.respond(async () => reply([agent("blocked")])); h.view.refresh(h.cx); await h.flush();
  assert.deepEqual(h.sounds, ["blocked"]);
  let resolve;
  h.respond(() => new Promise(r => { resolve = r; })); h.view.refresh(h.cx); h.view.refresh(h.cx);
  const count = h.calls.length;
  h.live([]); resolve(reply([agent("idle")])); await h.flush();
  assert.equal(h.calls.length, count);
  assert.deepEqual(h.sounds, ["blocked"]);
});

test("failures back off, report once, and reset the comparison before recovery", async () => {
  const h = harness(); await h.flush();
  h.respond(async () => { throw new Error("offline"); }); h.view.refresh(h.cx); await h.flush();
  assert.equal(h.errors.length, 1);
  const count = h.calls.length; h.view.refresh(h.cx); await h.flush(); assert.equal(h.calls.length, count);
  const watch = [...h.view.watches.values()][0]; watch.retry = 0;
  h.view.refresh(h.cx); await h.flush(); assert.equal(h.errors.length, 1);
  watch.retry = 0; h.respond(async () => reply([agent("blocked")])); h.view.refresh(h.cx); await h.flush();
  assert.deepEqual(h.sounds, []);
});

test("completion sounds when the outer window is inactive even if the inner agent has focus", async () => {
  const h = harness(); await h.flush();
  h.focus("remote/t1", false); h.respond(async () => reply([agent("idle", { focused: true })]));
  h.view.refresh(h.cx); await h.flush(); assert.deepEqual(h.sounds, ["done"]);
});

test("closing ignores an outstanding result and starts no new work", async () => {
  const h = harness(); await h.flush();
  let resolve; h.respond(() => new Promise(r => { resolve = r; })); h.view.refresh(h.cx);
  const count = h.calls.length; h.view.close(); resolve(reply([agent("blocked")])); await h.flush();
  h.view.refresh(h.cx); assert.equal(h.calls.length, count); assert.deepEqual(h.sounds, []);
});

test("checking a mod starts no processes", async () => {
  const h = harness(true); await h.flush(); assert.deepEqual(h.calls, []);
});

test("every shipped layout mounts one zero-width bridge beside its existing toolbar", async () => {
  for (const [name, id, mod, height] of [["main", "brand", "workspace-chrome", 46], ["terminals", "tabs", "terminals-bar", 38], ["win98", "taskbar", "win98", 40]]) {
    const layout = JSON.parse(await readFile(new URL(`../defaults/layouts/${name}.json`, import.meta.url), "utf8"));
    const walk = n => [n, ...(n.children ?? []).flatMap(walk)];
    const nodes = walk(layout), bridges = nodes.filter(n => n.content?.mod === "remote-herdr-alerts");
    assert.equal(bridges.length, 1);
    assert.equal(bridges[0].size.px, 0);
    assert.equal(bridges[0].hidden, undefined);
    assert.equal(nodes.find(n => n.id === id).content.mod, mod);
    const owner = nodes.find(n => n.children?.includes(bridges[0]));
    assert.equal(owner.type, "row"); assert.equal(owner.size.px, height);
    assert.equal(owner.resizable, false);
    assert.equal(owner.gap ?? 0, 0); assert.equal(owner.divider, undefined);
    assert.equal(new Set(nodes.map(n => n.id)).size, nodes.length);
  }
});
