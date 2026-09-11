/* Fixed renderer only: no model code, URLs, plugins or arbitrary Plotly layout. */
(() => {
  const token = new URLSearchParams(location.search).get('token');
  const status = document.getElementById('status');
  const plot = document.getElementById('plot');
  let current = null;
  let generation = 0;
  async function render(artifact) {
    const thisGeneration = ++generation;
    const spec = artifact.spec;
    status.textContent = 'Rendering validated data…';
    if (typeof window.Plotly === 'undefined') { status.textContent = 'Plotly failed to load; numerical data remains available.'; return; }
    const is3d = spec.kind === 'surface3d' || spec.kind === 'scatter3d';
    if (is3d) {
      const canvas = document.createElement('canvas');
      if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) { status.textContent = 'WebGL unavailable: 3D rendering is not supported here. Inspect numerical data below.'; return; }
    }
    try {
      const series = artifact.data.map(row => ({type: row.type, name: row.name, mode: row.mode, x: row.x, y: row.y, ...(row.z ? {z:row.z} : {})}));
      const layout = {title:{text:spec.title}, margin:{l:60,r:20,t:50,b:55}, paper_bgcolor:'#fff', plot_bgcolor:'#fff', xaxis:{title:{text:spec.xLabel}}, yaxis:{title:{text:spec.yLabel}}, ...(is3d ? {scene:{xaxis:{title:{text:spec.xLabel}},yaxis:{title:{text:spec.yLabel}},zaxis:{title:{text:spec.zLabel}}}} : {})};
      if (spec.kind === 'matrix2d') layout.yaxis = {...layout.yaxis,scaleanchor:'x',scaleratio:1};
      await window.Plotly.react(plot,series,layout,{responsive:true,displaylogo:false,scrollZoom:true,showLink:false,modeBarButtonsToRemove:['toImage','sendDataToCloud']});
      if (thisGeneration !== generation) return;
      plot.setAttribute('aria-label',spec.title + '. ' + spec.purpose);
      status.textContent = spec.purpose + (is3d ? ' · Drag to rotate; scroll to zoom.' : ' · Drag to zoom; double-click to reset.');
      parent.postMessage({type:'pi-math-rendered',token,id:artifact.id},'*');
    } catch (error) { status.textContent = 'Rendering failed: ' + String(error); }
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || !token || event.data?.token !== token || event.data?.type !== 'pi-math-artifact') return;
    const artifact = event.data.artifact;
    if (!artifact || !Array.isArray(artifact.data) || artifact.rendererVersion !== 'pi-math-v1/plotly-strict-4.1.0') return;
    current = artifact;
    document.getElementById('data').textContent = JSON.stringify(artifact.data,null,2);
    void render(artifact);
  });
  document.getElementById('reset').addEventListener('click',()=>{if(current){window.Plotly?.purge(plot);void render(current);}});
  parent.postMessage({type:'pi-math-ready',token},'*');
})();
