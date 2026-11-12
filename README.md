# BVR COMMAND — Beyond-Visual-Range Air Combat Command v0.7.1

A pure static, zero-dependency beyond-visual-range (BVR) air combat simulation/replay. The interface mimics the DCS F10 global view: light-colored map, fine white grid, magenta Bullseye, top-down silhouettes drawn per aircraft type, labels showing "FL altitude + Mach". You sit in an AWACS and command your friendly force; when you don't intervene, aircraft engage autonomously.

The focus of v0.2: **You can also be shot down** — both AWACS and tankers are huntable targets, so the engagement depth extends to the 300 km level; at the same time, pre-battle force composition, loadouts, tankers, simultaneous multi-aircraft command, and real-time missile visualization were added.

The focus of v0.3: **Information is no longer omniscient** — radar contacts are drawn in three styles based on confidence: "confirmed / fuzzy / memory", and missiles are not immediately visible to the opponent after launch; meanwhile, each fighter has its own aerodynamic silhouette, suppression/main-attack tactical roles, more pronounced vertical maneuvers, and selecting an aircraft shows its radar circle and datalink.

The focus of v0.5: **Tactical roles are dynamic, and evasion is three-dimensional** — aircraft are no longer fixed in function by empty weight, but instead look at whether they still have long-range missiles and whether they have altitude/speed advantage: those with long-range missiles fire them first (max two per target), those holding the high position fire first, those without advantage wait until entering the no-escape zone before firing; after being locked by a missile, they choose one of 7 maneuvers (crank / notch / dive / extend / break / split-S / climb), with horizontal and vertical changes occurring simultaneously — hard turns and dives are preferred at close range, while lateral cuts to drain energy are preferred at long range. Missile drag has also been changed to physical values estimated by missile diameter, no longer reverse-engineered to match range numbers.

The focus of v0.6: **Visible information links** — airborne radar has two modes: LPI (low probability of intercept, dotted line, silent scanning, detected by the opponent's RWR at only 55% of the distance) and STT (single target track, solid line, continuous illumination, detected by the opponent from farther away). Between firing and the seeker going active, the launcher uses STT to continuously feed data to the missile (orange dashed line); after the seeker locks onto the target, a terminal lock line is drawn between the missile and the target. One aircraft can maintain multiple links simultaneously (phased-array multi-target). The triangle in the icon has been changed to a white core with a friendly-color outline (DCS style), and the true silhouettes continue to use the v0.5 parameters.

The focus of v0.7.1: **Electronic warfare and A-shoots-B-guides** — three types of pods have been added to loadouts (wideband noise / DRFM deception / escort self-protection); when activated, they draw purple jamming sectors on the map. The covered side has reduced detection range, degraded track quality, **datalink sharing is also weakened**, STT illumination has a chance of being interrupted, and missile hit probability decreases when the seeker is jammed; turning on jamming also makes you more conspicuous. Missile midcourse guidance is no longer tied to the launcher: any friendly aircraft that can see the target and is within datalink range can take over illumination (including AWACS), marked on the map with a purple dashed line labeled "B-guide", and can also be manually assigned. The pre-battle interface can now directly set the number of enemy fighters. This version also fixes two bugs: "pre-battle interface won't open" and "triangle icons are still solid".

## Running

Open `index.html` directly in a browser (Chrome / Edge / Firefox all work, no server or build required).

```
bvr-command/
├─ index.html
├─ css/style.css
├─ js/
│  ├─ data.js     Aircraft types, loadouts, missiles, scenario data
│  ├─ atmos.js    ISA atmospheric model
│  ├─ sim.js      Flight dynamics, missiles, detection, refueling, combat results
│  ├─ ai.js       Autonomous decision-making (AWACS / tanker / fighter)
│  ├─ render.js   Canvas map rendering, aircraft silhouettes, missile trails
│  ├─ ui.js       Pre-battle interface, lists, command panel, log
│  └─ main.js     Main loop and input
├─ tools/build.js Bundle into single-file version / green folder version
└─ test/
   ├─ smoke.js    Numerical and 15-minute engagement smoke test (Node)
   ├─ boot.js     DOM/Canvas stubs, runs the main loop to verify no exceptions (Node)
   └─ single.js   Extracts the inline script from the single-file version and runs boot again
```

## Controls

| Action | Description |
| --- | --- |
| Left-click list/aircraft | Select (Shift/Ctrl for multi-select, Shift + drag map = box select) |
| Drag map | Pan |
| Scroll wheel | Zoom |
| Right-click enemy aircraft | Assign the currently selected formation's target to that aircraft |
| Space | Pause / resume |
| 1–5 | 1× / 2× / 4× / 8× / 16× speed |
| F | Show full map (including undetected targets) |
| E | Open pre-battle interface |
| T | Toggle icons: true silhouette / triangle |
| Esc | Cancel selection |

The right panel issues commands to **all selected aircraft** simultaneously: altitude slider (3000–18000 m, 250 m steps), Mach slider (0.5–1.6), assign/clear target, waypoints, free/hold fire, autonomous/evade/return to base/refuel; "Select all of same type" and "Select all fighters" allow batch operations. The left "Missiles in flight" list shows each missile's type, distance, TTI, and phase; clicking one moves the view to it.

When a friendly aircraft is selected, its **radar detection circle and field-of-view sector** are drawn on the map, and a **datalink dashed line** is drawn from the AWACS to the entire force; the right-side detail panel simultaneously shows radar range, field-of-view angle, and datalink status.

## Icons and Locking (v0.5)

- **Two icon types**: toggle between "true silhouette / triangle" via the top-right button or the `T` key. True silhouettes are top-down profiles drawn per type from reference three-view drawings: F-16's LEX, F-15's wide fuselage and twin tails, F/A-18's large strakes, MiG-31's wide body with large swept wings, J-10's canards + delta wing, the Flanker family (J-16 / J-11BG / Su-35S), and the canard-equipped Su-30SM2; AWACS are "fuselage + rotodome", tankers are "fuselage + two trailing hoses", and neither draws engine nacelles.
- **Fire-control illumination line**: a fighter currently illuminating a target with its fire-control radar draws a thin dashed line to the target; the line brightens when that aircraft is selected.
- **Missile midcourse guidance**: while a friendly missile is in flight, a fainter dotted line runs from the launcher to the missile body, indicating midcourse command correction is still active.
- **Datalink**: a green thin dashed line from the AWACS to the entire force is always displayed; it brightens when an aircraft is selected, and `RDR …km · DL ON/OFF` is shown next to the aircraft.
- **Lock warning**: when illuminated by enemy fire-control radar and the aircraft's RWR can hear it, an orange dashed ring + "LOCKED" appears around the icon, and the detail panel shows "Locked ×N". Low-probability-of-intercept radars like AESA have compressed illumination detection range (`CONFIG.lpiFactor`), and long-range illumination may be completely inaudible — in that case there will be no indication on the map at all, and you'll only find out when you're shot down.

## Electronic Warfare and A-shoots-B-guides (v0.7.1)

- **Jamming sectors**: after an aircraft with a pod activates it, a purple semi-transparent sector is drawn on the map with the aircraft as the vertex (enemy ones are drawn pale pink and only shown if detected by you). The sector is its area of effect.
- **How jamming is calculated**: for each covered sensor, an intensity value is derived from "jammer power × distance attenuation"; detection range is multiplied by `1 − detect×intensity` (with a lower bound), and track quality is multiplied by `1 − track×intensity`. AESA radars have an ECCM discount (`CONFIG.jam.eccm`). So the most intuitive manifestation of being jammed is: contacts drop from "confirmed" to "fuzzy", or targets are simply lost.
- **Datalink is also jammed**: when the AWACS shares tracks with the entire force, the receiving end's suppressed degree is discounted again (`1 − 0.30×intensity`, lower bound 0.65). So even if the AWACS itself isn't jammed, as long as fighters in the force are suppressed, shared tracks degrade equally — the harder the suppression, the fuzzier the entire force's situational awareness.
- **Interrupting illumination**: if an aircraft currently guiding with STT is covered by DRFM, there is a certain probability every 0.5 s of being interrupted, reverting to LPI; the missile then loses midcourse guidance.
- **Seeker being jammed**: when the target itself has its pod active, terminal hit probability is multiplied by a `1 − 0.35×seeker` discount.
- **The cost of jamming**: pods occupy 2 hardpoints (2 fewer missiles) and increase drag and RCS; aircraft with jamming active are very conspicuous on the opponent's RWR.
- **When AI activates jamming**: automatically activates when locked, when a missile is incoming, or when the nearest enemy enters 210 km; the player can manually "Jam on/off" or return to "Auto" in the detail panel.
- **A-shoots-B-guides**: after missile launch, midcourse guidance is determined by "who can see the target", not necessarily the launcher itself illuminating. Priority: player manually assigned guidance aircraft → launcher → nearest friendly aircraft within 320 km datalink range that has an STT track on the target (each aircraft can guide up to 4 missiles simultaneously). On handover, a log entry "A shoots B guides: X takes over Y's missile" is recorded, and a purple dashed line labeled "B-guide" is drawn on the map at the midpoint. If no one can guide, the missile can only drift on inertial navigation, and hit probability drops significantly.
- In the left "Missiles in flight" list, each missile shows its current guider (own seeker / guiding XXX / B-guide / no guidance); after selecting a friendly aircraft, click the "B-guide" button, then click a friendly aircraft to manually hand over a missile to it.

## Information and Confidence (v0.3 Core)

- **Radar contacts are divided into three tiers**: confidence ≥75% is "confirmed" — solid silhouette + type + altitude/Mach; 35–75% is "fuzzy" — dashed silhouette + error circle + "?" mark; lower than that leaves only a faint dot (memory track). Only "confirmed" contacts can be designated as targets.
- **Where confidence comes from**: each sensor assigns quality based on the ratio of target distance to radar detection range — the closer to the envelope edge, the lower; the AWACS's 360° large radar gets an extra +6%; when no sensor updates, it decays every 0.5 s and is deleted after 75 s.
- **Missiles are not exposed immediately upon launch**: missiles you fire yourself are always visible; enemy missiles are only shown after being seen by your AWACS radar (within 40 km) or fighter radar (within 18 km), or after the seeker activates and is sensed by RWR. When only a warning is received and the missile body hasn't been seen, the target aircraft is marked with an orange `M!`, and the left list records it as "Incoming warning · not acquired".
- This layer is an interface reserved for future electronic warfare: jamming, deception, and datalink degradation only need to modify `trackQuality` and `updateMissileVisibility`.

## Pre-Battle Interface (Before Combat)

- Select aircraft from the hangar to deploy, **total cap 10 aircraft** (including AWACS and tankers).
- Each aircraft can choose a loadout: standard / pure BVR / light. Missile counts converge to realistic normal air-combat loads (heavy fighters 8–12, medium fighters 4–6, J-10C 2–4); the more loaded, the greater the takeoff weight, the higher the zero-lift drag, and the larger the RCS — light loads are more agile but carry fewer missiles.
- Each fighter can also carry one **electronic warfare pod** (does not occupy additional force slots, but occupies 2 hardpoints, carries 2 fewer missiles, and increases drag and RCS):
  - Wideband noise: 250 km coverage, 60° sector, detection range suppressed to 40%–100%, and you are also the most conspicuous;
  - DRFM deception: 180 km coverage, 69° sector, mainly targets track quality and STT illumination (more likely to make the opponent lose lock);
  - Escort self-protection: 90 km omnidirectional, low power, mainly protects yourself and nearby friendlies.
- **Enemy fighter count** is set with a slider (0–10), or check "Random" to draw between 2–10; only affects fighters, enemy AWACS/tankers are fixed at 1 each. The default value takes the current scenario's original composition.
- The top statistics show participating aircraft, total missiles, and drag penalty; click "Start Engagement" when ready.
- The deployed composition is remembered, and "Play Again" reuses the same composition.

## Model Highlights

- **Atmosphere**: ISA layered (troposphere −6.5 K/km, 11–20 km isothermal, 20–32 km warming), density from the ideal gas equation of state, speed of sound `a = sqrt(1.4RT)`.
- **Flight**: lift-limited load factor (`clmax·q·S/(m·g)`) and structural load factor take the minimum; induced drag `Cd = cd0 + 0.05·CL²`; thrust decays with density `(ρ/1.225)^0.7`; climbing consumes kinetic energy (`dv = (T−D)/m − g·(dh/dt)/v`); fuel consumption and stall sink.
- **Loadout**: `mass += Σmissile weight`, `cd0 ×= 1 + 0.028n`, `rcs ×= 1 + 0.018n` (n is the number of missiles carried).
- **Missiles**: solid rocket thrust + aerodynamic drag, long-range loft to 24 km, proportional navigation (`a = 3.6·Vc·λ̇`, with a lower bound on Vc to prevent divergence during lateral cuts), terminal energy correction (lower speed → lower Pk), 3/9-line notch and chaff correction, 1 km fuze radius. The seven missiles' `CdA` are physical values estimated by diameter (0.0048–0.029 m²), and thrust is reverse-calibrated to public ranges (AIM-120D 180 km, PL-15 200 km, R-77-1 110 km, R-37M 300 km, AIM-9X 25 km, PL-10 25 km, R-73 20 km); after burnout, the missile self-destructs when speed drops to 220 m/s, avoiding "target head-on colliding with a gliding dead missile" creating fake range.
- **Detection**: own radar (fighter 60° field of view, AWACS 180°), detection range scales with RCS to the 0.25 power; AWACS shares with the entire force via datalink; tracks decay by confidence (see above).
- **Tactical roles**: no longer fixed by empty weight. Recalculated each time a target is selected: still has ≥150 km missiles and hasn't fired 2 long-range missiles at that target → **long-range suppression** (0.45/0.38 envelope fire, crank for 7 s after firing); otherwise compare altitude, higher by 2500 m or more → **high-position main attack** (envelope +0.16/+0.10/+0.04); neither → **main attack** (0.40/0.32, only fire when closing rate ≥100 m/s). When the target is running (closing<0), envelope ×0.55. The player can see the current role in the detail panel.
- **Vertical maneuvering**: AI selects altitude by distance tier (11.5 / 10.6 / 9.6 / 8.4 / 7 km), and maintains altitude difference within 3500 m of the target; when defending, it randomly selects one of 7 maneuvers by distance, with horizontal turning and altitude change occurring simultaneously (crank lateral cut, notch 3/9 line, dive, extend drag, break hard turn, split-S half-roll inverted, climb), each segment lasting 4–8 s.
- **Refueling**: fighters start with 62% internal fuel; below 18% they autonomously seek the tanker (or the player orders "refuel"); automatically dock within 8 km / 1200 m, fuel transfers at the tanker's rate, and automatically disengages when filled to 90%.
- **AI**: AWACS / tanker retreat according to threat circles and turn around when attacked; fighter priority: fuel red line > evade (including counterattack) > refuel > return to base/no missiles > waypoints > select target > approach and fire; when defending, fly the 3/9 line, dive, release chaff.
- **Silhouettes**: top-down profiles for 15 aircraft types (main wing sweep/root-tip chord, horizontal tails, canards, single/twin vertical tails, rotodome, hoses), driven by the `SHAPES` parameters in `data.js`, cached at render time by instruction array; the `T` key toggles back to triangle icons.
- **Locking**: `sim.updateLocks` counts who is illuminating whom every 0.5 s; whether the illuminated side receives an RWR warning depends on distance and whether the opponent's radar is low-probability-of-intercept. Midcourse guidance and A-shoots-B-guides handover are also completed in this step (writing `guiderId`).
- **Electronic warfare**: jamming intensity = power × (0.35 + 0.65 × distance attenuation), AESA ECCM ×0.55; detection range, track quality, STT interruption probability, and terminal Pk are scaled by the pod's `detect / track / stt / seeker` respectively.

## Scenarios

- `us_cn`: USAF (2×F-15EX / 4×F-16C / 2×F/A-18E + E-3G + KC-135R) vs PLAAF (3×J-16 / 2×J-10C + KJ-500 + HY-6)
- `us_ru`: USAF vs VKS (3×Su-35S / 2×MiG-31BM / 1×Su-30SM2 + A-50U + Il-78M)
- `cn_ru`: PLAAF vs VKS

Fighters start about 300 km apart, with AWACS about 100 km behind; that is, to hit the opponent's AWACS, you must first penetrate or bypass the fighter barrier.

Victory determination (in order): one side's aircraft all destroyed → cleared; one side's **fighters** all destroyed and no missiles in the air → fighter force routed; both sides' fighters out of missiles and no launches for 90 s → out of ammunition; no launches and no missiles in the air for 240 s → disengaged; 30 minutes → timeout judged by survivors and kills.

## Testing

```powershell
$node = "C:\Users\Z3436\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node test\smoke.js
& $node test\boot.js
& $node test\single.js
& $node test\battle.js
& $node test\probe7.js
```

`smoke.js` validates ISA, airframe performance, the seven missiles' ranges (against public values at 1.00x), three scenarios each running 15 minutes without NaN/altitude out-of-bounds, and command interfaces; `boot.js` runs the main loop with minimal DOM stubs to verify rendering and UI refresh don't throw exceptions; `single.js` extracts the inline script from the single-file version and runs boot again; `battle.js` runs the three scenarios to completion with 10 random seeds each, checking victory distribution and end times; `probe7.js` checks enemy count generation, pod loadout costs, jamming frame counts, datalink and A-shoots-B-guides handover counts.

## Installation / Distribution

`dist\` contains three forms:

| File | Purpose |
| --- | --- |
| `BVR-Command-Setup-0.7.1.exe` | Installer. Double-click to install to `%LOCALAPPDATA%\Programs\BVR Command`, create "BVR COMMAND" shortcuts on the desktop and Start menu, and launch automatically. Unsigned; if SmartScreen appears on first run, choose "More info → Run anyway". Uninstall: delete the directory and the two shortcuts. |
| `BVR-Command.html` | Single-file portable version. CSS/JS all inlined, one file, can be sent directly. |
| `BVR-Command-v0.7.1.0.zip` | Green folder version; after unzipping, double-click "Launch Game.bat" or index.html. |

Rebuild: `node tools/build.js` (generates the single-file version and folder version), then compress into zip.

## Notes

Parameters are taken from public sources (manufacturer manuals, public range data, public RCS estimates), intended for teaching/entertainment-level simulation, not an engineering-grade performance model; stealth aircraft, terrain masking, and surface-to-air missiles are not modeled; electronic warfare only goes as far as "jamming sectors affecting detection/tracking/guidance", without frequency-band matching or anti-jamming algorithms.

Balance: the three scenarios are not perfectly symmetric (the PL-15's range advantage is real), `us_cn` is most challenging for Blue, and `cn_ru` gives Blue (China) a clear advantage. Adjusting composition and loadouts via the pre-battle interface is the most direct difficulty knob.
