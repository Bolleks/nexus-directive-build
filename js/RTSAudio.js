// RTSAudio.js — the RTS demo's sound effects: a thin layer over Sound3D with one method per
// game event. The simulation calls these; this file decides the file, the map point and the
// rate limit. Paths are LITERAL: the builder's asset scanner archives only those (skill sound).
//
//     select()             — selecting a unit, a building or a crystal field
//     order(kind, x, y)    — 'move' | 'attack' | 'gather' at a map point
//     buildStart / buildDone / ready — construction and production
//     shot / impact / explode — combat
//     error / alert / end  — UI feedback, an enemy wave, the result screen
//     announce(key)        — one line of the field commander's voice (RTS_VOICE_LINES)
//     musicStart / musicStop — the looped battle theme (one track for the match)
//
// A sound on the map is heard from WHERE THE CAMERA IS (Sound3D.update). A UI sound carries
// no position. Combat sounds are rate-limited: a whole army firing at once must not become
// a wall of copies (RTS_SFX_*_GAP in Constants.js). Voice lines are also a queue: one at a
// time, urgent reports first, so a burst of events does not turn into a monologue. Every
// voice line comes over the radio: it carries no map position, so its volume does not depend
// on where the speaker stands.

/** @type {Record<string, { src: string, priority: number, gap?: number }>} */
const RTS_VOICE_LINES = {
    buildStart: { src: 'assets/sounds/voice_build_start.wav', priority: 1 },
    buildDone: { src: 'assets/sounds/voice_build_done.wav', priority: 2 },
    buildingAttack: {
        src: 'assets/sounds/voice_building_attack.wav', priority: 3,
        gap: typeof RTS_VOICE_ATTACK_GAP_SEC !== 'undefined' ? RTS_VOICE_ATTACK_GAP_SEC : 12,
    },
    hqAttack: {
        src: 'assets/sounds/voice_hq_attack.wav', priority: 4,
        gap: typeof RTS_VOICE_ATTACK_GAP_SEC !== 'undefined' ? RTS_VOICE_ATTACK_GAP_SEC : 12,
    },
    buildingLost: {
        src: 'assets/sounds/voice_building_lost.wav', priority: 3,
        gap: typeof RTS_VOICE_LOSS_GAP_SEC !== 'undefined' ? RTS_VOICE_LOSS_GAP_SEC : 5,
    },
    demolishStart: { src: 'assets/sounds/voice_demolish_start.wav', priority: 1 },
    demolishDone: { src: 'assets/sounds/voice_demolish_done.wav', priority: 2 },
    unitReady: {
        src: 'assets/sounds/voice_unit_ready.wav', priority: 2,
        gap: typeof RTS_VOICE_READY_GAP_SEC !== 'undefined' ? RTS_VOICE_READY_GAP_SEC : 2,
    },
};

// Unit replies: every unit type answers on its own radio, with its own voice and its own three
// lines (tools/make-voice.mjs, all through the narrow-band radio effect). Keys are the unit
// types of RTSData.UNITS. A unit line plays beside the commander's queue, on the same 'voice'
// channel, and its own gap keeps a whole squad from talking at once.
/** @type {Record<string, { select: string, hurt: string, order: string }>} */
const RTS_UNIT_VOICE = {
    worker: {
        select: 'assets/sounds/voice_builder_select.wav',
        hurt: 'assets/sounds/voice_builder_hurt.wav',
        order: 'assets/sounds/voice_builder_order.wav',
    },
    infantry: {
        select: 'assets/sounds/voice_infantry_select.wav',
        hurt: 'assets/sounds/voice_infantry_hurt.wav',
        order: 'assets/sounds/voice_infantry_order.wav',
    },
    scout: {
        select: 'assets/sounds/voice_scout_select.wav',
        hurt: 'assets/sounds/voice_scout_hurt.wav',
        order: 'assets/sounds/voice_scout_order.wav',
    },
    grenadier: {
        select: 'assets/sounds/voice_grenadier_select.wav',
        hurt: 'assets/sounds/voice_grenadier_hurt.wav',
        order: 'assets/sounds/voice_grenadier_order.wav',
    },
    siege: {
        select: 'assets/sounds/voice_siege_select.wav',
        hurt: 'assets/sounds/voice_siege_hurt.wav',
        order: 'assets/sounds/voice_siege_order.wav',
    },
};

class RTSAudio {
    /** @param {RTSWorld} world */
    constructor(world) {
        this.world = world;
        /** @type {Record<string, number>} */
        this._last = Object.create(null);
        /** Units that have already called out their first hit. */
        this._hurtSaid = new WeakSet();
        this.voice = new RTSVoice(this);

        // Preload every effect once, so the first shot does not arrive a frame late.
        const files = [
            'assets/sounds/rts_select.wav',
            'assets/sounds/rts_order_move.wav',
            'assets/sounds/rts_order_attack.wav',
            'assets/sounds/rts_order_gather.wav',
            'assets/sounds/rts_shot.wav',
            'assets/sounds/blaster.ogg',
            'assets/sounds/rts_hit.wav',
            'assets/sounds/rts_explode.wav',
            'assets/sounds/grenade_launch.wav',
            'assets/sounds/grenade_explosion.wav',
            'assets/sounds/rts_build.wav',
            'assets/sounds/rts_ready.wav',
            'assets/sounds/rts_error.wav',
            'assets/sounds/rts_alert.wav',
            'assets/sounds/rts_victory.wav',
            'assets/sounds/rts_defeat.wav',
            'assets/sounds/rts_draw.wav',
        ];
        for (const line of Object.values(RTS_VOICE_LINES)) files.push(line.src);
        for (const line of Object.values(RTS_UNIT_VOICE)) files.push(line.select, line.hurt, line.order);
        for (const src of files) Sound3D.load(src);
    }

    // Map units -> world px: Sound3D and the camera both live in px.
    /** @param {number} x @param {number} y @returns {{ x: number, y: number }} */
    _at(x, y) {
        const scale = (this.world && this.world.map && this.world.map.scale) || RTS_WORLD_SCALE;
        return { x: x * scale, y: y * scale };
    }

    // True when this event may sound now: at most one copy per gap. The clock is the
    // simulation time, so a paused match does not let a burst through.
    /** @param {string} key @param {number} gap @returns {boolean} */
    _gate(key, gap) {
        const now = Number(this.world && this.world.time) || 0;
        const last = this._last[key];
        if (last != null && now - last < gap) return false;
        this._last[key] = now;
        return true;
    }

    // --- Voice ------------------------------------------------------------------

    // Queue a field commander line by key. Repeats inside the line's gap are dropped: a
    // building under fire reports once, not on every shot.
    /** @param {string} key */
    announce(key) {
        const line = RTS_VOICE_LINES[key];
        if (!line) return;
        if (line.gap && !this._gate('voice:' + key, line.gap)) return;
        this.voice.say(key);
    }

    /** @param {number} dt */
    update(dt) {
        this.voice.update(dt);
    }

    stopVoice() {
        this.voice.stop();
    }

    // --- Music -------------------------------------------------------------------

    // The battle theme: one looped track on the 'music' channel for the whole match.
    musicStart() {
        Sound3D.music('assets/sounds/rts_theme.mp3');
    }

    musicStop() {
        Sound3D.music(null);
    }

    // --- UI and orders -----------------------------------------------------------

    select() {
        Sound3D.play('assets/sounds/rts_select.wav');
    }

    // A click on a command button — the same soft tick, without a map position.
    ui() {
        Sound3D.play('assets/sounds/rts_select.wav');
    }

    /** @param {'move' | 'attack' | 'gather'} kind @param {number} x @param {number} y */
    order(kind, x, y) {
        const src = kind === 'attack' ? 'assets/sounds/rts_order_attack.wav'
            : kind === 'gather' ? 'assets/sounds/rts_order_gather.wav'
                : 'assets/sounds/rts_order_move.wav';
        Sound3D.play(src, this._at(x, y));
    }

    error() {
        Sound3D.play('assets/sounds/rts_error.wav');
    }

    // --- Unit chatter ------------------------------------------------------------

    // A unit answers on its own radio: selected, hit for the first time, given a point order.
    // Radio traffic is flat: a reply carries no map position and sounds equally loud wherever
    // the unit stands. These lines have their own gap, so a squad does not speak in unison,
    // and they never enter the commander's queue — a report stays the most important voice.

    /** @returns {number} */
    _unitGap() {
        return typeof RTS_UNIT_VOICE_GAP_SEC !== 'undefined' ? RTS_UNIT_VOICE_GAP_SEC : 1.2;
    }

    /** @returns {number} */
    _unitVolume() {
        return typeof RTS_UNIT_VOICE_VOLUME !== 'undefined' ? RTS_UNIT_VOICE_VOLUME : 0.7;
    }

    /** @param {string} type */
    unitSelect(type) {
        const line = RTS_UNIT_VOICE[type];
        if (!line) return;
        if (!this._gate('unit:select:' + type, this._unitGap())) return;
        Sound3D.play(line.select, { volume: this._unitVolume(), channel: 'voice' });
    }

    /** @param {{ type: string, x: number, y: number }} unit */
    unitHurt(unit) {
        if (!unit || !unit.type || this._hurtSaid.has(unit)) return;
        this._hurtSaid.add(unit);
        const line = RTS_UNIT_VOICE[unit.type];
        if (!line) return;
        if (!this._gate('unit:hurt', this._unitGap())) return;
        Sound3D.play(line.hurt, { volume: this._unitVolume(), channel: 'voice' });
    }

    /** @param {string} type @param {number} x @param {number} y */
    unitOrder(type, x, y) {
        const line = RTS_UNIT_VOICE[type];
        if (!line) return;
        if (!this._gate('unit:order:' + type, this._unitGap())) return;
        Sound3D.play(line.order, { volume: this._unitVolume(), channel: 'voice' });
    }

    // --- Economy and production --------------------------------------------------

    /** @param {number} x @param {number} y */
    buildStart(x, y) {
        Sound3D.play('assets/sounds/rts_build.wav', this._at(x, y));
    }

    /** @param {number} x @param {number} y */
    buildDone(x, y) {
        Sound3D.play('assets/sounds/rts_ready.wav', this._at(x, y));
    }

    /** @param {number} x @param {number} y */
    ready(x, y) {
        if (this._gate('ready', typeof RTS_SFX_READY_GAP !== 'undefined' ? RTS_SFX_READY_GAP : 0.3)) {
            Sound3D.play('assets/sounds/rts_ready.wav', this._at(x, y));
        }
    }

    // --- Combat ------------------------------------------------------------------

    /** @param {{ x: number, y: number, type?: string }} source @param {{ x: number, y: number }} target */
    shot(source, target) {
        if (this._gate('shot', typeof RTS_SFX_SHOT_GAP !== 'undefined' ? RTS_SFX_SHOT_GAP : 0.06)) {
            const src = source.type === 'infantry' ? 'assets/sounds/blaster.ogg'
                : source.type === 'grenadier' ? 'assets/sounds/grenade_launch.wav'
                    : 'assets/sounds/rts_shot.wav';
            Sound3D.play(src, this._at(source.x, source.y));
        }
    }

    /** @param {{ x: number, y: number }} target @param {string} [type] */
    impact(target, type) {
        if (this._gate('impact', typeof RTS_SFX_IMPACT_GAP !== 'undefined' ? RTS_SFX_IMPACT_GAP : 0.05)) {
            const src = type === 'grenadier' ? 'assets/sounds/grenade_explosion.wav' : 'assets/sounds/rts_hit.wav';
            Sound3D.play(src, this._at(target.x, target.y));
        }
    }

    /** @param {{ x: number, y: number }} entity */
    explode(entity) {
        Sound3D.play('assets/sounds/rts_explode.wav', this._at(entity.x, entity.y));
    }

    // --- Alerts and the result screen --------------------------------------------

    alert() {
        Sound3D.play('assets/sounds/rts_alert.wav');
    }

    /** @param {string} winner 'player' | 'enemy' | 'draw' */
    end(winner) {
        const src = winner === 'player' ? 'assets/sounds/rts_victory.wav'
            : winner === 'enemy' ? 'assets/sounds/rts_defeat.wav'
                : 'assets/sounds/rts_draw.wav';
        Sound3D.play(src);
    }
}

// The commander's voice: one line in the air, the rest in a short priority queue. A line ends
// when Sound3D's handle stops (played to the end or failed to load); a small gap follows so
// two reports never sound glued together.
class RTSVoice {
    /** @param {RTSAudio} audio */
    constructor(audio) {
        this.audio = audio;
        /** @type {{ key: string, handle: SoundHandle } | null} */
        this.current = null;
        /** @type {{ key: string, priority: number }[]} */
        this.queue = [];
        this.gap = 0;
    }

    /** @param {string} key */
    say(key) {
        const line = RTS_VOICE_LINES[key];
        if (!line) return;
        if (this.current && this.current.key === key) return;
        if (this.queue.some(e => e.key === key)) return;
        this.queue.push({ key, priority: line.priority });
        // Higher priority first; equal priorities keep the order they came in.
        this.queue.sort((a, b) => b.priority - a.priority);
        const max = typeof RTS_VOICE_QUEUE_MAX !== 'undefined' ? RTS_VOICE_QUEUE_MAX : 3;
        if (this.queue.length > max) this.queue.length = max;
        this.update(0);
    }

    /** @param {number} dt */
    update(dt) {
        if (this.current && !this.current.handle.playing) {
            this.current = null;
            this.gap = typeof RTS_VOICE_GAP_SEC !== 'undefined' ? RTS_VOICE_GAP_SEC : 0.25;
        }
        if (this.current) return;
        if (this.gap > 0) {
            this.gap -= Math.max(0, dt || 0);
            if (this.gap > 0) return;
        }
        const entry = this.queue.shift();
        if (!entry) return;
        const line = RTS_VOICE_LINES[entry.key];
        if (!line) return this.update(0);
        const volume = typeof RTS_VOICE_VOLUME !== 'undefined' ? RTS_VOICE_VOLUME : 0.9;
        this.current = { key: entry.key, handle: Sound3D.play(line.src, { volume, channel: 'voice' }) };
    }

    stop() {
        if (this.current) this.current.handle.stop();
        this.current = null;
        this.queue.length = 0;
        this.gap = 0;
    }
}
