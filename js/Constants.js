// Constants.js — ALL the kit's numbers: location, camera, render. Loaded FIRST:
// the other modules read these globals. Edited by the editor (_utils/editor): the server
// patches only lines of the form `const NAME = <number>;` — keep values as numeric
// literals (colors — 0xRRGGBB); the editor won't touch a formula.
const GAME_VERSION = '0.1.0'; // build version: ?v= on scripts (tools/build.mjs) and the archive name

// localStorage shim: in a sandbox iframe and when site data is blocked, direct access throws SecurityError.
// All storage access goes through Store only.
/** @satisfies {Record<string, any>} */
const Store = {
    get(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch (e) { /* nothing to remove */ }
    },
    // JSON parsing that never throws: a broken value = as if there were no save.
    getJSON(key, fallback = null) {
        const raw = Store.get(key);
        if (raw === null) return fallback;
        try {
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : fallback;
        } catch (e) {
            console.warn('Store: повреждённое значение "' + key + '", сбрасываю.');
            Store.remove(key);
            return fallback;
        }
    }
};

// Phone or tablet: user agent, iPad posing as a Mac, touch on a small screen.
const IS_MOBILE = (() => {
    const userAgentMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const hasTouchScreen = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const isSmallScreen = Math.max(window.innerWidth, window.innerHeight) <= 1366 &&
        Math.min(window.innerWidth, window.innerHeight) <= 1024;
    const isiPad = /iPad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return userAgentMobile || isiPad || (hasTouchScreen && isSmallScreen);
})();

// --- LOCATION (Location3D.js, Terrain3D.js). World units are px: x to the right, y down
// the map, height up (skill world3d, §Coordinates). ---
const LOCATION_WIDTH = 4800;            // px: largest board (600 map units × RTS_WORLD_SCALE); Game shrinks it per match
const LOCATION_HEIGHT = 4800;           // px: largest board (600 map units × RTS_WORLD_SCALE)
const LOCATION_GROUND = 0;              // ground texture: 0 — grass, 1 — sand, 2 — snow (Location3D.GROUNDS)
const GROUND_TILE_SIZE = 512;           // world px per one repeat of the ground texture (≈ texture resolution: no stretch)
const TERRAIN_NOISE_AMP = 12;           // px: gentle visual relief; the RTS logic stays flat
const TERRAIN_NOISE_SCALE = 3000;       // px: hill size
const TERRAIN_NOISE_SEED = 17;          // terrain noise seed
const TERRAIN_BASE = 0;                 // px: mean ground level
const TERRAIN_CELL = 32;                // px: terrain grid step (mobile — no finer than 12)

// --- MODELS (Gltf3D.js) and UI (UI.js) ---
const MODEL_CLIP_BLEND_SEC = 0.2;       // s: cross-fade between animation clips of a .glb model (idle -> run); 0 — instant
const UI_REF_HEIGHT = 720;              // px: the screen height the UI layout (UILayout.js) is drawn for; the UI scales with the screen height, 0 — no scaling

// --- SOUND (Sound3D.js): channel volumes; a sound with a place on the map is heard from where
// the CAMERA is — its audible region is a sphere of AUDIO_FALLOFF_MAX around it ---
const AUDIO_MASTER_VOLUME = 0.8;        // 0..1: everything (0 — silence)
const AUDIO_MUSIC_VOLUME = 0.6;         // 0..1: the 'music' channel
const AUDIO_VOICE_VOLUME = 0.9;         // 0..1: the 'voice' channel — the field commander's lines
const AUDIO_SFX_VOLUME = 1;             // 0..1: the 'sfx' channel — effects and object sounds
const AUDIO_FALLOFF_MIN = 150;          // px: full volume while the camera is this close to a sound (0 — it fades from the source itself)
const AUDIO_FALLOFF_MAX = 1024;         // px: from here on it is silent (fades linearly in between); an object may set its own pair. The camera stands ~800 px from its look-at point at zoom 1
const AUDIO_PAN = 0.7;                  // 0..1: how far a sound at the side of the screen goes into one ear (0 — mono)

// --- SAMPLE GAME (Game.js): the "Run" button, the energy bar ---
const GAME_RUN_SEC = 8;                 // s: a full energy bar lasts this long while running
const GAME_REST_SEC = 4;                // s: an empty energy bar refills in this time while standing
const GAME_STEP_SEC = 0.35;             // s: between footstep sounds while the character runs

// --- RTS DEMO (js/RTS*.js): map units are converted to world px by RTS_WORLD_SCALE.
// The board is RTS_MAP_SIZE × RTS_MAP_SIZE units, generated from RTS_MAP_SEED: bases,
// crystal fields, scenery and the opponent's build plan. Statistics of units and buildings
// live in RTSData.js. ---
const RTS_MAP_SIZE_SMALL = 200;         // map units per side: small board
const RTS_MAP_SIZE_MEDIUM = 400;        // map units per side: medium board
const RTS_MAP_SIZE = 600;               // map units per side: large board (also the default fallback)
const RTS_WORLD_SCALE = 8;              // world px per map unit
const RTS_MAP_SEED = 0;                 // 0 — a new map every match, otherwise a fixed seed
const RTS_BASE_MIN_DISTANCE = 0.6;      // map sides: bases are at least this far apart
const RTS_RESOURCE_COUNT_SMALL = 6;     // fields on the small board
const RTS_RESOURCE_COUNT_MEDIUM = 12;   // fields on the medium board
const RTS_RESOURCE_COUNT_LARGE = 18;    // fields on the large board
const RTS_RESOURCE_BASE_CLEARANCE = 20; // map units: fields stay this far from both bases
const RTS_RESOURCE_SPACING = 20;        // map units between crystal fields
const RTS_RESOURCE_AMOUNT_MIN = 500;    // crystals in one field
const RTS_RESOURCE_AMOUNT_MAX = 1000;   // crystals in one field
const RTS_RESOURCE_AMOUNT_STEP = 10;    // crystal amount step
const RTS_ENEMY_BASE_BLOCK_RADIUS = 0.16; // map sides: the player cannot build this close to the enemy HQ
const RTS_SCENERY_BASE_CLEARANCE = 24;  // map units: no trees or rocks this close to a base
const RTS_SCENERY_RESOURCE_CLEARANCE = 6; // map units: clear ring around a crystal field
const RTS_SCENERY_BORDER_MARGIN = 8;    // map units: no scenery this close to the border
const RTS_WRECK_BASE_CLEARANCE = 24;    // map units: wreck stays this far from both bases
const RTS_WRECK_RADIUS = 3.5;           // map units: wreck interaction radius
const RTS_WRECK_SEARCH_SEC = 15;        // s: search time
const RTS_WRECK_REWARD_MIN = 50;        // crystals for a searched wreck
const RTS_WRECK_REWARD_MAX = 200;       // crystals for a searched wreck
const RTS_TERRAIN_HILLS_SMALL = 3;      // hills on the small board
const RTS_TERRAIN_HILLS_MEDIUM = 5;     // hills on the medium board
const RTS_TERRAIN_HILLS_LARGE = 7;      // hills on the large board
const RTS_TERRAIN_DEPRESSIONS_SMALL = 2; // depressions on the small board
const RTS_TERRAIN_DEPRESSIONS_MEDIUM = 3; // depressions on the medium board
const RTS_TERRAIN_DEPRESSIONS_LARGE = 4; // depressions on the large board
const RTS_TERRAIN_WATER_SMALL = 1;      // ponds on the small board
const RTS_TERRAIN_WATER_MEDIUM = 2;     // ponds on the medium board
const RTS_TERRAIN_WATER_LARGE = 3;      // ponds on the large board
const RTS_TERRAIN_BASE_CLEARANCE = 24;  // map units: relief stays this far from both bases
const RTS_TERRAIN_BORDER_MARGIN = 8;    // map units: relief stays this far from the border
const RTS_TERRAIN_HILL_RADIUS_MIN = 18; // map units
const RTS_TERRAIN_HILL_RADIUS_MAX = 34; // map units
const RTS_TERRAIN_HILL_HEIGHT_MIN = 24; // world px
const RTS_TERRAIN_HILL_HEIGHT_MAX = 48; // world px
const RTS_TERRAIN_DEPRESSION_RADIUS_MIN = 12; // map units
const RTS_TERRAIN_DEPRESSION_RADIUS_MAX = 26; // map units
const RTS_TERRAIN_DEPRESSION_DEPTH_MIN = 16;  // world px
const RTS_TERRAIN_DEPRESSION_DEPTH_MAX = 32;  // world px
const RTS_TERRAIN_WATER_RADIUS_MIN = 8; // map units
const RTS_TERRAIN_WATER_RADIUS_MAX = 16; // map units
const RTS_TERRAIN_WATER_DEPTH_MIN = 12; // world px
const RTS_TERRAIN_WATER_DEPTH_MAX = 24; // world px
const RTS_TERRAIN_WATER_SPACING = 8;    // map units between ponds
const RTS_WATER_SURFACE_OFFSET = 6;     // world px: water surface below the pond rim
const RTS_FOG_RESOLUTION = 256;         // fog-of-war texture side (the vision grid may be larger)
const RTS_PATH_COARSE_CELL = 16;        // map units per cell of the long-range path grid (0 — off)
const RTS_PATH_COARSE_MIN = 40;         // map units: farther paths try the coarse grid first
const RTS_START_CREDITS = 500;          // crystals both sides start with (equal terms)
const RTS_CREDIT_CAP = 9999;            // upper limit of the crystal stockpile
const RTS_START_WORKERS = 4;            // gatherers each side starts with
const RTS_START_INFANTRY = 0;           // infantry each side starts with
const RTS_SUPPLY_CAP = 100;             // hard limit: generators above it add nothing
const RTS_GATHER_CAPACITY = 10;         // crystals a gatherer carries per trip
const RTS_GATHER_TIME = 4;              // s: gathering one full load
const RTS_GATHER_UNLOAD_TIME = 1;       // s: unloading a full load at the drop-off
const RTS_RESOURCE_WORKERS_PER_FIELD = 2; // miners assigned to one field at once
const RTS_AI_WAVE_SIZE = 5;             // combat units the opponent gathers before a wave
const RTS_AI_FIRST_WAVE_SEC = 90;       // s before the opponent's first attack is allowed
const RTS_AI_WAVE_INTERVAL_SEC = 60;    // s between opponent waves
const RTS_AI_WORKER_TARGET = 4;         // opponent keeps this many gatherers
const RTS_AI_INFANTRY_TARGET = 5;       // opponent keeps this many infantry + scouts
const RTS_AI_SIEGE_TARGET = 1;          // opponent keeps this many siege vehicles
const RTS_AI_GRENADIER_TARGET = 1;      // opponent keeps this many grenadiers in a wave
// GOAP opponent (RTSAIDirector, RTSSquadManager/RTSSquad): planning cadence, plan limits, squad sizes and tactical thresholds.
const RTS_GOAP_DIRECTOR_SEC = 1.5;      // s between strategic director planning ticks (events replan earlier)
const RTS_GOAP_SQUAD_SEC = 0.8;         // s between tactical squad planning ticks
const RTS_GOAP_PLAN_TTL_SEC = 10;       // s a plan stays valid before a forced rethink
const RTS_GOAP_MAX_EXPANSIONS = 400;    // A* expansion limit for the director
const RTS_GOAP_SQUAD_EXPANSIONS = 200;  // A* expansion limit for one squad
const RTS_GOAP_ACTION_TIMEOUT_SEC = 12; // s before a stuck action fails and the plan is rebuilt
const RTS_GOAP_GOAL_STICKY = 10;        // priority bonus for the current goal (anti-flapping)
const RTS_GOAP_RETRY_SEC = 5;           // s cooldown after a failed director action
const RTS_GOAP_DIRECTOR_STEPS = 1;      // plan steps the director may start per tick
const RTS_GOAP_SQUAD_STEPS = 2;         // instant plan steps a squad may start per tick
const RTS_SQUAD_SIZE = 5;               // maximum assault squad size
const RTS_SQUAD_HARASS_SIZE = 3;        // harass squad size
const RTS_SQUAD_RETREAT_HEALTH = 0.45;  // health fraction that makes a squad withdraw
const RTS_SQUAD_RETREAT_LOSS = 0.4;     // loss fraction that makes a squad withdraw
const RTS_SQUAD_STUCK_SEC = 2;          // s without movement before a squad replans
const RTS_SQUAD_STUCK_DIST = 1.5;       // map units of movement that count as progress
const RTS_SQUAD_CLAIM_SEC = 6;          // s a squad owns a target
const RTS_AI_SCOUT_RATIO = 0.35;        // explored map fraction that satisfies scouting
const RTS_AI_TOWER_TARGET = 2;          // desired tower count
const RTS_AI_REGROUP_HEALTH = 0.55;     // army health fraction that triggers regroup
const RTS_AI_HARASS_SEC = 30;           // s between harassment missions
const RTS_AI_TOAST_SEC = 15;            // s between major AI toasts
const RTS_AI_DEFENSE_RADIUS = 18;       // map units around the base that trigger a defence
const RTS_AI_STAGING_DISTANCE = 18;     // map units from the player base where the army gathers
const RTS_AI_ATTACK_WAIT_SEC = 30;      // s the army may gather before the push starts anyway
const RTS_AI_RETREAT_RATIO = 0.5;       // army size fraction that makes the commander retreat
const RTS_AI_SCOUT_SEC = 20;            // s between scout orders
const RTS_AI_MAX_SCOUTS = 1;            // opponent keeps this many scouts
const RTS_MATCH_LIMIT_SEC = 900;        // s: a stalemate ends with a draw screen
const RTS_BUILD_MARGIN = 2.5;           // map units from the map border where building is forbidden
const RTS_BUILD_CLEARANCE = 0.7;        // map units of padding around every blocking object
const RTS_DEMOLISH_TIME_SEC = 8;        // s to dismantle a finished building
const RTS_DEMOLISH_REFUND = 0.5;        // fraction of the building cost returned on completion
// Movement: Reynolds-style behaviors, context steering, group movement and path request budget.
const RTS_STEER_CELL = 4;               // spatial hash cell, map units
const RTS_STEER_NEIGHBORS = 16;         // nearest units a steering query keeps
const RTS_STEER_LOOKAHEAD = 1.2;        // map units: how far ahead the path follower looks
const RTS_STEER_ARRIVE = 1.5;           // map units: stop distance at a waypoint
const RTS_PATH_FALLBACK_SEC = 0.8;      // s without progress before a unit asks for a path
const RTS_PATH_BLOCKED_SEC = 1.4;       // s to wait when no path exists
const RTS_STEER_BOUNDS = 2.2;           // map units from the border where a unit is clamped
const RTS_ARRIVAL_RADIUS = 2.5;         // map units: arrival slowdown radius
const RTS_MOVE_ARRIVE_RADIUS = 0.8;     // map units: a move order is complete this close
const RTS_MOVE_SPACING = 2.0;           // map units between static landing points
const RTS_SEPARATION_RADIUS = 2.2;      // map units: neighbours that push each other apart
const RTS_SEPARATION_WEIGHT = 1.8;      // separation danger weight
const RTS_OBSTACLE_RADIUS = 3.0;        // map units: static blockers noticed by steering
const RTS_OBSTACLE_WEIGHT = 2.4;        // static obstacle danger weight
const RTS_FLEE_RADIUS = 6.0;            // map units: a worker runs from an enemy this close
const RTS_FLEE_WEIGHT = 2.0;            // flee danger weight
const RTS_DEPENETRATION_PASSES = 2;     // hard collision passes after integration
const RTS_PATH_BUDGET = 8;              // A* requests per simulation tick
const RTS_PATH_REPATH_SEC = 0.9;        // s between path requests for a moving goal
const RTS_PATH_LIGHT_RADIUS = 1.2;      // clearance of the light path grid
const RTS_PATH_HEAVY_RADIUS = 2.0;      // clearance of the heavy path grid
// Combat: target scoring, focus fire, standoff and turret tracking.
const RTS_COMBAT_THINK_SEC = 0.3;       // s between target assignment cycles
const RTS_COMBAT_STICKY = 18;           // bonus for keeping the current target
const RTS_COMBAT_DISTANCE = 0.8;        // score penalty per map unit of distance
const RTS_COMBAT_THREAT = 1.5;          // weight of the target's damage output
const RTS_COMBAT_VALUE = 0.02;          // weight of the target's cost
const RTS_COMBAT_KILL = 20;             // bonus for a wounded target (fraction missing)
const RTS_COMBAT_OVERKILL = 0.6;        // reserved-damage penalty
const RTS_COMBAT_LEASH = 1.7;           // auto-acquired target is dropped beyond sight × this
const RTS_COMBAT_FIRE_SPEED = 1.2;      // map units/s: faster units must stop before firing
const RTS_COMBAT_TOWER = 35;            // score penalty for a target covered by an enemy tower
const RTS_COMBAT_RESERVE = 1.2;         // damage reserved per assigned unit (overkill guard)
const RTS_DAMAGE_MIN_FRACTION = 0.25;   // every shot deals at least this fraction of D (damage formula)
const RTS_STANDOFF_BACKOFF = 3.0;       // map units a ranged unit backs off when too close
// Vision and fog of war.
const RTS_VISION_UPDATE_SEC = 0.2;      // s between visibility grid updates
const RTS_START_EXPLORED_RADIUS = 70;   // map units: explored circle around each base at start
const RTS_INTEL_UNIT_TTL = 10;          // s a seen enemy unit stays in the intel memory
const RTS_INTEL_BUILDING_TTL = 30;      // s a seen enemy building stays in the intel memory
const RTS_FOG_UPDATE_SEC = 0.15;        // s between fog texture uploads
const RTS_FOG_UNEXPLORED_ALPHA = 1.0;   // darkness of never-seen terrain
const RTS_FOG_EXPLORED_ALPHA = 0.0;     // darkness of explored terrain (0 = fully clear)
const RTS_FOG_COLOR = 0x081018;          // fog tint in the post-process
const RTS_SFX_SHOT_GAP = 0.06;          // s: combat sounds — at most one shot sound per interval
const RTS_SFX_IMPACT_GAP = 0.05;        // s: at most one hit sound per interval
const RTS_SFX_READY_GAP = 0.3;          // s: at most one "unit ready" sound per interval
const RTS_GRENADE_FLIGHT_SEC = 0.42;    // s: a grenade's visual flight time
const RTS_GRENADE_ARC_HEIGHT = 18;      // world px: peak of the visual grenade arc
// Field-commander voice lines (js/RTSAudio.js): one at a time, the queue is short.
const RTS_VOICE_VOLUME = 0.9;           // 0..1, on top of the SFX channel volume
const RTS_VOICE_QUEUE_MAX = 3;          // pending lines; a fourth drops the least urgent
const RTS_VOICE_GAP_SEC = 0.25;         // s of silence between two lines
const RTS_VOICE_ATTACK_GAP_SEC = 12;    // s between repeated attack reports
const RTS_VOICE_LOSS_GAP_SEC = 5;       // s between repeated building-loss reports
const RTS_VOICE_READY_GAP_SEC = 2;      // s between repeated unit-ready reports
const RTS_UNIT_VOICE_GAP_SEC = 1.2;     // s between unit replies: a squad answers one at a time
const RTS_UNIT_VOICE_VOLUME = 0.7;      // 0..1, on top of the voice channel: radio chatter is mastered hotter
const RTS_PLAYER_COLOR = 0x3f8cff;      // blue team tint
const RTS_ENEMY_COLOR = 0xff5a5a;       // red team tint
const RTS_NEUTRAL_COLOR = 0xffcf5a;     // crystals and neutral markers
const RTS_SELECT_COLOR = 0x74ff9a;      // selection rings of the player's objects
// Minimap (js/RTSMinimap.js): the board picture, fog overlay and camera footprint.
const RTS_MINIMAP_RELIEF = 1;           // 1 — shade the ground by terrain height, 0 — flat ground
const RTS_MINIMAP_GROUND_COLOR = 0x2f4433; // flat ground colour
const RTS_MINIMAP_GROUND_HIGH = 0x43573c;  // high ground tint
const RTS_MINIMAP_TREE_COLOR = 0x1e3324;   // trees
const RTS_MINIMAP_ROCK_COLOR = 0x5b6166;   // rocks
const RTS_MINIMAP_UNIT_DOT = 2;         // unit dot, px of the 220 px layout
const RTS_MINIMAP_BUILDING_DOT = 4;     // minimum building square, px of the 220 px layout
const RTS_MINIMAP_RESOURCE_DOT = 3;     // crystal diamond, px of the 220 px layout
const RTS_MINIMAP_PICK_RADIUS = 4;      // click pick radius, px of the 220 px layout
const RTS_MINIMAP_VIEW_COLOR = 0xffffff; // camera footprint colour
const RTS_MINIMAP_VIEW_ALPHA = 0.8;     // camera footprint opacity
const RTS_MINIMAP_TOUCH_HOLD_SEC = 0.5; // long tap that issues an order, s
const RTS_MINIMAP_TOUCH_MOVE_PX = 10;   // movement that cancels a long tap, px

// --- CAMERA (CameraControl.js): target on the map, azimuth, pitch and zoom. Zoom is
// screen px per world px at the look-at point; distance is derived from it. Flight
// (WASD, Q/E) lifts the look-at point off the ground. ---
const CAMERA_FOV_DEG = 52;              // vertical field of view
const CAMERA_AZIMUTH_DEG = -90;         // where the camera looks on the map: −90 — north up, 0 — east up
const CAMERA_PITCH_DEG = 56;            // pitch toward the ground: 90 — straight from above, less — more perspective
const CAMERA_ZOOM = 1;                  // starting zoom: PC and tablets
const CAMERA_ZOOM_MOBILE = 0.8;         // starting zoom: phones (longer screen side < 1024)
const CAMERA_ZOOM_MIN = 0.72;           // wheel and pinch won't zoom out further: about 24% closer than the old far limit (below this the ground edge gets into the frame)
const CAMERA_ZOOM_MAX = 2.4;            // won't zoom in closer
const CAMERA_ZOOM_WHEEL_STEP = 0.12;    // fraction of zoom per one wheel notch
const CAMERA_ZOOM_LERP = 0.18;          // zoom smoothing: fraction of the remainder per frame
const CAMERA_FOLLOW_LERP = 0.05;        // following an object (follow): fraction of the remainder per frame
const CAMERA_FLY_SPEED = 700;           // camera speed on WASD, arrows and Q/E: screen px/s (over the world — divided by zoom)
const CAMERA_EDGE_SCROLL = 1;           // game camera: 1 — the pointer near the screen edge pans the camera, 0 — off
const CAMERA_EDGE_MARGIN_PX = 12;       // width of the edge-scroll band: full speed starts here, before the browser's own edge triggers
const CAMERA_EDGE_SPEED = 800;          // edge scrolling speed inside the band: screen px/s (over the world — divided by zoom)
const CAMERA_LIMITS = 1;                // game camera limits: 0 — free flight, 1 — pitch within CAMERA_ORBIT_PITCH_*, target inside the location, flight ceiling; the ground edge stays out of the frame
const CAMERA_LIFT_MAX = 250;            // px, with limits: how high above the ground flight lifts the look-at point (higher — the ground edge gets into the frame)
const CAMERA_ORBIT = 0;                 // camera rotation by the player (RMB is the RTS command button): 0 — orientation fixed
const CAMERA_ORBIT_DEG_PER_PX = 0.3;    // degrees of rotation per screen px of drag
const CAMERA_ORBIT_PITCH_MIN_DEG = 38;  // with limits: won't go lower toward the ground (the limit also rises on its own — ground edge stays out of the frame)
const CAMERA_ORBIT_PITCH_MAX_DEG = 82;  // with limits: higher — almost straight from above

// --- RENDER (World3D.js): light, shadows, sky, materials, toon and ink edges. Read by
// World3D.cfg(); the editor applies edits to the live scene. ---
// One sun for the whole world. Azimuth — WHERE the shadow falls on the map (0 — right, 90 — down).
const WORLD3D_SUN_AZIMUTH_DEG = 32;
const WORLD3D_SUN_ELEVATION_DEG = 41;   // sun elevation above the horizon
const WORLD3D_SUN_INTENSITY = 0.8;      // sun strength (with the sky it sums to ~1.0 on flat ground — texture colors unchanged)
const WORLD3D_SUN_COLOR = 0xffedc7;     // sun color
const WORLD3D_SKYLIGHT_INTENSITY = 0.45; // diffuse sky light (hemispheric light source)
const WORLD3D_SKYLIGHT_COLOR = 0xb1d8f7; // sky light color (faces looking up)
const WORLD3D_GROUNDLIGHT_COLOR = 0xc2c7ad; // fill light from below (reflection off the ground)
const WORLD3D_SKY_COLOR = 0x8fc3e0;     // sky and fog color
const WORLD3D_FOG_DENSITY = 0.00005;    // exponential fog toward the horizon (0 — off)
// Shadows: one color for all (painted by the toon plugin, Babylon only provides sun visibility)
const WORLD3D_SHADOW_COLOR = 0x0f3a4d;  // shadow color
const WORLD3D_SHADOW_STRENGTH = 0.52;    // shadow strength 0..1: a surface in shadow is multiplied by a blend of white and the shadow color
const WORLD3D_SHADOW_SOFT = 2;          // edge: 0 — hard (for toon), 1..3 — PCF low/medium/high (mobile — no higher than 1)
const WORLD3D_SHADOW_MAP = 1024;        // shadow map size (mobile — half as large); takes effect with a new scene
const WORLD3D_SHADOW_RADIUS = 840;      // px: LIMIT of the shadow ortho frustum half-size; the frustum itself shrinks to the objects in the frame
const WORLD3D_SHADOW_BIAS = 0.001;     // depth bias against shadow acne (shadow stripes on lit faces)
const WORLD3D_SHADOW_NORMAL_BIAS = 0.8; // bias along the normal against shadow acne (stripes and sawtooth on faces at an acute angle to the sun), in shadow map texels on top of the edge smoothing radius (the engine adds it)
// Materials by group (specular highlight — fraction 0..1, size — exponent: larger — smaller highlight)
const WORLD3D_GROUND_SPECULAR = 0;      // ground specular highlight (0 — matte)
const WORLD3D_GROUND_SPEC_POWER = 1;    // ground specular highlight size
const WORLD3D_OUTER_TINT = 1;           // ground brightness BEYOND the location edge (less than 1 — the location boundary is visible)
const WORLD3D_PROP_SPECULAR = 0.05;     // environment specular highlight (group 'prop')
const WORLD3D_PROP_SPEC_POWER = 7;     // environment specular highlight size
const WORLD3D_ACTOR_SPECULAR = 0;       // main objects specular highlight (group 'actor'); with toon — toon glint brightness
const WORLD3D_ACTOR_SPEC_POWER = 23;    // main objects specular highlight size
// Toon shader (ArcToonPlugin): light from all sources (sun + sky, with shadow) is quantized into bands
const WORLD3D_TOON = 1;                 // 1 — toon shading with the silhouette outline and the edge lines, 0 — regular smooth shading without them
const WORLD3D_TOON_BANDS = 4;           // number of light bands (2..6)
const WORLD3D_TOON_SOFT = 0.02;         // band boundary softness (0 — sharp, 0.5 — almost smooth)
const WORLD3D_TOON_LOW = 0.48;          // brightness of the darkest band (fraction of full)
const WORLD3D_TOON_GROUND = 0;          // 1 — bands on the ground too, 0 — ground is shaded smoothly (terrain relief must not read as light spots)
const WORLD3D_TOON_SPEC = 0.25;            // toon glint highlight strength (0 — no highlight)
const WORLD3D_TOON_SPEC_SIZE = 0.075;    // highlight threshold (smaller — larger spot)
const WORLD3D_TOON_RIM = 0.28;           // bright rim light along the objects' silhouette edge (0 — none)
const WORLD3D_TOON_RIM_WIDTH = 0.24;    // rim light width
// Ink edges (EdgesRenderer): edges creased more sharply than the threshold — on every object of
// the scene, a skinned character too (its lines follow the bones). Only when WORLD3D_TOON = 1
const WORLD3D_TOON_INK = 2;             // 0 — none, 1 — main objects, 2 — environment too (only when WORLD3D_TOON = 1)
const WORLD3D_TOON_INK_WIDTH = 20;      // line thickness (≈ world px × 100; thinner as the camera moves away)
const WORLD3D_TOON_INK_COLOR = 0x171717; // ink color: ink edges and silhouette outline
const WORLD3D_TOON_INK_ANGLE = 40;      // °: an edge is drawn if the faces are creased more sharply
// Outer silhouette outline: post-effect (HighlightLayer, isStroke), thickness — in screen px
const WORLD3D_TOON_OUTLINE = 2;         // 0 — none, 1 — main objects, 2 — environment too (only when WORLD3D_TOON = 1)
const WORLD3D_TOON_OUTLINE_ACTOR_WIDTH = 1;   // screen px: main objects outline
const WORLD3D_TOON_OUTLINE_PROP_WIDTH = 1;  // screen px: environment outline (there is a lot of it in the frame — thinner)
