"use strict";

/*  Draft state survives a refresh.

    Picks reference pool indices, so a saved draft is only meaningful against
    the same pool — restoring picks onto a different projection set would
    silently rename every player on your roster. The signature guards that.   */
const SAVE_KEY = "draftboard.v1";
const CFG_KEY  = "draftboard.league.v1";   // settings, kept away from draft state
const PROJ_KEY = "draftboard.projections.v1";
const PROJ_SOURCE_KEY = "draftboard.projectionSource.v1";
const PROJ_VERSION_KEY = "draftboard.projectionVersion.v1";

// Include names, ordering AND data. A count/first-player signature cannot
// distinguish sequential releases of the same top-400 projection pool.
const poolSig = () => {
  let hash = 2166136261;
  for(const p of pool){
    const line = [p.name,p.team,p.gp,p.adp,p.fgm,p.fga,p.ftm,p.fta,
      p.tpm,p.pts,p.reb,p.ast,p.stl,p.blk,p.to].join("|");
    for(let i=0;i<line.length;i++){
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash,16777619);
    }
  }
  return pool.length + "|" + (hash>>>0).toString(16);
};

// Fresh default projections are read directly from RAW on each visit.
// Legacy saved projection text is classified as custom unless it exactly
// matches RAW; this avoids silently deleting an intentional import.
function currentProjectionText(){
  const saved = loadProjectionText();
  let source = null;
  try{ source = localStorage.getItem(PROJ_SOURCE_KEY); }catch(e){}
  if(source === "custom") return saved;
  if(source === "bundled") return "";
  if(!saved || saved.trim() === RAW.trim()){
    try{ localStorage.setItem(PROJ_SOURCE_KEY,"bundled"); }catch(e){}
    return "";
  }
  // Old versions didn't tag imports. Retain the data rather than risk loss.
  try{ localStorage.setItem(PROJ_SOURCE_KEY,"custom"); }catch(e){}
  return saved;
}
function markBundledProjection(){
  try{
    localStorage.setItem(PROJ_SOURCE_KEY,"bundled");
    localStorage.setItem(PROJ_VERSION_KEY, PROJECTION_DATASET_META.updated);
  }catch(e){}
}


function saveProjectionText(text){
  try{
    localStorage.setItem(PROJ_KEY, text);
    localStorage.setItem(PROJ_SOURCE_KEY, "custom");
  }catch(e){}
}

function loadProjectionText(){
  try{ return localStorage.getItem(PROJ_KEY) || ""; }catch(e){ return ""; }
}

function clearProjectionText(){
  try{
    localStorage.removeItem(PROJ_KEY);
    markBundledProjection();
    return true;
  }catch(e){
    return false;
  }
}

/*  League settings live in their own key, deliberately.

    They used to ride along inside the draft-state blob, which coupled them to
    the pool signature and to every code path that cleared or replaced a draft.
    Importing projections is exactly such a path — and league setup is the first
    thing a user is asked for, so losing it there is the worst possible moment.
    Settings are about the league; picks are about one draft. Different keys.  */
/*  View preferences ride with the league settings rather than living in a
    scatter of one-off keys. Anything the user deliberately set should still be
    set after a refresh — which display mode, which sort, whether Tuning is
    open, how wide the panels are.                                            */
function uiPrefs(){
  return {
    tuning: !$("#tuning").classList.contains("hide"),
    starsOpen,
    mode: $("#mode") ? $("#mode").value : "z",
    ledgerMode, ledgerCollapsed, posFilter, sortKey, sortDir,
    split: typeof splitFrac === "number" ? splitFrac : undefined
  };
}

function saveSettings(){
  try{
    localStorage.setItem(CFG_KEY, JSON.stringify({
      cfg, shape, theme: document.body.dataset.theme, ui: uiPrefs()
    }));
  }catch(e){}
}

function loadSettings(){
  try{
    const d = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
    if(!d) return false;
    if(d.cfg) Object.assign(cfg, d.cfg);
    if(typeof d.shape === "number") shape = d.shape;
    if(d.theme) document.body.dataset.theme = d.theme;
    if(d.ui) pendingUI = d.ui;      // applied once the elements exist
    return true;
  }catch(e){ return false; }
}

/*  Restored after boot, because several of these live on DOM elements that the
    render pass reads from.                                                   */
let pendingUI = null;
function applyUIPrefs(){
  const u = pendingUI;
  if(!u) return;
  if(typeof u.ledgerMode === "string") ledgerMode = u.ledgerMode;
  if(typeof u.ledgerCollapsed === "boolean") ledgerCollapsed = u.ledgerCollapsed;
  if(typeof u.posFilter === "string")  posFilter  = u.posFilter;
  if(typeof u.sortKey === "string")    sortKey    = u.sortKey;
  if(u.sortDir === 1 || u.sortDir === -1) sortDir = u.sortDir;
  if(typeof u.mode === "string" && $("#mode")) $("#mode").value = u.mode;
  if(typeof u.split === "number"){ splitFrac = applySplit(u.split); }
  setTuning(!!u.tuning);
  if(typeof u.starsOpen === "boolean") setStarsOpen(u.starsOpen);

  [...$("#ledgermode").querySelectorAll("button")].forEach(b=>
    b.classList.toggle("on", b.dataset.m === ledgerMode));
  [...$("#posfilter").querySelectorAll("button")].forEach(b=>
    b.classList.toggle("on", b.dataset.p === posFilter));
  $("#ledgerbody").classList.toggle("hide", ledgerCollapsed);
  $("#ledgercollapse").textContent = ledgerCollapsed ? "Expand" : "Collapse";
  $("#ledgercollapse").setAttribute("aria-expanded", String(!ledgerCollapsed));
  pendingUI = null;
}

function saveState(){
  saveSettings();
  try{
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      sig: poolSig(),
      picks: picks.map(pk => {
        const p = pk.playerId === null || pk.playerId === undefined
          ? null : pool.find(x => x.id === pk.playerId);
        return {...pk, playerName: p ? p.name : (pk.unknownName || null)};
      }),
      locks, ledgerTeam
    }));
  }catch(e){ /* private browsing, quota, file:// restrictions — not worth failing over */ }
}

function loadState(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(!raw) return false;
    const d = JSON.parse(raw);
    // Legacy blobs carried settings too; honour them once so nobody loses a setup.
    if(d.cfg) Object.assign(cfg, d.cfg);
    if(typeof d.shape === "number") shape = d.shape;
    if(d.theme) document.body.dataset.theme = d.theme;
    if(!Array.isArray(d.picks)) return false;
    if(d.sig === poolSig()){
      picks = d.picks;
    } else {
      // Only remap picks with an explicitly saved name. Legacy index-only
      // picks are not safe to remap after a dataset change.
      if(d.picks.some(pk => pk.playerId != null && !pk.playerName)) return false;
      const byName = new Map();
      for(const player of pool){
        const key = nameKey(player.name);
        if(!byName.has(key)) byName.set(key, player);
        else byName.set(key, null); // ambiguous names must not match
      }
      const migrated = [];
      for(const pk of d.picks){
        if(pk.playerId == null){ migrated.push(pk); continue; }
        const matched = byName.get(nameKey(pk.playerName || ""));
        // Preserve draft integrity; don't silently lose or substitute picks.
        if(!matched) return false;
        migrated.push({...pk, playerId:matched.id});
      }
      picks = migrated;
      // Persist migrated IDs against the new dataset signature.
      saveState();
    }
    if(d.locks && typeof d.locks === "object") locks = d.locks;
    ledgerTeam = (typeof d.ledgerTeam === "number") ? d.ledgerTeam : null;
    return picks.length > 0;
  }catch(e){ return false; }
}

function clearState(){ try{ localStorage.removeItem(SAVE_KEY); }catch(e){} }   // settings untouched by design
