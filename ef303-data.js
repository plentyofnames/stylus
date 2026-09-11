/*
 * ef303-data.js — Roland EF-303 Groove Effects MIDI data model
 *
 * Transcribed from the official EF-303 Owner's Manual, "MIDI Implementation"
 * section (pp. 71-79, spec dated Jul 26 2000, version 1.00). The manual is
 * Roland's copyright and is not included in this repo; keep a local copy in
 * docs/reference/ (git-ignored) if you want it next to the code.
 *
 * The patch is a flat block of 150 single-byte parameters. Each parameter sits
 * at a contiguous integer offset 0..149 from the patch base address. Roland
 * addresses are 7-bit-per-byte; because every byte here fits in 7 bits, the
 * map happens to be perfectly contiguous when expressed as hi*128 + lo, which
 * is what `off` holds below. addAddress() in app.js converts back to bytes.
 */

const EF303 = (() => {
  // ---- SysEx framing constants (manual p.71-72) ------------------------------
  const SYSEX = {
    ROLAND: 0x41,        // Manufacturer ID
    MODEL_HI: 0x00,      // Model ID byte 1
    MODEL_LO: 0x33,      // Model ID byte 2  (EF-303)
    DT1: 0x12,           // Data Set 1 (write)
    RQ1: 0x11,           // Data Request 1 (read)
    DEFAULT_DEVICE: 0x10 // Device ID, range 0x10-0x1F (unit 17 default)
  };

  // ---- Base addresses (System Exclusive Map, p.73) ---------------------------
  // Patch edits target the Temporary Patch so they sound immediately; the unit
  // can then STORE that into one of the user patches from its front panel.
  const ADDR = {
    SYSTEM: [0x00, 0x00, 0x00, 0x00],
    TEMP_PATCH: [0x01, 0x00, 0x00, 0x00],
    // User patches: 02 00 00 00 (Bank1-1) .. 02 0F 00 00 (Bank4-1), 16 slots.
    userPatch(index /* 0..15 */) { return [0x02, index & 0x7f, 0x00, 0x00]; },
    PATCH_SIZE: 150 // 0x00000116 in 7-bit address space
  };

  // ---- Enumerations (DISP columns, pp.73-78) ---------------------------------
  const ENUM = {
    FREQ_RANGE: ['HIGH', 'MID', 'LOW', 'FULL'],
    ROBOT: ['NORMAL', 'ROBOT'],
    VO_MOD_MODE: ['INTERNAL', 'EXTERNAL'],
    DRUM_KIT: ['DRUM A', 'DRUM B', 'DRUM C', 'DRUM D'],
    OUTPUT_MODE: ['OFF', 'INTERNAL', 'EXTERNAL', 'BOTH'],
    CTRL_SELECT: ['OFF', 'C1', 'C2', 'C3', 'C4'],
    SM_DEST: ['OFF', 'C1', 'C2', 'C3', 'C4'],
    PLAY_MODE: ['REPEAT', 'SINGLE', '1STEP'],
    DIRECTION: ['FORWARD', 'BACKWARD', 'ALTERNATE1', 'ALTERNATE2', 'RANDOM'],
    SM_OUT_MSG: ['CONTROL CHANGE', 'NOTE'],
    STEP_STATUS: ['NORMAL', 'TIE', 'SLIDE', 'REST'],
    ON_OFF: ['OFF', 'ON'],
    SYNTH_KEY: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
    // Note resolutions for Sync Note / SM Step Time (manual list, 0-11).
    // "o" = whole note; ox2/ox4 = 2 and 4 whole-note bars.
    NOTE_RES: ['1/16', '1/16.', '1/8', '1/8.', '1/4', '1/2',
               '1/1', '2/1', '4/1', '1/16T', '1/8T', '1/4T'],
    // Slider Scale (0-20).
    SLIDER_SCALE: ['CHR', 'TCH', 'SPN', 'BLS', 'CD', 'MAJ', 'MIN', 'HMJ', 'HMI',
                   'DH', 'MMI', 'GPS', 'DOM', 'WT', 'BEL', 'AUG', 'RKY', 'ISD',
                   'ISA', 'PHJ', 'PHI']
  };

  // Helper constructors for parameter descriptors. `off` is the integer patch
  // offset (== Multi-FX Parameter number for effect params). `cc`, if present,
  // is the Control Change number that controls the same parameter in the unit's
  // "Receive Control Change = MODE2" mode (Receive Setting Chart, p.78).
  // `disp`, if present, formats the raw value for display (e.g. End Step is
  // stored 0-15 but shown 1-16 on the unit).
  const rng = (off, name, opts = {}) =>
    ({ off, name, type: 'range', min: opts.min ?? 0, max: opts.max ?? 127,
       unit: opts.unit || '', cc: opts.cc, disp: opts.disp });
  const enm = (off, name, options, opts = {}) =>
    ({ off, name, type: 'enum', options, min: 0, max: options.length - 1, cc: opts.cc });

  // Valid Control Change numbers for the C1-C8 and step-modulator CC assigns
  // (p.74: "CC02 - CC05, CC07 - CC31, CC64 - CC95"). CC06 and CC32-CC63 are
  // not accepted, so these are rendered as a dropdown rather than a slider.
  // `values` maps each option index to the actual byte written to the patch.
  const span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const VALID_CC = [...span(2, 5), ...span(7, 31), ...span(64, 95)];
  const ccs = (off, name) =>
    ({ off, name, type: 'enum', options: VALID_CC.map(n => 'CC ' + n),
       values: VALID_CC, min: 2, max: 95 });

  // ---- Shared synth voice block (EFFECT 13 Syn+Dly & 14 Syn Bass, p.77) ------
  // prm11..prm29. CC numbers from the Receive Setting Chart (MODE2).
  const SYNTH_BLOCK = [
    rng(11, 'Amp Env Attack',   { cc: 73 }),
    rng(12, 'Amp Env Decay',    { cc: 75 }),
    rng(13, 'Amp Env Sustain',  { cc: 31 }),
    rng(14, 'Amp Env Release',  { cc: 72 }),
    rng(15, 'Amp Env Depth'),
    rng(16, 'Amp Env Velocity'),
    rng(17, 'Filter Env Attack',  { cc: 82 }),
    rng(18, 'Filter Env Decay',   { cc: 83 }),
    rng(19, 'Filter Env Sustain', { cc: 28 }),
    rng(20, 'Filter Env Release', { cc: 29 }),
    rng(21, 'Filter Env Depth',   { cc: 81 }),
    rng(22, 'Filter Env Velocity'),
    rng(23, 'Portamento Time', { cc: 5 }),
    rng(24, 'LFO Rate',        { cc: 16 }),
    rng(25, 'OSC LFO Depth',   { cc: 1 }),
    rng(26, 'LFO Delay Time'),
    rng(27, 'Portamento Sw',   { cc: 65 }),
    rng(28, 'OSC Wave'),
    rng(29, 'Filter Curve')
  ];
  // The same block, split the way the UI presents it.
  const SYNTH_GROUPS = [
    { title: 'Amp Envelope',                  params: SYNTH_BLOCK.slice(0, 6) },
    { title: 'Filter Envelope',               params: SYNTH_BLOCK.slice(6, 12) },
    { title: 'Oscillator, LFO & Portamento',  params: SYNTH_BLOCK.slice(12) }
  ];
  const SYNTH_OFFSETS = new Set(SYNTH_BLOCK.map(p => p.off));

  // Front-panel knob that drives each of the four main effect parameters
  // (prm1-4), in the order they sit on the panel (p.9 / p.70).
  const PANEL_KNOBS = [
    { off: 2, label: 'RATE/LOW' },
    { off: 3, label: 'CUTOFF/MID' },
    { off: 4, label: 'RESO/HIGH' },
    { off: 1, label: 'EFFECT BAL' }
  ];

  // ---- The 16 Multi-FX types and their parameters (p.76-77) ------------------
  const EFFECTS = [
    { id: 0,  name: 'Filter', params: [
        rng(1, 'Effect Balance'), rng(2, 'Rate'), rng(3, 'Cutoff'),
        rng(4, 'Resonance'), rng(6, 'Depth'),
        enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 1,  name: 'Isolator', params: [
        rng(1, 'Effect Balance'), rng(2, 'Low'), rng(3, 'Mid'), rng(4, 'High') ] },
    { id: 2,  name: 'Flanger', params: [
        rng(1, 'Effect Balance'), rng(2, 'Rate'), rng(3, 'Depth'),
        rng(4, 'Resonance'), rng(7, 'Delay Time'),
        enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 3,  name: 'Delay+Pan', params: [
        rng(1, 'Effect Balance'), rng(2, 'Delay Time'), rng(3, 'Pan'),
        rng(4, 'Feedback'), enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 4,  name: 'Reverb', params: [
        rng(1, 'Effect Balance'), rng(2, 'Reverb Time'), rng(3, 'Pan'),
        rng(4, 'Threshold'), enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 5,  name: 'Pitch+Dly', params: [
        rng(1, 'Effect Balance'), rng(2, 'Delay Time'), rng(3, 'Pan'),
        rng(4, 'Pitch'), rng(6, 'Feedback'),
        enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 6,  name: 'Slicer+Pan', params: [
        rng(1, 'Effect Balance'), rng(2, 'Slice Rate'), rng(3, 'Pan'),
        rng(4, 'Slice Level'), enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 7,  name: 'Comp', params: [
        rng(1, 'Effect Balance'), rng(2, 'Attack'), rng(3, 'Release'),
        rng(4, 'Threshold'), enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 8,  name: 'Lo-fi', params: [
        rng(1, 'Effect Balance'), rng(2, 'Drive'), rng(3, 'Sample Rate'),
        rng(4, 'Bit Resolution'), enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 9,  name: 'Ring Mod', params: [
        rng(1, 'Effect Balance'), rng(2, 'Rate'), rng(3, 'Cutoff'),
        rng(4, 'Frequency'), rng(6, 'Depth'),
        enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 10, name: 'Phaser', params: [
        rng(1, 'Effect Balance'), rng(2, 'Rate'), rng(3, 'Depth'),
        rng(4, 'Resonance'), rng(7, 'Center Freq'),
        enm(32, 'Freq Range', ENUM.FREQ_RANGE) ] },
    { id: 11, name: 'Voice', params: [
        rng(1, 'Effect Balance'), rng(2, 'Reverb Level'), rng(3, 'Formant'),
        rng(4, 'Pitch'), enm(32, 'Robot', ENUM.ROBOT) ] },
    { id: 12, name: 'Vo Mod', params: [
        rng(1, 'Effect Balance'), rng(2, 'Reverb Level'),
        rng(3, 'OSC / L-ch Level'), rng(4, 'MIC / R-ch Level'),
        rng(6, 'Feedback'), enm(32, 'Mode', ENUM.VO_MOD_MODE) ] },
    { id: 13, name: 'Syn+Dly', synth: true, params: [
        rng(1, 'Effect Balance'), rng(2, 'Delay Time'), rng(3, 'Cutoff'),
        rng(4, 'Resonance'), rng(6, 'Feedback'), ...SYNTH_BLOCK ] },
    { id: 14, name: 'Syn Bass', synth: true, params: [
        rng(1, 'Effect Balance'), rng(2, 'Drive'), rng(3, 'Cutoff'),
        rng(4, 'Resonance'), ...SYNTH_BLOCK ] },
    { id: 15, name: 'Syn Rhythm', params: [
        rng(1, 'Effect Balance'), rng(2, 'Reverb Level'), rng(3, 'Snare Level'),
        rng(4, 'HH Level'), enm(32, 'Drum Kit', ENUM.DRUM_KIT) ] }
  ];

  // ---- Effects Parameter Chart (p.70) ----------------------------------------
  // The RATE/LOW knob switches to a different parameter when [BPM SYNC] is on
  // (the rate then comes from SYNC TYPE), and CUTOFF/MID switches when
  // [CTRL SEL] is on for some effects. Keyed by effect id; values are patch
  // offsets, null = the knob does nothing in that state, absent = unchanged.
  const KNOB_ALT = {
    0:  { bpmSyncOn: 6 },                 // Filter:     RATE/LOW -> Depth
    1:  { bpmSyncOn: null },              // Isolator:   RATE/LOW inactive
    2:  { bpmSyncOn: 3, ctrlSelOn: 7 },   // Flanger:    RATE/LOW -> Depth, CUTOFF/MID -> Delay Time
    3:  { bpmSyncOn: null },              // Delay+Pan
    4:  { bpmSyncOn: null },              // Reverb
    5:  { bpmSyncOn: 6 },                 // Pitch+Dly:  RATE/LOW -> Feedback
    6:  { bpmSyncOn: null },              // Slicer+Pan
    9:  { bpmSyncOn: 6 },                 // Ring Mod:   RATE/LOW -> Depth
    10: { bpmSyncOn: 3, ctrlSelOn: 7 },   // Phaser:     RATE/LOW -> Depth, CUTOFF/MID -> Center Freq
    13: { bpmSyncOff: null, bpmSyncOn: 6 }, // Syn+Dly:  RATE/LOW is Feedback, only with BPM Sync on
    14: { bpmSyncOn: null }               // Syn Bass:   RATE/LOW inactive with BPM Sync on
  };

  // ---- Global / system parameters within a patch (pp.73-74) ------------------
  // Master Tempo spans two bytes (H 0x43, L 0x44): tempo = (H*128 + L) / 10,
  // range 40.0-240.0 BPM. Handled specially in app.js.
  // Which physical knob the [CTRL SEL] button has selected for the step
  // modulator / slider to act on.
  const CTRL_SELECT = enm(0x42, 'Ctrl Select', ENUM.CTRL_SELECT);
  // The two panel buttons next to the knobs: [SYNC TYPE] (called "Sync Note"
  // in the SysEx map) and [BPM SYNC].
  const SYNC = [
    enm(0x4a, 'Sync Type', ENUM.NOTE_RES),
    enm(0x4b, 'BPM Sync', ENUM.ON_OFF)
  ];
  // Keyboard / scale settings that only matter for the synth algorithms
  // (System settings, pp.52-53; stored per patch).
  const KEYBOARD = [
    enm(0x47, 'Synth Key', ENUM.SYNTH_KEY),
    enm(0x48, 'Slider Scale', ENUM.SLIDER_SCALE),
    enm(0x49, 'Key Scale Active', ENUM.ON_OFF),
    rng(0x45, 'Slider Range Min'),
    rng(0x46, 'Slider Range Max')
  ];
  // Everything above, flat, for offset lookups.
  const GLOBAL = [CTRL_SELECT, ...KEYBOARD, ...SYNC];

  // C1..C8 assignable controllers: each has a target (0=OFF, 1-40 = MFX Param),
  // a CC number (2-95) and an output routing mode.
  const KNOBS = [];
  for (let i = 0; i < 8; i++) {
    KNOBS.push({
      label: 'C' + (i + 1),
      assignOff: 0x2a + i,             // 0=OFF, 1-40 = MFX_PRM1..40
      ccOff: 0x32 + i * 2,             // CC assign (2-95)
      modeOff: 0x33 + i * 2            // output mode enum
    });
  }

  // ---- Step modulator (16-step sequencer, pp.74-75) --------------------------
  const SM_PLAYBACK = [
    enm(0x4d, 'Play Mode', ENUM.PLAY_MODE),
    enm(0x4e, 'Direction', ENUM.DIRECTION),
    rng(0x4f, 'End Step', { min: 0, max: 15, disp: v => String(v + 1) }), // shown 1-16
    enm(0x50, 'Step Time', ENUM.NOTE_RES),
    enm(0x51, 'Smooth', ENUM.ON_OFF)
  ];
  const SM_ROUTING = [
    enm(0x4c, 'Destination', ENUM.SM_DEST),
    CTRL_SELECT,
    enm(0x52, 'Out Message', ENUM.SM_OUT_MSG),
    ccs(0x53, 'CC Assign'),                        // slider "S-n": CC sent when Out Message = CONTROL CHANGE
    enm(0x54, 'Output Mode', ENUM.OUTPUT_MODE)     // slider destination: INT / EXT / BOTH
  ];
  const STEPMOD = {
    playback: SM_PLAYBACK,
    routing: SM_ROUTING,
    config: [...SM_PLAYBACK, ...SM_ROUTING],      // flat, for offset lookups
    // Per-step arrays, 16 steps each.
    // Bases are INTEGER offsets (hi*128 + lo), kept contiguous on purpose.
    gateBase:     0x56, // S1..S16 Gate Time   (0-105 %)   addr 00 56..00 65
    valueBase:    0x66, // S1..S16 Step Value  (0-127)     addr 00 66..00 75
    statusBase:   0x76, // S1..S16 Step Status (enum, 4)   addr 00 76..01 05
    velocityBase: 134   // S1..S16 Velocity    (0-127)     addr 01 06..01 15
  };

  return { SYSEX, ADDR, ENUM, EFFECTS, GLOBAL, KNOBS, STEPMOD, VALID_CC,
           SYNTH_GROUPS, SYNTH_OFFSETS, PANEL_KNOBS, KNOB_ALT, CTRL_SELECT, SYNC, KEYBOARD,
           // expose builders for any UI-side needs
           _rng: rng, _enm: enm, _cc: ccs };
})();

// Make available as a module too, in case anything imports it.
if (typeof module !== 'undefined' && module.exports) module.exports = EF303;
