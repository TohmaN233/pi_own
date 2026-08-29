class PiTeacherStudioPanel extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }); this.draft = null; }
  connectedCallback() {
    this.shadowRoot.innerHTML = `<style>:host{display:block;font:14px/1.45 system-ui;border:1px solid #8885;border-radius:12px;padding:14px}label{display:block;margin:.6rem 0}input,textarea{width:100%;box-sizing:border-box}button{margin:.35rem .35rem 0 0}pre{white-space:pre-wrap}</style><h2>Teacher Studio</h2><label>Course ID<input id="course"></label><label>Title<input id="title"></label><button id="create">Create draft</button><label>Markdown material<textarea id="material" rows="8"></textarea></label><button id="add">Add material</button><button id="publish">Publish immutable CourseVersion</button><pre id="out"></pre>`;
    this.shadowRoot.getElementById("create").onclick = () => this.createDraft();
    this.shadowRoot.getElementById("add").onclick = () => this.addMaterial();
    this.shadowRoot.getElementById("publish").onclick = () => this.publish();
  }
  async call(action, input) {
    const response = await fetch(this.getAttribute("endpoint") || "/api/teacher/harness", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, input }) });
    const result = await response.json();
    if (!result.ok) throw new Error(`${result.error?.code || "ERROR"}: ${result.error?.message || "request failed"}`);
    this.shadowRoot.getElementById("out").textContent = JSON.stringify(result.data, null, 2);
    return result.data;
  }
  async createDraft() { try { this.draft = await this.call("create-draft", { courseId: this.shadowRoot.getElementById("course").value, title: this.shadowRoot.getElementById("title").value }); } catch (error) { this.showError(error); } }
  async addMaterial() { try { if (!this.draft) throw new Error("Create a draft first"); this.draft = await this.call("add-material", { draftId: this.draft.draftId, expectedRevision: this.draft.revision, material: { name: `lesson-${this.draft.revision}.md`, kind: "markdown", mediaType: "text/markdown", content: this.shadowRoot.getElementById("material").value } }); } catch (error) { this.showError(error); } }
  async publish() { try { if (!this.draft) throw new Error("Create a draft first"); await this.call("publish", { draftId: this.draft.draftId, expectedRevision: this.draft.revision, profiles: ["student-learn", "practice", "visual-lab"] }); } catch (error) { this.showError(error); } }
  showError(error) { this.shadowRoot.getElementById("out").textContent = String(error); }
}
customElements.define("pi-teacher-studio-panel", PiTeacherStudioPanel);
