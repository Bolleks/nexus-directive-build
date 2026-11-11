// Game.js — the game entry point. main.js creates it after the location and camera and
// calls update(dt) every frame before the render. The RTS vertical slice lives in RTSGame.
// The console handle is window.app.game.world (units, buildings, resources, selection, AI).
class Game {
    /** @param {{ location: Location3D, camera: CameraController }} app */
    constructor(app) {
        this.app = app;
        this.rts = null;
        this.world = null;
        this.mapSize = typeof RTS_MAP_SIZE_MEDIUM !== 'undefined' ? RTS_MAP_SIZE_MEDIUM : 400;
        this._audioOpen = false;
        this._bindAudioSettings();
        this._bindStartScreen();
    }

    // The three sliders of the "sound" panel: a trim of each channel over its AUDIO_* volume,
    // stored through Store so the mix survives a reload. The panel sits above the start screen.
    _bindAudioSettings() {
        const btn = UI.get('audioBtn');
        if (btn) btn.onClick(() => this._toggleAudio());
        const channels = [
            { channel: 'sfx', slider: 'sfxVolume', label: 'sfxVolumeVal', key: 'audio.sfx' },
            { channel: 'voice', slider: 'voiceVolume', label: 'voiceVolumeVal', key: 'audio.voice' },
            { channel: 'music', slider: 'musicVolume', label: 'musicVolumeVal', key: 'audio.music' },
        ];
        for (const ch of channels) {
            const raw = Store.get(ch.key);
            const n = raw == null ? NaN : Number(raw);
            const value = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
            Sound3D.setChannelVolume(ch.channel, value);
            this._setAudioLabel(ch.label, value);
            const slider = UI.get(ch.slider);
            if (!slider) continue;
            slider.setValue(value);
            slider.onChange((v) => {
                Sound3D.setChannelVolume(ch.channel, v);
                Store.set(ch.key, String(v));
                this._setAudioLabel(ch.label, v);
            });
        }
    }

    _setAudioLabel(id, value) {
        const label = UI.get(id);
        if (label) label.setText(Math.round(value * 100) + '%');
    }

    // The "sound" button toggles the panel; open === false closes it (the match start).
    _toggleAudio(open) {
        this._audioOpen = open == null ? !this._audioOpen : !!open;
        const panel = UI.get('audioPanel');
        if (panel) panel.show(this._audioOpen);
        if (this.rts && this.rts.world && this.rts.world.audio) this.rts.world.audio.ui();
    }

    _bindStartScreen() {
        const small = typeof RTS_MAP_SIZE_SMALL !== 'undefined' ? RTS_MAP_SIZE_SMALL : 200;
        const medium = typeof RTS_MAP_SIZE_MEDIUM !== 'undefined' ? RTS_MAP_SIZE_MEDIUM : 400;
        const large = typeof RTS_MAP_SIZE !== 'undefined' ? RTS_MAP_SIZE : 600;
        const choose = (size) => {
            this.mapSize = size;
            const setLabel = (id, value, label) => {
                const el = UI.get(id);
                if (el) el.setText((value === size ? '● ' : '') + label + ' · ' + value + ' × ' + value);
            };
            setLabel('sizeSmall', small, 'МАЛАЯ');
            setLabel('sizeMedium', medium, 'СРЕДНЯЯ');
            setLabel('sizeLarge', large, 'БОЛЬШАЯ');
            const info = UI.get('startInfo');
            if (info) info.setText(this._mapInfo(size, small, medium));
        };
        const bind = (id, size) => {
            const el = UI.get(id);
            if (el) el.onClick(() => choose(size));
        };
        bind('sizeSmall', small);
        bind('sizeMedium', medium);
        bind('sizeLarge', large);
        const start = UI.get('startBtn');
        if (start) start.onClick(() => this._startFromMenu());
        choose(this.mapSize);
    }

    _mapInfo(size, small, medium) {
        const fields = typeof RTSMap !== 'undefined' && RTSMap.resourceCountForSize
            ? RTSMap.resourceCountForSize(size)
            : size <= small ? 6 : size <= medium ? 12 : 18;
        const pace = size <= small ? 'быстрый матч' : size <= medium ? 'сбалансированный матч' : 'просторная карта';
        return size + ' × ' + size + ' · ' + fields + ' кристальных жил · обломки звездолёта · ' + pace;
    }

    _startFromMenu() {
        if (this.rts) return;
        this._enterFullscreen();
        const dim = UI.get('startDim');
        if (dim) dim.show(false);
        const panel = UI.get('startPanel');
        if (panel) panel.show(false);
        this._toggleAudio(false);
        this.start(this.mapSize);
    }

    // The match starts on the player's click — the one moment the browser allows the
    // Fullscreen API. The real fullscreen hides the address bar and the tab strip, so
    // moving the mouse to the top edge no longer wakes the browser chrome. Refused
    // (iframe without the permission, an old browser) — the game simply stays windowed.
    _enterFullscreen() {
        const doc = document;
        if (doc.fullscreenElement) return;
        try {
            const p = doc.documentElement.requestFullscreen();
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (err) { /* not allowed here */ }
    }

    start(mapSize) {
        const size = Math.max(40, Math.round(Number(mapSize) || this.mapSize));
        const scale = typeof RTS_WORLD_SCALE !== 'undefined' ? RTS_WORLD_SCALE : 8;
        const world = size * scale;
        const location = this.app.location;
        if (location && typeof location.setSize === 'function' &&
            (location.width !== world || location.height !== world)) {
            location.setSize(world, world);
        }
        if (location && this.app.camera && typeof this.app.camera.setTerrain === 'function') {
            this.app.camera.setTerrain(location.terrain, { w: world, h: world });
        }
        this.mapSize = size;
        this.rts = new RTSGame(this.app, { mapSize: size });
        this.world = this.rts.world;
    }

    update(dt) {
        if (this.rts) this.rts.update(dt);
    }
}
