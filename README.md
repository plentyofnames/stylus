# EF-303 Editor

A browser-based **Web MIDI editor for the Roland EF-303 Groove Effects**. Pick
an effect, tweak its parameters, program the 16-step modulator, and assign the
C1–C8 control knobs — all sent to the unit live over MIDI as Roland System
Exclusive (or Control Change). No install, no build step: open `index.html` in
a Web-MIDI-capable browser (Chrome or Edge).

Built as a companion to the [Lexicon Reflex "Reflex Hammer"](../Lexicon%20Reflex%20Editor)
editor, in the same vanilla-JS + Web MIDI style.

## Usage

1. Connect the EF-303's MIDI IN (and optionally OUT) to your interface.
2. Open `index.html` in Chrome/Edge and click **Connect MIDI** (grant SysEx).
3. Select the MIDI **Output**, **Input**, **Channel**, and **Device ID**
   (default `0x10`) to match the unit.
4. Choose a **Multi-FX** type and edit. Changes are sent immediately to the
   **Temporary Patch**, so you hear them in real time.
5. The editor reads the current Temporary Patch automatically once an input
   and output are selected. **Read patch from EF-303** does it again on demand
   (requires MIDI input). **Send whole patch** pushes the editor's full state
   to the unit.
6. To keep an edit, use the EF-303's front-panel **STORE** to save the
   Temporary Patch into one of its user patches. *(This editor deliberately
   does not overwrite stored patches.)*

### Write modes
- **SysEx** (default) — precise single-parameter `DT1` writes; covers every
  parameter including the step modulator.
- **CC (MODE2)** — sends Control Change for the synth parameters that have a CC
  mapping (requires the unit's *Receive Control Change* set to MODE2). Falls
  back to SysEx for parameters with no CC.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell / layout |
| `styles.css` | Theme |
| `ef303-data.js` | The EF-303 MIDI data model: SysEx constants, 150-byte patch address map, all 16 effect parameter tables, synth voice block, step-modulator layout, knob assigns, and enums — transcribed from the manual |
| `app.js` | Web MIDI, Roland DT1/RQ1 framing + checksum, 7-bit address math, patch read/parse, and UI rendering |
| `docs/reference/` | Local, not committed: drop the official Owner's Manual PDF here for reference (MIDI Implementation is pp. 71–79). It is Roland's copyright and is not redistributed with this repo |

## MIDI implementation notes

- **Message framing:** `F0 41 <dev> 00 33 <cmd> <addr×4> <data…> <checksum> F7`
  where `cmd` is `12` (DT1, write) or `11` (RQ1, read). Model ID is `00 33`.
- **Checksum:** Roland one's-complement — the value that makes
  `(sum of address + data)` a multiple of 128.
- **Patch layout:** 150 single-byte parameters. Addresses are 7-bit-per-byte;
  expressed as `hi*128 + lo` the patch is contiguous offsets 0–149 (MFX type,
  40 MFX params, C1–C8 assigns, system/sync, step-modulator config, and the
  per-step gate/value/status/velocity arrays).
- **Master Tempo** is a two-byte fixed-point value: `(H*128 + L) / 10` BPM.
- **Pacing:** all outgoing messages go through a queue that keeps at least
  20 ms between packets (the manual's minimum for successive DT1s) and
  coalesces rapid edits to the same parameter, so a slider drag sends only the
  latest value. Bulk sends use two packets of ≤128 bytes as the manual asks.
- **CC assigns** (C1–C8 and the step modulator) only accept CC 2–5, 7–31 and
  64–95, so they are offered as dropdowns rather than free sliders.

Spec transcribed from the official EF-303 Owner's Manual, MIDI Implementation
v1.00 (Jul 26 2000). Not affiliated with or endorsed by Roland.
