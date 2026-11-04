// Doosre panels (Payment Bot / Backup Center) kholne ke tiles
let P = null;
A.openSibling = async function(key){
  try{ if(!P) P = (await A.api('/api/panels')).panels; }catch(e){ A.fail(e); return; }
  const s = P.find(x => x.key === key);
  if(!s){ A.toast('Env mein PANEL_' + key.toUpperCase() + '_URL set karo (Render → Environment)', 'err'); return; }
  window.open(s.url, '_blank', 'noopener');
};
