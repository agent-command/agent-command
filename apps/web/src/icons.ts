/** The only icon entrypoint: bundled Lucide chrome, original model/harness silhouettes and Simple Icons social marks. See CREDITS.txt. */
import {
  Anchor, Aperture, ArrowBigUp, ArrowDownToLine, ArrowLeftRight, Asterisk, AudioLines, BatteryCharging, Bomb, Box, BrickWall, Building2, Castle, ChartNoAxesColumnIncreasing, Check, CircleDot, Clapperboard, Cloud, CloudFog, CloudLightning, CodeXml, Cone,
  Compass, Copy, Crosshair, Crown, Dices, Download, Drill, Ellipsis, Eye, EyeOff, Feather, Flag, Flame, FlaskConical, Focus, Gamepad2, Gauge, GripVertical, Hammer, Hand, Heart, House, Hourglass, Info, Keyboard, Layers, LayoutList, Link, ListMusic, ListOrdered, LocateFixed,
  LogOut, Map as MapIcon, MapPin, Maximize2, Megaphone, MessageCircle, Minimize2, MonitorPlay, MonitorUp, Mountain, MousePointer2, Music, Orbit, Pause, Pickaxe, Pin, Plane as Aircraft, PlaneLanding, PlaneTakeoff, Play, Plus, Radar, Radiation, Repeat, Rocket, RotateCw, Ruler, ScanEye, SendHorizontal, Settings, Shield, ShieldHalf,
  Shovel, SkipBack, SkipForward, Skull, Smartphone, Snowflake, Sparkles, Square, Sun, Sunrise, Sunset, Sword, Swords, Target, Terminal, Timer, TimerReset, TriangleAlert, Trophy, Undo2, Upload, Users, Volume2, VolumeX, Waves, Wind, X, Zap,
  type IconNode,
} from 'lucide';
import type { ClientKind } from '@playerthree/connect';
import type { Armor, Kind, QueueItem, Plane, GameEvent, SCHEDULE_KINDS, SupportNeed, Weapon, WeaponMount } from '@agent-command/game/contract';
import type { ToolId } from './tools/catalog.ts';
import './icons.css';

const gamePaths = {
  // Materials are objects, not their extraction tools or the plane they inhabit.
  alloy: ['M5 7h14l3 10H2z', 'M5 7l3 6h8l3-6 M8 13l-6 4 M16 13l6 4'],
  metal: ['M4 16l3-10 7-3 6 7-3 10H8z', 'M7 6l5 6 8-2 M12 12l-4 8'],
  asteroid: ['M3 9l5-6 9 1 5 7-3 8-9 3-7-6z', 'M8 8l3-1 M15 14l2 2'],
  rubble: ['M2 18l3-6 5 2 1 6H2z', 'M11 9l3-5 5 2 3 7-7 1z'],
  slag: ['M2 19l4-5 4 3 4-7 8 9z', 'M5 8h2 M16 4h2'],
  // A floating land mass and a tunnel mouth stay distinct from Sky's cloud and Mine's pickaxe.
  island: ['M3 10l4-4h10l4 4-9 11z', 'M3 10h18 M8 10l4 11 4-11'],
  depths: ['M2 20V10l6-7h8l6 7v10', 'M7 20v-7l5-5 5 5v7', 'M2 20h5 M17 20h5'],
  // Destination arrow, rather than the four-way camera/pan affordance.
  move: ['M3 19L19 3 M11 3h8v8', 'M17 19h4 M19 17v4'],
  // A pick working a rock; continuous mining adds a return arc, not a second tool.
  mine_asteroid: ['M3 21L15 9', 'M8 4c6 0 10 4 12 10L14 8z', 'M3 9l-1 6 4 2 M17 18l-3 4h-4'],
  auto_mine: ['M6 17l9-9 M10 5c4 0 7 3 8 7l-6-5', 'M20 17a9 9 0 0 1-16-1 M4 16v5 M4 16h5'],
  // The tow verb is a hook, not another silhouette of the tug that performs it.
  grapple: ['M8 3v10a5 5 0 0 0 10 0v-3l-4 3', 'M5 3h6'],
  haul_core: ['M3 4h7 M6.5 4v7a3.5 3.5 0 0 0 7 0', 'M18 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M3 20h7 M7 17l3 3-3 3'],
  lensAttack: ['M2 5h8 M14 19h8', 'M6 21L18 3 M12 3h6v6'],
  bombard: ['M3 18Q8 2 18 12', 'M14 12h4V8', 'M16 20h6 M19 17v5'],
  units: ['M3 10l3-5 3 5z M15 10l3-5 3 5z M9 19l3-5 3 5z'],
  structure_destroyed: ['M3 21V8h6l3-5 3 5h6v13', 'M13 8l-3 5 5 2-3 6', 'M3 21h18'],
  digger: ['M3 14h12v5H3z M5 10h7l3 4H4z', 'M15 12l7 4-7 4z M5 17h6'],
  sapper: ['M4 14h15l2 5H2z M7 14V8h9v6 M11 8V5l3-2'],
  trooper: ['M9 4h6l1 4H8z M9 9h6v8H9z M10 17v4 M14 17v4 M17 10v8 M15 12h4'],
  tank: ['M3 14h17l2 6H2z M7 14V9h8l2 5 M15 11h7 M5 17h12'],
  flak: ['M3 15h17l2 5H2z M8 15v-5h7v5 M10 10l3-7 M14 10l3-7 M4 13V6h3'],
  interceptor: ['M22 12L3 3l5 9-5 9z M8 12h14 M4 9v6'],
  bomber: ['M22 12L2 3l5 9-5 9z M7 12l6-4v8z M4 6l2 2 M4 18l2-2'],
  // an armoured hull under two rotor discs, a dorsal turret
  gunship: ['M3 11h14l4 2-3 4H5l-2-3z', 'M2 6h9 M13 6h9 M6.5 6v5 M17.5 6v5', 'M9.5 11V8.5h3.5V11 M13 9.5h3'],
  // the Gunship set down on an island pad: skids, folded fans and its turret raised on a mast
  gun_platform: ['M2 21h20', 'M6 21v-3 M18 21v-3', 'M5 18h14l1-4H4z', 'M3 14V7 M21 14V7', 'M12 14v-4 M9.5 10h5V7h-5z M14.5 8.5H22'],
  solar: ['M9 9h6v6H9z M2 5h5v14H2z M17 5h5v14h-5z M7 12h2 M15 12h2 M2 10h5 M17 14h5'],
  tug: ['M7 8h10v8H7z M8 5h7v3 M8 16v3h7 M17 10h4v4h-4 M7 12H3 M3 8v8 M3 8l2-2 M3 16l2 2'],
  lancer: ['M4 9h10l4 3-4 3H4z M14 12h8 M6 9V4h4v5 M6 15v5h4v-5 M2 10v4'],
  skiff: ['M21 12L5 8l3 4-3 4z M7 8L3 5v14l4-3 M9 10h4v4H9 M2 10v4'],
  bastion: ['M5 7h11l5 5-5 5H5z M4 6v12 M8 9h6v6H8 M12 5h7v2h-7z M12 17h7v2h-7z M18 6h4 M18 18h4 M2 9v6'],
  // a squat armoured sentinel behind a tall riot shield, a short shotgun at its hip
  warden: ['M3 18v-7h7v7z M4.5 11V8h4v3 M4 18v3 M9 18v3', 'M13 3h6v14l-3 4-3-4z M14.5 6.5h3', 'M10 14h3'],
  // a helmeted trooper with a fuel tank on its back and a flame from the nozzle
  breacher: ['M8 4h6l1 4H7z M8 9h6v8H8z M9 17v4 M13 17v4', 'M4 9h3v7H4z', 'M14 12h3 M17 10c2 1 3.5 1.2 5 1.2-1.5.8-3 1.6-5 2.8z'],
  formation_wedge: ['M10 3h4v4h-4z M5 10h4v4H5z M15 10h4v4h-4z M1 17h4v4H1z M19 17h4v4h-4z'],
  formation_line: ['M1 10h4v4H1z M10 10h4v4h-4z M19 10h4v4h-4z M5 12h5 M14 12h5'],
  formation_escort: ['M9 9h6v6H9z M10 1h4v4h-4z M10 19h4v4h-4z M1 10h4v4H1z M19 10h4v4h-4z'],
  shaft: ['M3 18l4-3h10l4 3-4 3H7z M6 16V6h12v10 M9 6v6h6V6'],
  turret: ['M3 16l4-4h10l4 4v5H3z M7 12V6h9v6 M16 8h6 M5 18h14'],
  relay: ['M7 21h10 M12 21V11 M5 4q7 12 14 0 M12 7V2 M4 3l2 3 M20 3l-2 3'],
  aerie: ['M2 20h20 M4 20V9l8-6 8 6v11 M8 20v-8h8v8 M10 15h4 M12 12v6'],
  storm_seeder: ['M5 21h14 M9 21V11h6v10 M7 11h10 M7 7a4 4 0 0 1 7-3 3 3 0 0 1 3 5H6 M12 6l-2 4h4l-2 4'],
  stormcatcher: ['M4 4l8 8 8-8 M4 4v7l8 5 8-5V4 M12 16v5 M7 21h10 M12 3v5'],
  mooring_tower: ['M4 21h16 M8 21V9h8v12 M6 9h12 M7 5h10 M12 2v10 M5 14l-3-3 3-3 M19 14l3-3-3-3'],
  island_mortar: ['M3 21h18 M6 21l2-7h8l2 7 M9 14L5 5l4-2 6 10 M6 5l4-2 M14 5l2-2 M18 9l3-1'],
  ore_extractor: ['M3 21h18 M6 21V5h12v16 M5 5h14 M12 7v11 M9 10l6-2 M9 14l6-2 M9 18l6-2 M12 18l-2 3h4z'],
  drop_ore: ['M7 3l5-2 5 2v5l-5 3-5-3z M12 12v6 M9 15l3 3 3-3 M3 22l3-3h12l3 3z'],
  dismantle: ['M4 21l9-9 M13 12a6 6 0 0 0 8-8l-4 4-3-3 4-4a6 6 0 0 0-8 8 M3 18l3 3 M3 3l4 4 M17 17l4 4'],
  seed: ['M6 11a4 4 0 0 1 1.5-7.5 5 5 0 0 1 9 1.5A3 3 0 0 1 17 11z', 'M12 22v-8 M9 17l3-3 3 3', 'M6 15v1 M18 15v1 M5 19v1 M19 19v1'],
  // a Gunship's rotor bar settling straight down onto a hardpoint pad
  emplace: ['M6 3h12 M12 3v11', 'M8.5 10.5L12 14l3.5-3.5', 'M3 21h18', 'M6 21v-3h12v3'],
  headframe: ['M3 21h18 M5 21L9 5h6l4 16 M7 14h10 M8 4h8 M12 6l3 3-3 3-3-3z M12 6v6 M9 9h6 M15 11v8'],
  // a low workshop beside a drill rig
  drill_yard: ['M2 21h20', 'M3 21V11l5-3 5 3v10', 'M6 21v-5h4v5', 'M17 21V8 M15 8h4 M16 8l1-4 1 4', 'M15 12.5l4-1.5 M15 16.5l4-1.5'],
  bulkhead: ['M3 21V3h18v18 M6 21V6h12v15 M6 10h12 M6 17h12 M10 12h4v3h-4z M12 6v6 M12 15v6'],
  // a railed deck on two piers over the waves of a lava lake
  lava_bridge: ['M2 11h20', 'M4 11V7 M12 11V7 M20 11V7 M4 7h16', 'M7 11v5 M17 11v5', 'M2 20q2.5-2.5 5 0t5 0 5 0 5 0'],
  // a wellhead on the ground tapping a magma pocket, steam above
  geothermal: ['M2 13h20', 'M9 13V8h6v5', 'M12 13v4', 'M7 19.5a5 2.5 0 1 0 10 0a5 2.5 0 1 0-10 0', 'M10.5 5.5c-.8-1 .8-1.5 0-2.5', 'M13.5 5.5c-.8-1 .8-1.5 0-2.5'],
  // command card verbs: each reads as its effect, and no two card actions share a glyph
  // an arrow driving into a target reticle
  amove: ['M16 3.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9', 'M16 1.5v3 M16 11.5v3 M10 8h3 M19 8h3', 'M3 21l8-8', 'M6 13h5v5'],
  // the ground caving in over a planted charge
  undermine: ['M2 6h6.5l3.5 5 3.5-5H22', 'M12 15a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'M14.6 16.2l2.2-2.2', 'M18.5 11.5V13 M20.5 13.5H19'],
  // breaking up through the ground from a tunnel
  breach: ['M2 12h6.5 M15.5 12H22', 'M12 21V4', 'M8 8l4-4 4 4', 'M7 9.5L5.5 8 M17 9.5L18.5 8', 'M4 16h3 M17 16h3 M6 19.5h2 M16 19.5h2'],
  // a track: two rails and sleepers
  rail: ['M8 3L5 21', 'M16 3l3 18', 'M6.4 6.5h11.2', 'M5.7 11h12.6', 'M4.9 15.5h14.2'],
  // backfill: earth pouring into a pit until it is level again
  bridge: ['M2 9h6 M16 9h6', 'M8 9l1.6 11h4.8L16 9', 'M9.2 16.5q2.8-2.6 5.6 0', 'M12 2v6', 'M9.5 5.5L12 8l2.5-2.5'],
  // up and down through a hole in the ground
  transfer: ['M2 12h5 M17 12h5', 'M10 20V5', 'M7 8l3-3 3 3', 'M14 4v15', 'M11 16l3 3 3-3'],
  // a towed rock falling onto the surface
  deorbit: ['M2 21h20', 'M10 11.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'M12.5 12.5L20 5 M10.5 11.5L16 6 M13.5 14.5L21 7', 'M6 21l-1.5-2 M14 21l1.5-2'],
  // the derelict core: a hot orb in a broken containment ring
  core: ['M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'M5.2 8.2A8 8 0 0 1 8.2 5.2 M15.8 5.2a8 8 0 0 1 3 3 M18.8 15.8a8 8 0 0 1-3 3 M8.2 18.8a8 8 0 0 1-3-3', 'M12 1.5v2 M12 20.5v2 M1.5 12h2 M20.5 12h2'],
  // heat bleeding off the core: the orb under three rising wisps
  vent: ['M12 13.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'M8 10c-1.2-1.5 1.2-2.5 0-4', 'M12 9.5c-1.2-1.8 1.2-3 0-5.5', 'M16 10c-1.2-1.5 1.2-2.5 0-4'],
  // the tow line cut: a hook letting go of a rock
  release: ['M5 3v7a3 3 0 0 0 6 0', 'M5 3h3', 'M13 9l2.5 2.5 M15.5 9L13 11.5', 'M18 14.5a3 3 0 1 0 0 6a3 3 0 1 0 0-6'],
  // the ruin from above: hull band with breaches, the inner ring's gates aligned with them
  derelict_open: ['M5.6 5.6a9 9 0 0 1 12.8 0 M18.4 18.4a9 9 0 0 1-12.8 0', 'M8.5 8.5a5 5 0 0 1 7 0 M15.5 15.5a5 5 0 0 1-7 0', 'M1.5 12h6 M16.5 12h6'],
  // the sun firing a lance
  sun_lance: ['M6 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M6 4v1.6 M6 18.4V20 M1.5 12h1.6 M2.8 8.8l1.1 1.1 M2.8 15.2l1.1-1.1', 'M11 12h10.5', 'M18 8.5l3.5 3.5-3.5 3.5', 'M11.5 9.5h4 M11.5 14.5h4'],
  // one shield dome over a fleet
  aegis: ['M3 19a9 9 0 0 1 18 0', 'M2 19h20', 'M6.5 16l1.5-2.5 1.5 2.5', 'M10.5 13l1.5-2.5 1.5 2.5', 'M14.5 16l1.5-2.5 1.5 2.5'],
  // a dart climbing towards the orbit arc
  ascend: ['M3 7.5Q12 1.5 21 7.5', 'M12 9.5l3.5 8.5-3.5-2-3.5 2z', 'M12 19.5V22'],
  // a crate under a parachute
  airdrop: ['M4 10a8 7 0 0 1 16 0z', 'M4 10l6 7 M20 10l-6 7 M12 10v7', 'M9 17h6v5H9z'],
  // a stance planted on the ground, going up (dig in, siege, emplace, shield wall)
  deploy: ['M2 21h20', 'M5 21V8l4.5-3L14 8v13', 'M7.5 11h4 M7.5 15h4', 'M19 4v9 M16.5 6.5L19 4l2.5 2.5'],
  // the stance coming down
  pack: ['M2 21h20', 'M4 21v-6l4.5-2.5L13 15v6', 'M6.5 17.5h4', 'M19 4v9 M16.5 10.5L19 13l2.5-2.5'],
  // a lit flare lobbed along an arc
  flare: ['M3 20Q5 10 12.5 9.5', 'M17 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5', 'M17 2.5V4 M17 15v1.5 M21.5 9.5H23 M20.3 6.2l1-1 M20.3 12.8l1 1'],
  // a trooper walking in, a flame coming out
  convert: ['M3 8h4v9H3z M4 17v4 M6 17v4 M3.5 5h3', 'M9 12h4.5 M11.5 9.5l2.5 2.5-2.5 2.5', 'M18.5 21c-2.2 0-3.7-1.4-3.7-3.4 0-2.4 2.3-3.4 2.3-6 1.6 1 4.1 3 4.1 6 0 2-1.2 3.4-2.7 3.4z'],
  // three pellets fanning from a short barrel
  shotgun: ['M2 12h7', 'M11 12l9-5 M11 12h10 M11 12l9 5'],
  // a flag planted on a mound: take and hold this spot
  claim: ['M4 21h16', 'M6 21q6-5 12 0', 'M12 17.5V3', 'M12 3l7 3-7 3'],
} as const;
const RING = 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17';
const harnessPaths = {
  // a hand-drawn spark
  'claude-code': ['M12 3v18', 'M3.5 12h17', 'M6.4 6.4l3.4 3.4', 'M17.6 6.4l-3.4 3.4', 'M6.4 17.6l3.4-3.4', 'M17.6 17.6l-3.4-3.4'],
  'claude-api': [RING, 'M12 6v12', 'M6 12h12', 'M8 8l8 8', 'M8 16l8-8'],
  // a terminal prompt inside a hexagon
  codex: ['M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z', 'M8.6 9.6l2.6 2.4-2.6 2.4', 'M12.6 14.8h3.2'],
  // open braces around a forward slash: open code
  opencode: ['M8.5 4.5c-1.8 0-2.7.9-2.7 2.7v2.4L3.8 12l2 2.4v2.4c0 1.8.9 2.7 2.7 2.7', 'M15.5 4.5c1.8 0 2.7.9 2.7 2.7v2.4l2 2.4-2 2.4v2.4c0 1.8-.9 2.7-2.7 2.7', 'M13.6 8.5l-3.2 7'],
  // the letter pi
  pi: ['M4 7.5h16', 'M9.5 7.5v12', 'M15 7.5v9.5a2.5 2.5 0 0 0 4.2 1.8'],
  // pi inside a ring: the pi-based distribution
  'oh-my-pi': [RING, 'M7.5 9.5h9', 'M10.5 9.5v6.5', 'M14 9.5v4.8a1.6 1.6 0 0 0 2.7 1.2'],
  // the messenger's wing
  hermes: ['M4.5 18.5C9 17.5 15 13.5 19.5 5', 'M7.5 17.4C6.8 14.3 7.8 11.4 10 9.6', 'M11.2 15.6c-.2-2.9 1.2-5.4 3.6-7', 'M14.8 12.8c.3-1.7 1.7-3.2 3.8-4.1'],
  // a plug: any MCP client
  generic: ['M9 3v4.5', 'M15 3v4.5', 'M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0z', 'M12 16.5V21'],
  // play on your own key
  'playerthree-runner': [RING, 'M10 8.4v7.2l6-3.6z'],
  // an arch bridge between two piers
  'playerthree-bridge': ['M2.5 8h19', 'M5 8v11', 'M19 8v11', 'M8 19a4 4 0 0 1 8 0', 'M8.5 8v3.2', 'M12 8v2.4', 'M15.5 8v3.2'],
  // built-in bot: a little automaton head
  bot: ['M6.5 8.5h11v9h-11z', 'M12 4.5v4', 'M10.5 4.5h3', 'M9.5 12.5v1', 'M14.5 12.5v1', 'M4 12v3', 'M20 12v3'],
  // the player
  human: ['M12 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'M5 20c.8-4 3.6-6 7-6s6.2 2 7 6'],
  // nobody: an empty dashed ring
  none: [RING, 'M8 12h8'],
  // a persistent commander token (bearer fallback)
  token: ['M8 8.5a4 4 0 1 0 0 7a4 4 0 1 0 0-7', 'M12 12h8.5', 'M17 12v3', 'M19.5 12v2'],
} as const satisfies Record<ClientKind | 'bot' | 'human' | 'none' | 'token', readonly string[]>;
const paths = (values: readonly string[]): IconNode => values.map((d) => ['path', { d }]);
const custom = Object.fromEntries(Object.entries({ ...gamePaths, ...harnessPaths }).map(([name, values]) => [name, paths(values)])) as Record<keyof typeof gamePaths | keyof typeof harnessPaths, IconNode>;
// Brand marks for outbound social links: Simple Icons 16.36.0 (CC0), filled rather than stroked. See CREDITS.txt.
const brandPaths = {
  brand_x: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  brand_discord: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z',
  brand_patreon: 'M22.957 7.21c-.004-3.064-2.391-5.576-5.191-6.482-3.478-1.125-8.064-.962-11.384.604C2.357 3.231 1.093 7.391 1.046 11.54c-.039 3.411.302 12.396 5.369 12.46 3.765.047 4.326-4.804 6.068-7.141 1.24-1.662 2.836-2.132 4.801-2.618 3.376-.836 5.678-3.501 5.673-7.031Z',
} as const;
const filled = (d: string): IconNode => [['path', { d, fill: 'currentColor', stroke: 'none' }]];
const brands = Object.fromEntries(Object.entries(brandPaths).map(([name, d]) => [name, filled(d)])) as Record<keyof typeof brandPaths, IconNode>;

/** Closed game vocabularies are checked here at compile time and against exported registries in tests. */
export const ICONS = {
  ...custom, ...brands,
  energy: Zap, bank: BatteryCharging, spire: Castle, post: Flag,
  ice: Snowflake, volatile: Flame,
  surface: Mountain, sky: Cloud, orbit: Orbit,
  daylight: Sun, dawn: Sunrise, dusk: Sunset, time_cap: Hourglass, flood: Waves,
  asteroid_spawn: custom.asteroid, magma_cools: Waves, core_regrows: custom.core, lode_vent: Flame,
  chat: MessageCircle, send: SendHorizontal, ping: MapPin, console: Terminal, policy: CodeXml, settings: Settings, leave: LogOut,
  // policy packages: a file out (export) and in (import)
  download: Download, upload: Upload,
  chart: ChartNoAxesColumnIncreasing, map: MapIcon, home: House, gamepad: Gamepad2, browse: LayoutList, create_game: Plus, reconnect: RotateCw,
  volume: Volume2, muted: VolumeX, music: Music, sfx: AudioLines,
  music_play: Play, music_pause: Pause, music_prev: SkipBack, music_next: SkipForward, music_auto: Compass, music_manual: Pin,
  music_list: ListMusic, fold: Minimize2, grip: GripVertical,
  // observer caster tools
  director: Clapperboard, follow: LocateFixed, overview: Layers, stream: MonitorPlay, standings: Trophy, swap: ArrowLeftRight,
  next: SkipForward, unfold: Maximize2,
  spectate: Eye, invite: Link, dice: Dices, copy: Copy, commanders: Users, keyboard: Keyboard, ours: Shield, enemy: Swords,
  // the phone banner: this device, and the hand-off to a bigger screen
  phone: Smartphone, desktop: MonitorUp,
  queue: ListOrdered, cancel: X, idle: Hourglass, alert: TriangleAlert, info: Info, check: Check,
  structures: Building2, research: FlaskConical, aggressive: Sword, defensive: Shield, more: Ellipsis,
  default: MousePointer2, designate: Shovel, patrol: Repeat, stop: Square, hold: Hand,
  moor: custom.mooring_tower, unmoor: Undo2,
  mine: Pickaxe, fortify: BrickWall, scan: Radar, rally: Flag, build: Hammer, pick: Focus,
  aegis_projectors: custom.aegis, ascent_thrusters: custom.ascend, night_cloak: EyeOff, lancer_lens: Aperture,
  // Depths research: a power drill for faster digging, a cone for the shaped (directed) charge
  drill_bits: Drill, shaped_charges: Cone,
  // segment rebuild (queue item) and the crowns events: a crown lost, a crown rebuilt
  rebuild: Castle, crown_lost: Crown, segment_rebuilt: Crown,
  hangar: PlaneLanding, launch: PlaneTakeoff, storm: CloudLightning, wind: Wind, fog: CloudFog,
  guard_root: Shield, defend_spire: Castle, attack_nearest: Swords,
  recapture: Flag, intercept: Crosshair, harvest_core: custom.core, spread_arrays: Sun,
  unit_lost: Skull, enemy_killed: Swords, structure_lost: custom.structure_destroyed,
  produced: Box, constructed: Hammer, collapse: custom.undermine, fell_into_depths: ArrowDownToLine,
  impact_incoming: TriangleAlert, impact: Bomb, asteroid_intercepted: Crosshair, volatile_detonation: Sparkles,
  core_lifted: custom.core, core_cashed: custom.core, core_meltdown: Flame, core_vented: custom.vent, irradiated: Radiation,
  island_captured: Flag, island_lost: Flag, emplaced: custom.gun_platform, post_captured: Flag, post_lost: Flag, spire_damaged: Castle, enemy_sapper_seen: Eye,
  tunnel_breach: custom.breach, charge_planted: Bomb, charge_spotted: Bomb, charge_defused: Shield, breach_tremor: TriangleAlert, intruder: Swords,
  breach_opened: custom.breach, chasm_opened: ArrowDownToLine, hole_bridged: custom.bridge, magma_flood: Waves, cache_burned: Flame, lode_erupted: Flame,
  lode_opened: Pickaxe, target_unreachable: TriangleAlert, queue_added: ListOrdered, queue_cancelled: X, queue_moved: Undo2,
  transit_return: TimerReset, army_eliminated: Skull, sudden_death: Skull,
  // team support requests: the Request tool, a request to the whole team, and one glyph per need (none a card verb's)
  request: Megaphone, team: Users,
  need_troops: custom.trooper, need_air_cover: custom.interceptor, need_scan: ScanEye, need_flak: custom.flak, need_bombers: custom.bomber, need_escort: custom.bastion,
  need_collapse: custom.sapper, need_drop: custom.asteroid, need_capture: custom.claim, need_defend: Castle,
  // unit stats: one icon per stat, weapon, armor class and mount
  stat_hp: Heart, stat_shield: Shield, stat_shield_regen: RotateCw, stat_shield_delay: TimerReset, stat_dmg: Crosshair, stat_rate: Timer, stat_dps: Flame, stat_range: Ruler, stat_speed: Gauge, stat_vision: Eye,
  weapon_rifle: CircleDot, weapon_cannon: Target, weapon_flak: Asterisk, weapon_missile: Rocket, weapon_bomb: Bomb, weapon_beam: Sparkles, weapon_point_defence: Crosshair, weapon_turret: LocateFixed, weapon_pick: Pickaxe, weapon_shotgun: custom.shotgun, weapon_flamer: Flame,
  armor_small: CircleDot, armor_light: Feather, armor_armored: ShieldHalf, armor_air: Aircraft, armor_heavy_air: custom.gunship, armor_structure: Building2, armor_island: custom.island,
  mount_turret: RotateCw, mount_forward: ArrowBigUp, mount_fixed: Anchor,
} satisfies Record<Kind | QueueItem | Plane | ToolId | GameEvent['kind'] | 'transit_return' | (typeof SCHEDULE_KINDS)[number] | ClientKind, IconNode>
  & Record<`weapon_${Weapon}` | `armor_${Armor}` | `mount_${WeaponMount['kind']}` | `need_${SupportNeed}`, IconNode> & Record<string, IconNode>;
export type IconName = keyof typeof ICONS;

/** Decorative SVG. The owning control MUST have an accessible name and a global tooltip. */
export function icon(name: IconName, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', width: String(size), height: String(size),
    'aria-hidden': 'true', focusable: 'false', class: `icon icon-${name}`,
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  })) svg.setAttribute(key, value);
  for (const [tag, attrs] of ICONS[name]) {
    const child = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) if (value !== undefined) child.setAttribute(key, String(value));
    svg.append(child);
  }
  if (name === 'none') svg.firstElementChild?.setAttribute('stroke-dasharray', '3 2.4');
  return svg;
}

const PATHS = new Map<IconName, Path2D>();
/**
 * All stroke geometry as one canvas path in its 24-unit box. Stamp with round caps/joins and no fill.
 * Cache once per icon; Lucide circles, lines and rectangles must not disappear beside custom paths.
 */
export function iconPath(name: IconName): Path2D {
  let path = PATHS.get(name);
  if (!path) {
    path = new Path2D();
    for (const [tag, attrs] of ICONS[name]) {
      const n = (key: string) => Number(attrs[key] ?? 0);
      if (tag === 'path' && typeof attrs.d === 'string') path.addPath(new Path2D(attrs.d));
      else if (tag === 'circle' || tag === 'ellipse') {
        const rx = n(tag === 'circle' ? 'r' : 'rx');
        const ry = n(tag === 'circle' ? 'r' : 'ry');
        path.moveTo(n('cx') + rx, n('cy'));
        path.ellipse(n('cx'), n('cy'), rx, ry, 0, 0, Math.PI * 2);
        path.closePath();
      } else if (tag === 'rect') {
        path.roundRect(n('x'), n('y'), n('width'), n('height'), { x: n('rx') || n('ry'), y: n('ry') || n('rx') });
      } else if (tag === 'line') {
        path.moveTo(n('x1'), n('y1'));
        path.lineTo(n('x2'), n('y2'));
      } else if ((tag === 'polyline' || tag === 'polygon') && typeof attrs.points === 'string') {
        const points = attrs.points.trim().split(/[\s,]+/).map(Number);
        path.moveTo(points[0]!, points[1]!);
        for (let i = 2; i < points.length; i += 2) path.lineTo(points[i]!, points[i + 1]!);
        if (tag === 'polygon') path.closePath();
      }
    }
    PATHS.set(name, path);
  }
  return path;
}
