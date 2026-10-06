(() => {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("sessionId");
  const snapshotId = params.get("snapshotId");
  const nonce = params.get("nonce");
  const parentOrigin = params.get("parentOrigin");
  const state = document.querySelector("#state");
  const button = document.querySelector("#spec");
  const send = (type) => parent.postMessage({ channel: "pi-own-mode-pack", type, sessionId, snapshotId, nonce }, "*");
  send("ready");
  button.addEventListener("click", () => { if (!button.disabled) send("spec-kit-initialize"); });
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || event.origin !== parentOrigin || !data || data.channel !== "pi-own-mode-pack" || data.sessionId !== sessionId || data.snapshotId !== snapshotId || data.nonce !== nonce || data.type !== "status") return;
    state.textContent = typeof data.message === "string" ? data.message : "Mode status is unavailable.";
    button.disabled = !data.canInitialize || Boolean(data.pending);
  });
})();
