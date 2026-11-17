// One layout-owned copy keeps watching even while a different tab is shown.
import { View, div } from "gpui-kit";
import { checking, terminals, panes, focused, window, settings, exec, playSound, notify } from "herdr";
import { sources, parseAgents, Attention } from "./monitor.js";

export default class RemoteHerdrAlerts extends View {
  init(_props, cx) {
    this.watches = new Map();
    this.closed = false;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(2000, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.closed) return;
    const current = sources(terminals(), panes());
    for (const key of this.watches.keys()) if (!current.has(key)) this.watches.delete(key);
    for (const [key, source] of current) {
      let watch = this.watches.get(key);
      if (!watch) {
        watch = { attention: new Attention(), busy: false, retry: 0, error: null };
        this.watches.set(key, watch);
      }
      watch.source = source;
      if (watch.busy || watch.retry > Date.now()) continue;
      watch.busy = true;
      cx.spawn(async () => {
        try {
          const result = await exec(source.command, source.args, { on: source.on, timeout: 5000 });
          if (!this.current(key, watch)) return;
          const agents = parseAgents(result);
          const looking = agent => window()?.active && watch.source.terminals.includes(focused()?.terminal) && agent.focused;
          const sound = watch.attention.update(agents, looking);
          watch.error = null;
          watch.retry = 0;
          if (sound && settings().sounds.enabled) playSound(sound);
        } catch (error) {
          if (!this.current(key, watch)) return;
          watch.attention.reset();
          watch.retry = Date.now() + 30000;
          const message = String(error.message ?? error);
          if (watch.error !== message) {
            notify({ title: "Remote Herdr alerts unavailable", body: `${source.on}: ${message}`, level: "error" });
            watch.error = message;
          }
        } finally { watch.busy = false; }
      });
    }
  }

  current(key, watch) {
    if (this.closed || this.watches.get(key) !== watch) return false;
    const source = sources(terminals(), panes()).get(key);
    if (!source) { this.watches.delete(key); return false; }
    watch.source = source;
    return true;
  }

  close() { this.closed = true; this.watches.clear(); }
  render() { return div().w(0).h(0); }
}
