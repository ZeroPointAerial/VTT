/**
 * The Drowned Bell of Saltmere: runtime helpers.
 * Tide Track, True Tolls and Villagers Saved tracker, bell sounds, and the Bell's fixed initiative.
 */
const MOD = "drowned-bell-saltmere";
const ROOT = `modules/${MOD}`;
const SOUNDS = {
  drowned: `${ROOT}/assets/audio/bell-toll-drowned.ogg`,
  truebell: `${ROOT}/assets/audio/bell-toll-true.ogg`,
  whispers: `${ROOT}/assets/audio/hag-whispers.ogg`
};

const TRUE_TOLL_TEXT = {
  1: "Golden light spreads through the water. <strong>Mother Silt's toll on initiative count 20 no longer happens.</strong>",
  2: "The captured villagers begin to stir. <strong>Drowned Thralls are stunned until the end of their next turn.</strong> Mother Silt loses her resistance to nonmagical weapons.",
  3: "<strong>The hold breaks.</strong> Every thrall collapses into seaweed and bones. Mother Silt has disadvantage on attack rolls and saving throws, and cannot flee into the water. The villagers wake and float down unharmed."
};

const isGM = () => game.user.isGM;
const primaryGM = () => game.users.activeGM ?? game.users.find(u => u.isGM && u.active);
const amPrimaryGM = () => primaryGM()?.id === game.user.id;
const get = key => game.settings.get(MOD, key);

function playSound(src, volume = 0.8) {
  const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
  return helper.play({ src, volume, loop: false, autoplay: true }, true);
}

async function chat(content, { whisperGM = false } = {}) {
  const data = { content: `<div class="saltmere-chat">${content}</div>`, speaker: { alias: "The Drowned Bell" } };
  if ( whisperGM ) data.whisper = game.users.filter(u => u.isGM).map(u => u.id);
  return ChatMessage.create(data);
}

/* -------------------------------------------- */
/*  Settings & state                            */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const onChange = () => Tracker.render();
  game.settings.register(MOD, "tideMarks", { scope: "world", config: false, type: Number, default: 10, onChange: v => { onChange(); syncTideTiles(v); } });
  game.settings.register(MOD, "trueTolls", { scope: "world", config: false, type: Number, default: 0, onChange: v => { onChange(); syncGoldenLight(v); } });
  game.settings.register(MOD, "saved", { scope: "world", config: false, type: Number, default: 0, onChange });
  game.settings.register(MOD, "ringDC", {
    name: "Ring-true DC", hint: "DC for ringing the bell true (14 by default; 13 for a party of three).",
    scope: "world", config: true, type: Number, default: 14
  });
  game.settings.register(MOD, "playersSeeTracker", {
    name: "Players see the Saltmere Tracker", hint: "Show the read-only tracker panel to players on this adventure's scenes.",
    scope: "world", config: true, type: Boolean, default: true, onChange
  });
  game.settings.register(MOD, "trackerMode", {
    name: "Tracker visibility", scope: "client", config: false, type: String, default: "auto", onChange
  });
});

/* -------------------------------------------- */
/*  Foundry v14 Scene Levels                    */
/* -------------------------------------------- */

/**
 * In v14 the map image belongs to each Scene Level (level.background.src), not the scene.
 * Our scene data sets the scene-wide background (v12/v13 format), so copy it onto the Level(s),
 * creating one if needed. No-op on v13 and earlier, and on scenes from other packages.
 */
async function ensureLevelBackground(scene) {
  try {
    const src = scene._source.background?.src;
    if ( !src?.startsWith(`${ROOT}/`) ) return;
    if ( !scene.levels ) return;
    const levels = Array.from(scene.levels);
    if ( !levels.length ) {
      await scene.createEmbeddedDocuments("Level", [{ name: "Main", background: { src } }]);
      return;
    }
    const updates = levels.filter(l => !(l._source?.background?.src ?? l.background?.src))
      .map(l => ({ _id: l.id, "background.src": src }));
    if ( updates.length ) await scene.updateEmbeddedDocuments("Level", updates);
  } catch(err) {
    console.warn(`${MOD} | Could not set the Level background for scene "${scene.name}"`, err);
  }
}

Hooks.on("createScene", (scene, options, userId) => {
  if ( userId === game.user.id ) ensureLevelBackground(scene);
});

Hooks.once("ready", async () => {
  game.modules.get(MOD).api = API;
  game.socket.on(`module.${MOD}`, onSocket);
  if ( amPrimaryGM() ) {
    let fixed = false;
    for ( const scene of game.scenes ) {
      const before = scene.levels ? Array.from(scene.levels).map(l => l._source?.background?.src).join() : null;
      await ensureLevelBackground(scene);
      const after = scene.levels ? Array.from(scene.levels).map(l => l._source?.background?.src).join() : null;
      if ( before !== after ) fixed = true;
    }
    if ( fixed && canvas?.scene ) canvas.draw();
  }
  Tracker.render();
});
Hooks.on("canvasReady", () => Tracker.render());

/* The Bell always acts on initiative count 20 (losing ties). */
Hooks.on("createCombatant", (combatant) => {
  if ( !amPrimaryGM() ) return;
  if ( combatant.actor?.getFlag(MOD, "bell") ) combatant.update({ initiative: 19.99 });
});

async function setValue(key, value) {
  if ( isGM() ) return game.settings.set(MOD, key, value);
  game.socket.emit(`module.${MOD}`, { action: "set", key, value });
}

function onSocket(data) {
  if ( !amPrimaryGM() ) return;
  if ( data.action === "set" && ["tideMarks", "trueTolls", "saved"].includes(data.key) ) {
    if ( data.key === "trueTolls" ) return addTrueToll(data.value - get("trueTolls"));
    return game.settings.set(MOD, data.key, data.value);
  }
  if ( data.action === "trueToll" ) return addTrueToll(1);
}

/* -------------------------------------------- */
/*  Scene sync: tide tiles & golden light       */
/* -------------------------------------------- */

async function syncTideTiles(marks) {
  if ( !amPrimaryGM() ) return;
  for ( const scene of game.scenes ) {
    const updates = [];
    for ( const tile of scene.tiles ) {
      const kind = tile.getFlag(MOD, "tide");
      if ( !kind ) continue;
      const show = kind === "knee" ? (marks <= 3 && marks > 0) : (marks <= 0);
      if ( tile.hidden === show ) updates.push({ _id: tile.id, hidden: !show });
    }
    if ( updates.length ) await scene.updateEmbeddedDocuments("Tile", updates);
  }
}

async function syncGoldenLight(tolls) {
  if ( !amPrimaryGM() ) return;
  for ( const scene of game.scenes ) {
    const updates = [];
    for ( const light of scene.lights ) {
      const kind = light.getFlag(MOD, "light");
      if ( kind === "golden" ) {
        const show = tolls >= 1;
        if ( light.hidden === show ) updates.push({ _id: light.id, hidden: !show });
      }
      if ( kind === "bellgreen" ) {
        const show = tolls < 1;
        if ( light.hidden === show ) updates.push({ _id: light.id, hidden: !show });
      }
    }
    if ( updates.length ) await scene.updateEmbeddedDocuments("AmbientLight", updates);
  }
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

async function toll() {
  if ( get("trueTolls") >= 1 ) {
    ui.notifications.info("The bell has been rung true: Mother Silt can no longer toll it.");
    return chat("<p>The hag strains at the bell, but it answers only to a true hand now. <em>No toll this round.</em></p>", { whisperGM: true });
  }
  playSound(SOUNDS.drowned, 0.9);
  return chat(`<h3>The Bell Tolls</h3>
    <p>Slow and deep and impossibly clear, the drowned bell rings.</p>
    <p><strong>At midnight:</strong> every <em>sleeping</em> creature makes the save; on a failure it rises and walks toward the sea.</p>
    <p><strong>In the chapel:</strong> every creature that is not Mother Silt's ally makes the save or is &Reference[charmed] until the end of its next turn, must move toward the bell and the channel, and can't attack her.</p>
    <p>[[/save ability=wis dc=13]]</p>`);
}

async function addTrueToll(n = 1) {
  if ( !isGM() ) return game.socket.emit(`module.${MOD}`, { action: "trueToll" });
  const before = get("trueTolls");
  const after = Math.clamp?.(before + n, 0, 3) ?? Math.max(0, Math.min(3, before + n));
  if ( after === before ) return;
  await game.settings.set(MOD, "trueTolls", after);
  if ( after > before ) {
    playSound(SOUNDS.truebell, 1.0);
    await chat(`<h3>A True Toll (${after} of 3)</h3><p>${TRUE_TOLL_TEXT[after]}</p>`);
  }
}

async function setTide(value, reason) {
  if ( !isGM() ) return ui.notifications.warn("Only the GM can spend Tide Marks.");
  const v = Math.max(0, Math.min(10, value));
  await game.settings.set(MOD, "tideMarks", v);
  let msg = `<h3>The Tide: ${v} mark${v === 1 ? "" : "s"} left</h3>`;
  if ( reason ) msg += `<p><em>${reason}</em></p>`;
  if ( v === 0 ) msg += "<p><strong>The caves flood.</strong> Every creature must swim ([[/check skill=ath dc=13]] each round or start drowning) and the way back is closed until the next low tide.</p>";
  else if ( v <= 3 ) msg += "<p>The water is <strong>knee-deep</strong> everywhere: difficult terrain.</p>";
  return chat(msg);
}

async function spendTide(cost, reason) {
  return setTide(get("tideMarks") - cost, reason);
}

async function tideDialog() {
  if ( !isGM() ) return ui.notifications.warn("Only the GM can spend Tide Marks.");
  const DialogV2 = foundry.applications.api.DialogV2;
  const choice = await DialogV2.wait({
    window: { title: `The Tide Track (${get("tideMarks")} marks)` },
    content: "<p>What did the party just do?</p>",
    buttons: [
      { action: "move", label: "Moved to a new area (−1)" },
      { action: "long", label: "Fight of 5+ rounds (−1)" },
      { action: "puzzle", label: "Failed a puzzle (−1)" },
      { action: "rest", label: "Short rest (−3)" },
      { action: "reset", label: "Reset to 10" }
    ],
    rejectClose: false
  });
  switch ( choice ) {
    case "move": return spendTide(1, "The party pushes deeper. The sea follows.");
    case "long": return spendTide(1, "The fight drags on while the tide turns.");
    case "puzzle": return spendTide(1, "The chimes shudder; the water rises.");
    case "rest": return spendTide(3, "A short rest, and the sea creeps in around their ankles.");
    case "reset": return setTide(10, "A new low tide.");
  }
}

async function ringTrue() {
  const token = canvas.tokens?.controlled[0];
  const actor = token?.actor ?? game.user.character;
  if ( !actor ) return ui.notifications.warn("Select the token of the creature ringing the bell.");
  const dc = get("ringDC");
  const holy = !!(actor.classes?.cleric || actor.classes?.paladin);
  const learned = !!actor.getFlag?.(MOD, "hymn");
  const DialogV2 = foundry.applications.api.DialogV2;
  const result = await DialogV2.wait({
    window: { title: `Ring the Bell True: ${actor.name}` },
    content: `
      <p>As an action, a creature adjacent to the bell can try to ring it true (DC ${dc}).</p>
      <div class="form-group"><label>Approach</label>
        <select name="approach">
          <option value="rel">Religion (Intelligence)</option>
          <option value="prf">Performance (Charisma)</option>
          <option value="cha">Charisma check</option>
        </select></div>
      <div class="form-group"><label><input type="checkbox" name="adv" ${holy ? "checked" : ""}> Advantage (cleric or paladin)</label></div>
      <div class="form-group"><label><input type="checkbox" name="hymn" ${learned ? "checked" : ""}> Knows St. Corwen's Vespers (+2)</label></div>`,
    buttons: [{
      action: "ring", label: "Strike the Bell", default: true,
      callback: (event, button) => {
        const f = button.form.elements;
        return { approach: f.approach.value, adv: f.adv.checked, hymn: f.hymn.checked };
      }
    }, { action: "cancel", label: "Cancel" }],
    rejectClose: false
  });
  if ( !result || result === "cancel" ) return;
  const sys = actor.system;
  let mod = 0, label = "";
  if ( result.approach === "cha" ) { mod = sys.abilities?.cha?.mod ?? 0; label = "Charisma"; }
  else {
    const sk = sys.skills?.[result.approach];
    mod = sk?.total ?? sk?.mod ?? 0;
    label = result.approach === "rel" ? "Religion" : "Performance";
  }
  const formula = `${result.adv ? "2d20kh" : "1d20"} + ${mod}${result.hymn ? " + 2" : ""}`;
  const roll = await new Roll(formula).evaluate();
  const success = roll.total >= dc;
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor, token: token?.document }),
    flavor: `<strong>Ring the Bell True</strong> (${label}, DC ${dc})${result.hymn ? ", with the old hymn" : ""}<br>${success ? "<span class='saltmere-success'>The bell answers.</span>" : "<span class='saltmere-fail'>The bell groans and the hag laughs.</span>"}`
  });
  if ( success ) return addTrueToll(1);
}

async function revealAnselm() {
  if ( !isGM() ) return;
  const scene = canvas.scene;
  if ( !scene ) return;
  const tokens = scene.tokens.filter(t => t.actor?.getFlag(MOD, "anselm"));
  const lights = scene.lights.filter(l => l.getFlag(MOD, "light") === "anselm");
  const reveal = tokens.some(t => t.hidden) || lights.some(l => l.hidden);
  await scene.updateEmbeddedDocuments("Token", tokens.map(t => ({ _id: t.id, hidden: !reveal })));
  await scene.updateEmbeddedDocuments("AmbientLight", lights.map(l => ({ _id: l.id, hidden: !reveal })));
  if ( reveal ) await chat("<p>A cold light gathers on the tilted pulpit. A drowned priest looks at you, and only at you.</p>");
}

async function resetNight() {
  if ( !isGM() ) return;
  await game.settings.set(MOD, "tideMarks", 10);
  await game.settings.set(MOD, "trueTolls", 0);
  await game.settings.set(MOD, "saved", 0);
  ui.notifications.info("Saltmere: the night has been reset.");
}

/* -------------------------------------------- */
/*  Tracker panel                               */
/* -------------------------------------------- */

const Tracker = {
  el: null,
  visible() {
    const mode = game.settings.get(MOD, "trackerMode");
    if ( mode === "hide" ) return false;
    if ( !isGM() && !get("playersSeeTracker") ) return false;
    if ( mode === "show" ) return true;
    return !!canvas?.scene?.getFlag(MOD, "tracker");
  },
  render() {
    if ( !game.ready ) return;
    if ( !this.visible() ) { this.el?.remove(); this.el = null; return; }
    if ( !this.el ) {
      this.el = document.createElement("section");
      this.el.id = "saltmere-tracker";
      document.body.appendChild(this.el);
      this.el.addEventListener("click", ev => this.onClick(ev));
    }
    const tide = get("tideMarks"), tolls = get("trueTolls"), saved = get("saved");
    const gm = isGM();
    const pips = (n, max, cls) => Array.from({ length: max }, (_, i) => `<span class="pip ${cls} ${i < n ? "on" : ""}"></span>`).join("");
    const btn = (act, label, title) => gm ? `<button type="button" data-act="${act}" title="${title}">${label}</button>` : "";
    const tideState = tide <= 0 ? "flooded" : tide <= 3 ? "knee-deep" : "";
    this.el.innerHTML = `
      <header><span class="bell"></span> The Drowned Bell</header>
      <div class="row" title="Tide Marks: move 1, long fight 1, failed puzzle 1, short rest 3">
        <label>Tide</label><div class="pips">${pips(tide, 10, "tide")}</div>
        <span class="val">${tide}${tideState ? ` <em>${tideState}</em>` : ""}</span>
        ${btn("tide-", "−", "Spend 1 mark")}${btn("tide+", "+", "Restore 1 mark")}${btn("tide?", "…", "Tide costs")}
      </div>
      <div class="row" title="Three true tolls break the hag's hold">
        <label>True Tolls</label><div class="pips">${pips(tolls, 3, "toll")}</div>
        <span class="val">${tolls}/3</span>
        ${btn("toll-", "−", "Remove a toll")}${btn("toll+", "+", "Add a true toll")}
      </div>
      <div class="row" title="Sleepwalkers saved at midnight">
        <label>Saved</label><div class="pips">${pips(Math.min(saved, 6), 6, "saved")}</div>
        <span class="val">${saved}</span>
        ${btn("saved-", "−", "")}${btn("saved+", "+", "")}
      </div>
      ${gm ? `<footer>${btn("ring", "Toll the Bell", "Hag's toll: Wisdom saves")}${btn("hide", "Hide", "Hide this panel")}</footer>` : ""}`;
  },
  onClick(ev) {
    const act = ev.target.closest("button")?.dataset.act;
    if ( !act ) return;
    switch ( act ) {
      case "tide-": return spendTide(1);
      case "tide+": return setTide(get("tideMarks") + 1);
      case "tide?": return tideDialog();
      case "toll+": return addTrueToll(1);
      case "toll-": return game.settings.set(MOD, "trueTolls", Math.max(0, get("trueTolls") - 1));
      case "saved+": return game.settings.set(MOD, "saved", get("saved") + 1);
      case "saved-": return game.settings.set(MOD, "saved", Math.max(0, get("saved") - 1));
      case "ring": return toll();
      case "hide": return game.settings.set(MOD, "trackerMode", "hide");
    }
  }
};

function toggleTracker() {
  return game.settings.set(MOD, "trackerMode", Tracker.el ? "hide" : "show");
}

const API = { ensureLevelBackground, repairLevels: async () => { for ( const s of game.scenes ) await ensureLevelBackground(s); return canvas?.scene ? canvas.draw() : null; }, toll, addTrueToll, ringTrue, spendTide, setTide, tideDialog, revealAnselm, resetNight, toggleTracker, playSound, SOUNDS };
