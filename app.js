/*
 * app.js — Roland EF-303 web MIDI editor
 *
 * Web MIDI front-end that drives the EF303 data model (ef303-data.js). Edits
 * are sent as Roland DT1 messages to the Temporary Patch so they take effect
 * immediately; the whole patch can be read back with an RQ1 request.
 */
'use strict';

/* ============================ MIDI state ============================ */
let midiAccess = null;
let midiOutput = null;
let midiInput = null;

// Live mirror of the 150-byte patch the editor believes is in the unit.
const patch = new Uint8Array(EF303.ADDR.PATCH_SIZE);

let currentEffectId = 13;     // default to Syn+Dly (most to show off)
let writeMode = 'sysex';      // 'sysex' | 'cc'
let pendingRead = false;
let autoReadDone = false;     // we pull the patch once after connecting

/* ============================ helpers ============================ */
const $ = (id) => document.getElementById(id);

function deviceId() { return parseInt($('deviceId').value) & 0x7f; }
function midiChannel() { return parseInt($('midiChannel').value) & 0x0f; }

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function log(line) {
  const el = $('monitor');
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  el.textContent = `${ts}  ${line}\n` + el.textContent;
  // keep the monitor from growing unbounded
  if (el.textContent.length > 8000) el.textContent = el.textContent.slice(0, 8000);
}

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const hexBytes = (arr) => Array.from(arr).map(hex).join(' ');

/* ============================ Roland SysEx ============================ */

// Add an integer offset (hi*128 + lo) to a 4-byte Roland address, carrying in
// 7-bit units. EF-303 offsets never exceed two low bytes, but we carry fully.
function addAddress(base, offset) {
  const a = base.slice();
  let lo = a[3] + (offset & 0x7f);
  let carry = lo >> 7; a[3] = lo & 0x7f;
  let b2 = a[2] + ((offset >> 7) & 0x7f) + carry;
  carry = b2 >> 7; a[2] = b2 & 0x7f;
  let b1 = a[1] + carry; carry = b1 >> 7; a[1] = b1 & 0x7f;
  a[0] = (a[0] + carry) & 0x7f;
  return a;
}

// Roland checksum: the value that makes (sum of address + data) a multiple of
// 128. i.e. (128 - (sum % 128)) % 128.
function rolandChecksum(bytes) {
  const sum = bytes.reduce((s, b) => s + b, 0) & 0x7f;
  return (128 - sum) & 0x7f;
}

// Build a DT1 (write) message for `data` bytes at `address` (4 bytes).
function buildDT1(address, data) {
  const body = address.concat(data);
  const { ROLAND, MODEL_HI, MODEL_LO, DT1 } = EF303.SYSEX;
  return [0xf0, ROLAND, deviceId(), MODEL_HI, MODEL_LO, DT1,
          ...body, rolandChecksum(body), 0xf7];
}

// Build an RQ1 (read request) for `size` bytes at `address`.
function buildRQ1(address, size) {
  const sizeBytes = [(size >> 21) & 0x7f, (size >> 14) & 0x7f,
                     (size >> 7) & 0x7f, size & 0x7f];
  const body = address.concat(sizeBytes);
  const { ROLAND, MODEL_HI, MODEL_LO, RQ1 } = EF303.SYSEX;
  return [0xf0, ROLAND, deviceId(), MODEL_HI, MODEL_LO, RQ1,
          ...body, rolandChecksum(body), 0xf7];
}

/* ============================ Paced send queue ============================ */
// The manual (p.72) requires at least 20 ms between successive DT1 packets.
// Every outgoing message goes through this queue, which enforces that spacing
// and coalesces rapid updates to the same key (e.g. a slider drag) so only the
// latest value is actually sent. Map insertion order is preserved on overwrite,
// so a parameter keeps its place in line while its value is refreshed.
const SEND_INTERVAL_MS = 20;
const sendQueue = new Map();   // key -> { msg, label }
let flushTimer = null;
let lastSendAt = -Infinity;

function queueSend(key, msg, label) {
  if (!midiOutput) return;
  sendQueue.set(key, { msg, label });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  const wait = Math.max(0, lastSendAt + SEND_INTERVAL_MS - performance.now());
  flushTimer = setTimeout(flushOne, wait);
}

function flushOne() {
  flushTimer = null;
  const next = sendQueue.entries().next();
  if (next.done) return;
  const [key, { msg, label }] = next.value;
  sendQueue.delete(key);
  if (midiOutput) {
    midiOutput.send(msg);
    log(label);
  }
  lastSendAt = performance.now();
  if (sendQueue.size) scheduleFlush();
}

/* ============================ Parameter writes ============================ */

// Write a single parameter (one byte) to the Temporary Patch.
function writeParam(offset, value) {
  value &= 0x7f;
  patch[offset] = value;

  // BPM Sync changes what the RATE/LOW knob (and so C1) drives; relabel.
  if (offset === 0x4b) renderStepModConfig();

  const def = paramAtOffset(offset);
  if (writeMode === 'cc' && def && def.cc != null) {
    // Real-time control via Control Change (Receive CC = MODE2).
    const msg = [0xb0 | midiChannel(), def.cc & 0x7f, value];
    queueSend('cc:' + def.cc, msg, `CC  ${hexBytes(msg)}   (CC${def.cc} = ${value})`);
    return;
  }

  const addr = addAddress(EF303.ADDR.TEMP_PATCH, offset);
  const msg = buildDT1(addr, [value]);
  const what = def ? def.name : 'off ' + offset;
  queueSend('off:' + offset, msg, `DT1 ${hexBytes(msg)}   (${what} = ${value})`);
}

// Effect type is a single parameter at patch offset 0.
function writeEffectType(id) {
  patch[0] = id & 0x7f;
  const addr = addAddress(EF303.ADDR.TEMP_PATCH, 0);
  const msg = buildDT1(addr, [patch[0]]);
  queueSend('off:0', msg, `DT1 ${hexBytes(msg)}   (Multi-FX Type = ${id})`);
}

/* Look up a parameter descriptor by its patch offset (for CC fallback etc).
   Effect parameters share offsets across effect types; the only ones with a
   CC mapping are the synth block (prm11-29), which is identical for both
   synth effects, so the collision is harmless for CC lookup. */
let _offsetIndex = null;
function paramAtOffset(offset) {
  if (!_offsetIndex) {
    _offsetIndex = {};
    EF303.EFFECTS.forEach(e => e.params.forEach(p => { _offsetIndex[p.off] = p; }));
    EF303.GLOBAL.forEach(p => { _offsetIndex[p.off] = p; });
    EF303.STEPMOD.config.forEach(p => { _offsetIndex[p.off] = p; });
  }
  return _offsetIndex[offset];
}

/* ============================ Master Tempo (2-byte) ============================ */
function writeMasterTempo(bpm) {
  const fixed = Math.round(bpm * 10);            // 400..2400
  const h = (fixed >> 7) & 0x7f, l = fixed & 0x7f;
  patch[0x43] = h; patch[0x44] = l;
  const addr = addAddress(EF303.ADDR.TEMP_PATCH, 0x43);
  const msg = buildDT1(addr, [h, l]);            // contiguous 2-byte write
  queueSend('tempo', msg, `DT1 ${hexBytes(msg)}   (Master Tempo = ${bpm.toFixed(1)} BPM)`);
}
function readMasterTempo() {
  return ((patch[0x43] << 7) | patch[0x44]) / 10;
}

/* ============================ Web MIDI setup ============================ */
async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    setStatus('Web MIDI not supported in this browser. Use Chrome or Edge.', 'err');
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    setStatus('MIDI access granted — detecting devices…');
    midiAccess.onstatechange = populateDevices;
    populateDevices();
  } catch (e) {
    setStatus('Failed to access MIDI (SysEx permission denied?): ' + e.message, 'err');
  }
}

function populateDevices() {
  const outSel = $('midiOutput'), inSel = $('midiInput');
  const prevOut = midiOutput && midiOutput.id;
  const prevIn = midiInput && midiInput.id;
  outSel.innerHTML = '<option value="">— select output —</option>';
  inSel.innerHTML = '<option value="">— select input —</option>';

  let outs = 0, ins = 0;
  for (const out of midiAccess.outputs.values()) {
    outSel.add(new Option(out.name, out.id));
    outs++;
  }
  for (const inp of midiAccess.inputs.values()) {
    inSel.add(new Option(inp.name, inp.id));
    ins++;
  }
  // Restore / auto-select.
  if (prevOut && midiAccess.outputs.get(prevOut)) outSel.value = prevOut;
  else if (outs) { outSel.selectedIndex = 1; }
  if (prevIn && midiAccess.inputs.get(prevIn)) inSel.value = prevIn;
  else if (ins) { inSel.selectedIndex = 1; }

  setStatus(outs || ins
    ? `Connected: ${outs} output(s), ${ins} input(s).`
    : 'No MIDI devices found. Connect the EF-303 and it will appear here.',
    outs ? 'ok' : '');

  // These may kick off the one-time automatic patch read, so they come after
  // the status line above.
  selectOutput();
  selectInput();
}

function selectOutput() {
  const id = $('midiOutput').value;
  midiOutput = id ? midiAccess.outputs.get(id) : null;
  maybeAutoRead();
}
function selectInput() {
  if (midiInput) midiInput.onmidimessage = null;
  const id = $('midiInput').value;
  midiInput = id ? midiAccess.inputs.get(id) : null;
  if (midiInput) midiInput.onmidimessage = onMidiMessage;
  maybeAutoRead();
}

// Pull the unit's current Temporary Patch the first time we have both an
// output and an input, so the editor starts from what the hardware holds
// instead of the seeded defaults.
function maybeAutoRead() {
  if (autoReadDone || !midiOutput || !midiInput) return;
  autoReadDone = true;
  requestPatch();
}

/* ============================ Incoming SysEx (RQ1 reply) ============================ */
function requestPatch() {
  if (!midiOutput) { setStatus('Select a MIDI output first.', 'err'); return; }
  if (!midiInput) { setStatus('Select a MIDI input to read the patch back.', 'err'); return; }
  pendingRead = true;
  const msg = buildRQ1(EF303.ADDR.TEMP_PATCH, EF303.ADDR.PATCH_SIZE);
  queueSend('rq1', msg, `RQ1 ${hexBytes(msg)}   (request ${EF303.ADDR.PATCH_SIZE} bytes)`);
  setStatus('Requested current patch from EF-303…');
  setTimeout(() => {
    if (pendingRead) {
      pendingRead = false;
      setStatus('No reply to patch request — check MIDI IN, Device ID and that the unit\'s ' +
                'Rx Sys-Ex is ON. The editor is showing its own defaults.', 'err');
    }
  }, 2000);
}

function onMidiMessage(e) {
  const d = e.data;
  if (d[0] !== 0xf0) return;                              // SysEx only
  const { ROLAND, MODEL_HI, MODEL_LO, DT1 } = EF303.SYSEX;
  if (d[1] !== ROLAND || d[3] !== MODEL_HI || d[4] !== MODEL_LO) return; // not EF-303
  if (d[5] !== DT1) return;                               // we only parse DT1 replies
  if (d.length < 12) return;                              // too short to hold addr+sum+F7

  const addr = [d[6], d[7], d[8], d[9]];
  const data = Array.from(d.slice(10, d.length - 2));     // strip checksum + F7
  log(`RX  ${hexBytes(d)}`);

  // Verify the Roland checksum before trusting the payload.
  const expect = rolandChecksum(addr.concat(data));
  if (d[d.length - 2] !== expect) {
    log(`RX  bad checksum (got ${hex(d[d.length - 2])}, expected ${hex(expect)}) — ignored`);
    return;
  }

  // Only the Temporary Patch block (base 01 00 xx xx) maps onto our mirror.
  // Replies for System (00 ..) or User Patches (02 ..) are ignored.
  const base = EF303.ADDR.TEMP_PATCH;
  if (addr[0] !== base[0] || addr[1] !== base[1]) {
    log(`RX  address ${hexBytes(addr)} is outside the Temporary Patch — ignored`);
    return;
  }
  const offset = ((addr[2] - base[2]) * 128) + (addr[3] - base[3]);
  if (offset < 0 || offset >= EF303.ADDR.PATCH_SIZE) return;
  for (let i = 0; i < data.length && offset + i < patch.length; i++) {
    patch[offset + i] = data[i] & 0x7f;
  }
  // A 150-byte patch arrives as two packets (128 + 22); re-render on each.
  pendingRead = false;
  currentEffectId = Math.min(patch[0], EF303.EFFECTS.length - 1);
  $('effectType').value = currentEffectId;
  renderAll();
  setStatus('Patch received and loaded into the editor.', 'ok');
}

/* ============================ UI rendering ============================ */

// Display string for a descriptor's raw value.
function formatValue(def, v) {
  if (def.disp) return def.disp(v);
  return v + (def.unit ? ' ' + def.unit : '');
}

// One labelled control (slider for ranges, dropdown for enums).
// Enum descriptors may carry `values`, mapping option index -> raw byte, for
// non-contiguous ranges such as the valid CC numbers.
function controlFor(def, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'param';

  const head = document.createElement('div');
  head.className = 'param-head';
  const name = document.createElement('span');
  name.className = 'param-name';
  name.textContent = def.name;
  if (def.cc != null) name.title = `CC${def.cc} in MODE2`;
  const val = document.createElement('span');
  val.className = 'param-val';
  head.append(name, val);
  wrap.append(head);

  if (def.type === 'enum') {
    const sel = document.createElement('select');
    def.options.forEach((o, i) => sel.add(new Option(o, def.values ? def.values[i] : i)));
    let idx = def.values ? def.values.indexOf(value) : value;
    if (idx < 0 || idx >= def.options.length) idx = 0;   // out-of-range byte: show first option
    sel.selectedIndex = idx;
    val.textContent = def.options[idx];
    sel.addEventListener('change', () => {
      val.textContent = def.options[sel.selectedIndex];
      onChange(parseInt(sel.value));
    });
    wrap.append(sel);
  } else {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = def.min; slider.max = def.max; slider.value = value;
    val.textContent = formatValue(def, value);
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value);
      val.textContent = formatValue(def, v);
      onChange(v);
    });
    wrap.append(slider);
  }
  return wrap;
}

/* ---- layout helpers ---- */

// A titled sub-group containing a param grid of `nodes`.
function group(title, nodes, gridClass = 'param-grid') {
  const g = document.createElement('div');
  g.className = 'group';
  if (title) {
    const h = document.createElement('div');
    h.className = 'group-title';
    h.textContent = title;
    g.append(h);
  }
  const grid = document.createElement('div');
  grid.className = gridClass;
  grid.append(...nodes);
  g.append(grid);
  return g;
}

// Standard control bound to a patch offset.
function paramControl(def) {
  return controlFor(def, patch[def.off], v => writeParam(def.off, v));
}

// Add a small caption (e.g. the panel knob name) under a control's name.
function tagControl(node, text) {
  const tag = document.createElement('span');
  tag.className = 'param-tag';
  tag.textContent = text;
  node.querySelector('.param-name').append(tag);
  return node;
}

// Which parameter panel knob C1..C4 (index 0..3) drives for the current
// effect, following the Effects Parameter Chart (p.70): RATE/LOW depends on
// the patch's BPM Sync state, CUTOFF/MID may change when [CTRL SEL] is on.
// Returns the descriptor, or null if the knob is inactive in that state.
function knobTarget(knobIndex, { ctrlSel = false } = {}) {
  const eff = EF303.EFFECTS[currentEffectId];
  const alt = EF303.KNOB_ALT[eff.id] || {};
  let off = EF303.PANEL_KNOBS[knobIndex].off;
  if (knobIndex === 0) {
    const syncOn = patch[0x4b] === 1;
    if (syncOn && 'bpmSyncOn' in alt) off = alt.bpmSyncOn;
    if (!syncOn && 'bpmSyncOff' in alt) off = alt.bpmSyncOff;
  } else if (knobIndex === 1 && ctrlSel && 'ctrlSelOn' in alt) {
    off = alt.ctrlSelOn;
  }
  if (off == null) return null;
  return eff.params.find(p => p.off === off) || null;
}

// Caption for a parameter that has no knob of its own: say which knob reaches
// it and in which state, per the p.70 chart.
function extraCaption(eff, p) {
  const alt = EF303.KNOB_ALT[eff.id] || {};
  if (p.off === 32) return 'FREQ RANGE';
  if (alt.bpmSyncOn === p.off) return 'RATE/LOW · with BPM Sync on';
  if (alt.ctrlSelOn === p.off) return 'CUTOFF/MID · with Ctrl Sel on';
  return 'no panel knob';
}

/* ---- Effect: laid out like the front panel ---- */
function renderEffectParams() {
  const eff = EF303.EFFECTS[currentEffectId];
  const root = $('effectParams');
  root.innerHTML = '';
  const byOff = Object.fromEntries(eff.params.map(p => [p.off, p]));

  // Row 1: the four knobs in panel order (prm2, prm3, prm4, prm1), so Effect
  // Balance is rightmost like on the unit.
  const knobs = EF303.PANEL_KNOBS
    .filter(k => byOff[k.off])
    .map(k => tagControl(paramControl(byOff[k.off]), k.label));
  root.append(group('Knobs', knobs, 'knob-row'));

  // Row 2: parameters without a knob of their own (prm6 / prm7), then the
  // buttons beside the knobs: FREQ RANGE (prm32), SYNC TYPE and BPM SYNC.
  const knobOffs = new Set(EF303.PANEL_KNOBS.map(k => k.off));
  const extras = eff.params.filter(p => !knobOffs.has(p.off) && !EF303.SYNTH_OFFSETS.has(p.off));
  const second = [
    ...extras.map(p => tagControl(paramControl(p), extraCaption(eff, p))),
    ...EF303.SYNC.map(p => tagControl(paramControl(p), p.name.toUpperCase()))
  ];
  root.append(group('Buttons & extras', second));

  $('effectBadge').textContent = (eff.synth ? '🎹 ' : '') + eff.name;
  renderSynth(eff);
}

/* ---- Synth: only for Syn+Dly / Syn Bass ---- */
function renderSynth(eff) {
  const section = $('synthSection');
  const root = $('synthParams');
  root.innerHTML = '';
  section.hidden = !eff.synth;
  if (!eff.synth) return;
  EF303.SYNTH_GROUPS.forEach(g => root.append(group(g.title, g.params.map(paramControl))));
  root.append(group('Keyboard & Scale', EF303.KEYBOARD.map(paramControl)));
}

/* ---- Tempo ---- */
function renderTempo() {
  const grid = $('tempoParams');
  grid.innerHTML = '';

  // Master Tempo (special 2-byte fixed-point).
  const wrap = document.createElement('div');
  wrap.className = 'param';
  const head = document.createElement('div'); head.className = 'param-head';
  head.innerHTML = '<span class="param-name">Master Tempo</span><span class="param-val"></span>';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = 40; slider.max = 240; slider.step = 0.1;
  slider.value = readMasterTempo() || 120;
  const show = () => head.querySelector('.param-val').textContent = (+slider.value).toFixed(1) + ' BPM';
  show();
  slider.addEventListener('input', () => { show(); writeMasterTempo(+slider.value); });
  wrap.append(head, slider);
  grid.append(wrap);
}

/* ---- Control knobs: what the physical knobs send over MIDI ---- */
function renderKnobs() {
  const root = $('knobParams');
  root.innerHTML = '';

  const card = (k, caption) => {
    const c = document.createElement('div');
    c.className = 'knob-card';
    const title = document.createElement('h4');
    title.textContent = k.label + (caption ? ' · ' + caption : '');
    c.append(title);

    // Assign target: OFF or MFX Param 1-40.
    const assignDef = { type: 'enum', name: 'Target',
      options: ['OFF', ...Array.from({ length: 40 }, (_, i) => 'MFX Prm ' + (i + 1))] };
    c.append(controlFor(assignDef, patch[k.assignOff], v => writeParam(k.assignOff, v)));
    // CC number — restricted to the values the unit accepts.
    c.append(paramControl(EF303._cc(k.ccOff, 'CC Number')));
    // Output routing (INT / EXT / BOTH).
    c.append(paramControl(EF303._enm(k.modeOff, 'Output', EF303.ENUM.OUTPUT_MODE)));
    return c;
  };

  // C1-C4 are the four panel knobs; the SysEx map has room for C5-C8 but the
  // panel exposes no settings for them, so they live behind a disclosure.
  const panel = EF303.KNOBS.slice(0, 4).map((k, i) => card(k, EF303.PANEL_KNOBS[i].label));
  root.append(group('Panel knobs C1–C4', panel, 'knob-grid'));

  const details = document.createElement('details');
  details.className = 'extra';
  const summary = document.createElement('summary');
  summary.textContent = 'C5–C8 (in the SysEx map, not on the panel)';
  details.append(summary, group('', EF303.KNOBS.slice(4).map(k => card(k)), 'knob-grid'));
  root.append(details);
}

/* ---- Step modulator ---- */

// Destination / Ctrl Select pick a knob (C1..C4); label each with the
// parameter that knob actually modulates for the current effect.
function knobChoiceDef(def) {
  const options = def.options.map((o, i) => {
    if (i === 0) return o;                                  // OFF
    const p = knobTarget(i - 1, { ctrlSel: true });
    const knob = EF303.PANEL_KNOBS[i - 1].label;
    return `${o} · ${p ? p.name : '(inactive)'}  —  ${knob}`;
  });
  return { ...def, options };
}

function renderStepModConfig() {
  const SM = EF303.STEPMOD;
  const cfg = $('smConfig');
  cfg.innerHTML = '';
  const withKnobNames = p => (p.options === EF303.ENUM.SM_DEST || p.options === EF303.ENUM.CTRL_SELECT)
    ? knobChoiceDef(p) : p;
  cfg.append(group('Playback', SM.playback.map(paramControl)));
  cfg.append(group('Routing', SM.routing.map(p => paramControl(withKnobNames(p)))));
}

function renderStepGrid() {
  const SM = EF303.STEPMOD;
  const grid = $('stepGrid');
  grid.innerHTML = '';

  // Tag + slider + numeric readout for one per-step parameter.
  const stepRow = (tag, off, max, unit, cls) => {
    const lbl = document.createElement('div');
    lbl.className = 'step-tag'; lbl.textContent = tag;
    const s = document.createElement('input');
    s.type = 'range'; s.min = 0; s.max = max; s.value = patch[off];
    s.title = tag;
    if (cls) s.className = cls;
    const ro = document.createElement('div');
    ro.className = 'step-readout'; ro.textContent = patch[off] + unit;
    s.addEventListener('input', () => {
      ro.textContent = s.value + unit;
      writeParam(off, parseInt(s.value));
    });
    return [lbl, s, ro];
  };

  for (let i = 0; i < 16; i++) {
    const col = document.createElement('div');
    col.className = 'step-col';
    const n = document.createElement('div');
    n.className = 'step-num';
    n.textContent = i + 1;
    col.append(n);

    // Status (NORMAL/TIE/SLIDE/REST) — drives column colour.
    const statusOff = SM.statusBase + i;
    const status = document.createElement('select');
    EF303.ENUM.STEP_STATUS.forEach((o, idx) => status.add(new Option(o, idx)));
    status.value = patch[statusOff];
    const applyStatusClass = () =>
      col.dataset.status = (EF303.ENUM.STEP_STATUS[patch[statusOff]] || 'normal').toLowerCase();
    applyStatusClass();
    status.addEventListener('change', () => {
      writeParam(statusOff, parseInt(status.value));
      applyStatusClass();
    });

    col.append(
      ...stepRow('val',  SM.valueBase + i,    127, '',  'v-slider'),  // Step Value 0-127
      ...stepRow('gate', SM.gateBase + i,     105, '%'),              // Gate Time 0-105 %
      ...stepRow('vel',  SM.velocityBase + i, 127, ''),               // Velocity 0-127
      status);
    grid.append(col);
  }
}

function renderStepMod() {
  renderStepModConfig();
  renderStepGrid();
}

function renderAll() {
  renderEffectParams();   // also renders the synth section
  renderTempo();
  renderStepMod();
  renderKnobs();
}

/* ============================ Bulk send ============================ */
// Push every byte the editor currently holds to the Temporary Patch, so the
// unit matches the editor exactly. The manual asks for packets of at most 128
// bytes with >= 20 ms between them; the send queue handles the pacing.
function sendWholePatch() {
  if (!midiOutput) { setStatus('Select a MIDI output first.', 'err'); return; }
  const CHUNK = 128;
  let packets = 0;
  for (let off = 0; off < patch.length; off += CHUNK) {
    const data = Array.from(patch.slice(off, off + CHUNK));
    const addr = addAddress(EF303.ADDR.TEMP_PATCH, off);
    const msg = buildDT1(addr, data);
    queueSend('bulk:' + off, msg,
      `DT1 bulk ${data.length} bytes @ off ${off}: ${hexBytes(msg)}`);
    packets++;
  }
  setStatus(`Sending the full patch (${patch.length} bytes in ${packets} packets) to the EF-303 Temporary Patch.`, 'ok');
}

/* ============================ Init ============================ */
function setEffect(id) {
  currentEffectId = id;
  writeEffectType(id);
  renderEffectParams();
  renderStepModConfig();   // destination labels depend on the effect
}

function seedDefaults() {
  // A few musical defaults so sliders don't all sit at 0 on first load.
  // These are replaced by the unit's real values once a patch is read back.
  patch[0] = currentEffectId;
  patch[1] = 100;                                              // Effect Balance (shared offset)
  patch[0x43] = (1200 >> 7) & 0x7f; patch[0x44] = 1200 & 0x7f; // 120.0 BPM
  patch[0x4f] = 15;                                            // End Step = 16
  patch[0x53] = 16;                                            // SM CC Assign
  for (let i = 0; i < 16; i++) {
    patch[EF303.STEPMOD.gateBase + i] = 50;
    patch[EF303.STEPMOD.valueBase + i] = 64;
    patch[EF303.STEPMOD.velocityBase + i] = 100;
  }
  // Default knob CCs to valid, distinct numbers.
  EF303.KNOBS.forEach((k, i) => { if (!patch[k.ccOff]) patch[k.ccOff] = 16 + i; });
}

function setupEvents() {
  $('connectBtn').addEventListener('click', connectMidi);
  $('midiOutput').addEventListener('change', selectOutput);
  $('midiInput').addEventListener('change', selectInput);
  $('effectType').addEventListener('change', () => setEffect(parseInt($('effectType').value)));
  $('readBtn').addEventListener('click', requestPatch);
  $('sendAllBtn').addEventListener('click', sendWholePatch);
  document.querySelectorAll('input[name="writeMode"]').forEach(r =>
    r.addEventListener('change', () => { writeMode = r.value; }));
}

document.addEventListener('DOMContentLoaded', () => {
  // Populate the effect-type dropdown from the data model.
  const sel = $('effectType');
  EF303.EFFECTS.forEach(e => sel.add(new Option(`${e.id} — ${e.name}`, e.id)));
  sel.value = currentEffectId;

  seedDefaults();
  setupEvents();
  renderAll();
  connectMidi();
});
