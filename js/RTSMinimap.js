// RTSMinimap.js — the RTS minimap: a 2D canvas HUD element (UI kind 'canvas') that shows
// the board, fog of war, units/buildings/resources and the camera footprint. Input:
// LMB/tap drives the camera, RMB/long tap issues a context order to the selection.
// No simulation rules live here: orders go through RTSWorld, the camera through CameraController.

class RTSMinimap {
    /** @param {RTSWorld} world */
    constructor(world) {
        this.world = world;
        this.id = 'minimap';
        /** @type {UIElement | null} */
        this.element = null;
        /** @type {HTMLCanvasElement | null} */
        this.canvas = null;
        /** @type {CanvasRenderingContext2D | null} */
        this.ctx = null;
        this.enabled = true;
        /** @type {any} */
        this._bound = null;
        /** @type {number | null} */
        this._pointerId = null;
        this._mode = '';
        /** @type {{ x: number, y: number, mx: number, my: number } | null} */
        this._start = null;
        /** @type {any} */
        this._holdTimer = 0;
        this._holdFired = false;
        this._moved = false;

        this._static = document.createElement('canvas');
        /** @type {CanvasRenderingContext2D | null} */
        this._staticCtx = this._static.getContext('2d');
        /** @type {HTMLCanvasElement | null} */
        this._relief = null;
        this._fog = document.createElement('canvas');
        /** @type {CanvasRenderingContext2D | null} */
        this._fogCtx = this._fog.getContext('2d');
        /** @type {ImageData | null} */
        this._fogImage = null;
        this._fogVersion = -1;
        this._fogReady = false;
        this._side = 0;
        this._ox = 0;
        this._oy = 0;
        this._w = 0;
        this._h = 0;
        this._viewKey = '';
        /** @type {{ x: number, y: number }[] | null} */
        this._viewport = null;
        /** @type {any} */
        this._colors = null;

        if (!this._staticCtx || !this._fogCtx) {
            this.enabled = false;
            return;
        }
        this._syncElement();
    }

    // --- Element -----------------------------------------------------------------

    _syncElement() {
        const element = UI.get(this.id);
        if (!element || !element.canvas) {
            this._clearTouch();
            this.element = null;
            this.canvas = null;
            this.ctx = null;
            return false;
        }
        if (element === this.element && element.canvas === this.canvas) return !!this.ctx;
        this._clearTouch();
        this._unbind();
        this.element = element;
        this.canvas = element.canvas;
        this.ctx = this.canvas.getContext('2d');
        this._bind();
        this._side = 0;
        return !!this.ctx;
    }

    _bind() {
        const c = this.canvas;
        if (!c) return;
        const b = this._bound = {
            down: (e) => this._onDown(e),
            move: (e) => this._onMove(e),
            up: (e) => this._onUp(e),
            cancel: (e) => this._onCancel(e),
            menu: (e) => e.preventDefault()
        };
        c.addEventListener('pointerdown', b.down);
        c.addEventListener('pointermove', b.move);
        c.addEventListener('pointerup', b.up);
        c.addEventListener('pointercancel', b.cancel);
        c.addEventListener('contextmenu', b.menu);
        c.style.touchAction = 'none';
    }

    _unbind() {
        const c = this.canvas, b = this._bound;
        if (c && b) {
            c.removeEventListener('pointerdown', b.down);
            c.removeEventListener('pointermove', b.move);
            c.removeEventListener('pointerup', b.up);
            c.removeEventListener('pointercancel', b.cancel);
            c.removeEventListener('contextmenu', b.menu);
        }
        this._bound = null;
        this._clearTouch();
    }

    // --- Public frame ------------------------------------------------------------

    update(dt) {
        if (!this.enabled) return;
        if (!this._syncElement()) return;
        const element = this.element;
        if (!element || !element.visible || !this.ctx) return;
        const c = this.canvas;
        if (!c || c.clientWidth < 2 || c.clientHeight < 2) return;
        if (!this.world.running) this._clearTouch();
        try {
            this._resize();
            this._draw();
        } catch (err) {
            this.enabled = false;
            console.warn('[RTS] minimap disabled:', err);
        }
    }

    // --- Sizing ------------------------------------------------------------------

    _resize() {
        const c = this.canvas;
        const scale = UI.scale() || 1;
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const w = Math.max(1, Math.round(c.clientWidth * scale * dpr));
        const h = Math.max(1, Math.round(c.clientHeight * scale * dpr));
        if (w === this._w && h === this._h && this._side > 0) return;
        this._w = w;
        this._h = h;
        c.width = w;
        c.height = h;
        this._side = Math.max(1, Math.min(w, h));
        this._ox = Math.floor((w - this._side) / 2);
        this._oy = Math.floor((h - this._side) / 2);
        this._buildStatic();
        this._viewKey = '';
    }

    _mapSize() { return this.world.map.size; }

    // --- Static background -------------------------------------------------------

    _buildStatic() {
        const side = this._side;
        const s = this._static;
        s.width = side;
        s.height = side;
        const ctx = this._staticCtx;
        const colors = this._colors = this._colors || this._makeColors();
        ctx.fillStyle = colors.ground;
        ctx.fillRect(0, 0, side, side);
        if (this._reliefOn()) this._drawRelief(ctx, side);
        this._drawWater(ctx, side);
        this._drawScenery(ctx, side);
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = Math.max(1, side / 220);
        ctx.strokeRect(0.5, 0.5, side - 1, side - 1);
    }

    _reliefOn() {
        return (typeof RTS_MINIMAP_RELIEF !== 'undefined' ? RTS_MINIMAP_RELIEF : 1) > 0;
    }

    _makeColors() {
        const hex = (value, fallback) => {
            const n = typeof value !== 'undefined' ? value : fallback;
            return '#' + ('000000' + (Number(n) >>> 0).toString(16)).slice(-6);
        };
        return {
            ground: hex(typeof RTS_MINIMAP_GROUND_COLOR !== 'undefined' ? RTS_MINIMAP_GROUND_COLOR : 0x2f4433, 0x2f4433),
            groundHigh: hex(typeof RTS_MINIMAP_GROUND_HIGH !== 'undefined' ? RTS_MINIMAP_GROUND_HIGH : 0x43573c, 0x43573c),
            tree: hex(typeof RTS_MINIMAP_TREE_COLOR !== 'undefined' ? RTS_MINIMAP_TREE_COLOR : 0x1e3324, 0x1e3324),
            rock: hex(typeof RTS_MINIMAP_ROCK_COLOR !== 'undefined' ? RTS_MINIMAP_ROCK_COLOR : 0x5b6166, 0x5b6166),
            border: 'rgba(217, 230, 176, 0.35)',
            neutral: RTS_DATA.COLORS.neutral,
            player: RTS_DATA.COLORS.player,
            enemy: RTS_DATA.COLORS.enemy,
            select: hex(typeof RTS_SELECT_COLOR !== 'undefined' ? RTS_SELECT_COLOR : 0x74ff9a, 0x74ff9a),
            view: hex(typeof RTS_MINIMAP_VIEW_COLOR !== 'undefined' ? RTS_MINIMAP_VIEW_COLOR : 0xffffff, 0xffffff),
            fog: hex(typeof RTS_FOG_COLOR !== 'undefined' ? RTS_FOG_COLOR : 0x081018, 0x081018),
            water: '#2b7dff'
        };
    }

    _drawRelief(ctx, side) {
        const n = this._mapSize();
        const scale = this.world.map.scale;
        const terrain = this.world.app.location.terrain;
        if (!terrain || !terrain.heightAt) return;
        const grid = 96;
        if (!this._relief) {
            this._relief = document.createElement('canvas');
            this._relief.width = grid;
            this._relief.height = grid;
            const rc = this._relief.getContext('2d');
            const img = rc.createImageData(grid, grid);
            const data = img.data;
            const lo = Number.isFinite(terrain.hMin) ? terrain.hMin : -12;
            const hi = Number.isFinite(terrain.hMax) ? terrain.hMax : 12;
            const span = Math.max(1, hi - lo);
            const c0 = this._rgb(this._colors.ground);
            const c1 = this._rgb(this._colors.groundHigh);
            for (let y = 0; y < grid; y++) {
                for (let x = 0; x < grid; x++) {
                    const wx = ((x + 0.5) / grid) * n * scale;
                    const wy = ((y + 0.5) / grid) * n * scale;
                    const t = Math.max(0, Math.min(1, (terrain.heightAt(wx, wy) - lo) / span));
                    const o = (y * grid + x) * 4;
                    data[o] = c0[0] + (c1[0] - c0[0]) * t;
                    data[o + 1] = c0[1] + (c1[1] - c0[1]) * t;
                    data[o + 2] = c0[2] + (c1[2] - c0[2]) * t;
                    data[o + 3] = 255;
                }
            }
            rc.putImageData(img, 0, 0);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this._relief, 0, 0, side, side);
    }

    _rgb(hex) {
        const m = /^#([0-9a-f]{6})$/i.exec(hex);
        const n = m ? parseInt(m[1], 16) : 0;
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    _drawWater(ctx, side) {
        const n = this._mapSize();
        const water = this.world.map.relief ? this.world.map.relief.water : [];
        ctx.fillStyle = this._colors.water;
        ctx.globalAlpha = 0.72;
        for (const w of water) {
            ctx.beginPath();
            ctx.arc((w.x / n) * side, (w.y / n) * side, (w.radius / n) * side, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    _drawScenery(ctx, side) {
        const n = this._mapSize();
        const dot = Math.max(1, Math.round(side / 220));
        for (const o of this.world.map.obstacles) {
            ctx.fillStyle = o.kind === 'tree' ? this._colors.tree : this._colors.rock;
            ctx.fillRect((o.x / n) * side, (o.y / n) * side, dot, dot);
        }
    }

    // --- Fog ---------------------------------------------------------------------

    _updateFog() {
        const vision = this.world.vision;
        if (!vision) return;
        if (this._fogVersion === vision.version) return;
        this._fogVersion = vision.version;
        const n = this._mapSize();
        const f = 128;
        const fog = this._fog;
        if (fog.width !== f || fog.height !== f) {
            fog.width = f;
            fog.height = f;
            this._fogImage = null;
        }
        const ctx = this._fogCtx;
        if (!this._fogImage) this._fogImage = ctx.createImageData(f, f);
        const data = this._fogImage.data;
        const rgb = this._rgb(this._colors.fog);
        const explored = Math.max(0, Math.min(1, typeof RTS_FOG_EXPLORED_ALPHA !== 'undefined' ? RTS_FOG_EXPLORED_ALPHA : 0.55));
        const unexplored = Math.max(0, Math.min(1, typeof RTS_FOG_UNEXPLORED_ALPHA !== 'undefined' ? RTS_FOG_UNEXPLORED_ALPHA : 1));
        const vis = vision.visible.player, exp = vision.explored.player;
        const step = n / f;
        for (let y = 0; y < f; y++) {
            const sy = Math.min(n - 1, Math.floor((y + 0.5) * step));
            for (let x = 0; x < f; x++) {
                const sx = Math.min(n - 1, Math.floor((x + 0.5) * step));
                const i = sy * n + sx;
                const a = vis[i] ? 0 : (exp[i] ? explored : unexplored);
                const o = (y * f + x) * 4;
                data[o] = rgb[0];
                data[o + 1] = rgb[1];
                data[o + 2] = rgb[2];
                data[o + 3] = Math.round(a * 255);
            }
        }
        ctx.putImageData(this._fogImage, 0, 0);
        this._fogReady = true;
    }

    // --- Entities ----------------------------------------------------------------

    _visible(e) {
        if (!e || !e.isAlive) return false;
        const vision = this.world.vision;
        if (!vision) return true;
        return vision.canSelect('player', e);
    }

    _drawEntities(ctx, side) {
        const n = this._mapSize();
        const at = (x, y) => RTSMinimap.mapToCanvas(x, y, n, side);
        const unit = (typeof RTS_MINIMAP_UNIT_DOT !== 'undefined' ? RTS_MINIMAP_UNIT_DOT : 2) / 220 * side;
        const building = (typeof RTS_MINIMAP_BUILDING_DOT !== 'undefined' ? RTS_MINIMAP_BUILDING_DOT : 4) / 220 * side;
        const resource = (typeof RTS_MINIMAP_RESOURCE_DOT !== 'undefined' ? RTS_MINIMAP_RESOURCE_DOT : 3) / 220 * side;
        for (const r of this.world.resources) {
            if (!r.isAlive || r.amount <= 0 || !this._visible(r)) continue;
            const p = at(r.x, r.y), d = Math.max(1, resource);
            ctx.fillStyle = this._colors.neutral;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y - d);
            ctx.lineTo(p.x + d, p.y);
            ctx.lineTo(p.x, p.y + d);
            ctx.lineTo(p.x - d, p.y);
            ctx.closePath();
            ctx.fill();
        }
        for (const w of this.world.wrecks || []) {
            if (!w.isAlive || !this._visible(w)) continue;
            const p = at(w.x, w.y), d = Math.max(2, side / 160);
            ctx.fillStyle = this._colors.neutral;
            ctx.fillRect(p.x - d, p.y - d, d * 2, d * 2);
        }
        for (const b of this.world.buildings) {
            if (!b.isAlive || !this._visible(b)) continue;
            const p = at(b.x, b.y);
            const fp = b.footprint || [2, 2];
            const d = Math.max(building, (Math.max(fp[0], fp[1]) / n) * side);
            ctx.fillStyle = b.team === 'player' ? this._colors.player : this._colors.enemy;
            if (b.isBuilt) {
                ctx.fillRect(p.x - d / 2, p.y - d / 2, d, d);
            } else {
                ctx.lineWidth = Math.max(1, d / 3);
                ctx.strokeStyle = ctx.fillStyle;
                ctx.strokeRect(p.x - d / 2, p.y - d / 2, d, d);
            }
        }
        for (const u of this.world.units) {
            if (!u.isAlive || !this._visible(u)) continue;
            const p = at(u.x, u.y), d = Math.max(1, unit);
            ctx.fillStyle = u.team === 'player' ? this._colors.player : this._colors.enemy;
            ctx.fillRect(p.x - d / 2, p.y - d / 2, d, d);
        }
    }

    _drawSelection(ctx, side) {
        const n = this._mapSize();
        const list = this.world.selected || [];
        if (!list.length) return;
        const at = (x, y) => RTSMinimap.mapToCanvas(x, y, n, side);
        ctx.strokeStyle = this._colors.select;
        ctx.lineWidth = Math.max(1, side / 220);
        for (const e of list) {
            if (!e || !e.isAlive) continue;
            const p = at(e.x, e.y);
            const r = Math.max(2, (e.kind === 'building' ? Math.max(e.footprint[0], e.footprint[1]) * 0.5 : e.radius || 1) / n * side);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + Math.max(1, side / 220), 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    // --- Camera footprint --------------------------------------------------------

    _updateViewport() {
        const camera = this.world.app.camera;
        const view = this.world.app.location.view;
        if (!camera || !view) { this._viewport = null; return; }
        const cv = view.world.canvas;
        if (!cv) { this._viewport = null; return; }
        const key = camera.viewVersion + ':' + cv.clientWidth + 'x' + cv.clientHeight;
        if (key === this._viewKey) return;
        view.refreshMatrices();
        const terrain = this.world.app.location.terrain;
        const h = camera.target ? camera.target.h : 0;
        const W = cv.clientWidth, H = cv.clientHeight;
        const corners = [[0, 0], [W, 0], [W, H], [0, H]];
        const out = [];
        for (const [px, py] of corners) {
            const hit = view.pointerToGround(px, py, h, terrain);
            if (!hit) { this._viewport = null; this._viewKey = ''; return; }
            out.push({ x: hit.x / this.world.map.scale, y: hit.y / this.world.map.scale });
        }
        this._viewport = out;
        this._viewKey = key;
    }

    _drawViewport(ctx, side) {
        const v = this._viewport;
        if (!v) return;
        const n = this._mapSize();
        const at = (x, y) => RTSMinimap.mapToCanvas(x, y, n, side);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, side, side);
        ctx.clip();
        ctx.strokeStyle = this._colors.view;
        ctx.globalAlpha = Math.max(0, Math.min(1, typeof RTS_MINIMAP_VIEW_ALPHA !== 'undefined' ? RTS_MINIMAP_VIEW_ALPHA : 0.8));
        ctx.lineWidth = Math.max(1, side / 220);
        ctx.beginPath();
        const first = at(v[0].x, v[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < v.length; i++) {
            const p = at(v[i].x, v[i].y);
            ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }

    // --- Draw --------------------------------------------------------------------

    _draw() {
        const ctx = this.ctx, side = this._side;
        ctx.clearRect(0, 0, this._w, this._h);
        ctx.drawImage(this._static, this._ox, this._oy);
        ctx.save();
        ctx.translate(this._ox, this._oy);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, side, side);
        ctx.clip();
        this._drawEntities(ctx, side);
        this._updateFog();
        if (this._fogReady) {
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(this._fog, 0, 0, side, side);
        }
        this._drawSelection(ctx, side);
        ctx.restore();
        this._updateViewport();
        this._drawViewport(ctx, side);
        ctx.restore();
    }

    // --- Input -------------------------------------------------------------------

    _toMap(e) {
        const c = this.canvas;
        if (!c) return null;
        const r = c.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const side = Math.min(r.width, r.height);
        if (side <= 0) return null;
        const n = this._mapSize();
        const p = RTSMinimap.screenToMap(r, e.clientX, e.clientY, n, side);
        return { x: p.x, y: p.y };
    }

    _centerOn(mx, my) {
        const camera = this.world.app.camera;
        if (!camera) return;
        if (this.world.followSelection) this.world.setFollowSelection(false);
        camera.centerOn(mx * this.world.map.scale, my * this.world.map.scale);
    }

    _onDown(e) {
        if (!this.enabled || !this.world.running) return;
        if (!this._syncElement()) return;
        const p = this._toMap(e);
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ }
        if (e.pointerType === 'touch') {
            this._pointerId = e.pointerId;
            this._mode = 'touch';
            this._start = { x: e.clientX, y: e.clientY, mx: p.x, my: p.y };
            this._moved = false;
            this._holdFired = false;
            this._armHold();
            return;
        }
        if (e.button === 0) {
            this._pointerId = e.pointerId;
            this._mode = 'camera';
            this._centerOn(p.x, p.y);
            return;
        }
        if (e.button === 2) {
            this._contextOrder(p.x, p.y, e.shiftKey);
        }
    }

    _armHold() {
        this._clearHold();
        const sec = typeof RTS_MINIMAP_TOUCH_HOLD_SEC !== 'undefined' ? RTS_MINIMAP_TOUCH_HOLD_SEC : 0.5;
        this._holdTimer = setTimeout(() => {
            this._holdTimer = 0;
            if (!this._start || this._moved || !this.enabled || !this.world.running) return;
            const c = this.canvas;
            if (!c || c.clientWidth <= 0 || c.clientHeight <= 0) { this._clearTouch(); return; }
            this._holdFired = true;
            this._contextOrder(this._start.mx, this._start.my, false);
        }, Math.max(0.1, sec) * 1000);
    }

    _clearHold() {
        if (this._holdTimer) {
            clearTimeout(this._holdTimer);
            this._holdTimer = 0;
        }
    }

    _clearTouch() {
        this._clearHold();
        this._pointerId = null;
        this._mode = '';
        this._start = null;
        this._moved = false;
        this._holdFired = false;
    }

    _onMove(e) {
        if (!this._pointerId || e.pointerId !== this._pointerId) return;
        if (!this.enabled) { this._clearTouch(); return; }
        if (e.pointerType === 'mouse' && e.buttons === 0) { this._clearTouch(); return; }
        if (!this.world.running) { this._clearTouch(); return; }
        const p = this._toMap(e);
        if (!p) return;
        if (this._mode === 'camera') {
            this._centerOn(p.x, p.y);
            return;
        }
        if (this._mode === 'touch' && this._start) {
            const move = typeof RTS_MINIMAP_TOUCH_MOVE_PX !== 'undefined' ? RTS_MINIMAP_TOUCH_MOVE_PX : 10;
            const scale = UI.scale() || 1;
            if (!this._moved && Math.hypot(e.clientX - this._start.x, e.clientY - this._start.y) / scale > move) {
                this._moved = true;
                this._clearHold();
            }
            if (this._moved && !this._holdFired) this._centerOn(p.x, p.y);
        }
    }

    _onUp(e) {
        if (!this._pointerId || e.pointerId !== this._pointerId) return;
        if (!this.enabled) { this._clearTouch(); return; }
        const wasTouch = this._mode === 'touch';
        const start = this._start;
        const moved = this._moved;
        const fired = this._holdFired;
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
        this._clearTouch();
        if (!wasTouch || !start || moved || fired || !this.world.running) return;
        this._centerOn(start.mx, start.my);
    }

    _onCancel(e) {
        if (!this._pointerId || e.pointerId !== this._pointerId) return;
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
        this._clearTouch();
    }

    _contextOrder(mx, my, shift) {
        const w = this.world;
        if (!w.running) return;
        const entity = this._pickEntity(mx, my);
        w.contextOrder(w.selectedUnits(), entity, mx, my, shift);
    }

    _pickEntity(mx, my) {
        const c = this.canvas;
        if (!c || c.clientWidth <= 0 || c.clientHeight <= 0) return null;
        const n = this._mapSize();
        const sideLayout = Math.min(c.clientWidth, c.clientHeight);
        const radius = (typeof RTS_MINIMAP_PICK_RADIUS !== 'undefined' ? RTS_MINIMAP_PICK_RADIUS : 4) / Math.max(1, sideLayout) * n;
        let best = null, bestD = Infinity;
        const consider = (e, r) => {
            if (!e || !e.isAlive) return;
            if (this.world.vision && !this.world.vision.canSelect('player', e)) return;
            const d = Math.hypot(e.x - mx, e.y - my);
            if (d <= Math.max(radius, r || 0) && d < bestD) { bestD = d; best = e; }
        };
        for (const u of this.world.units) consider(u, u.radius);
        for (const b of this.world.buildings) consider(b, Math.max(b.radius, Math.max(b.footprint[0], b.footprint[1]) * 0.5));
        for (const r of this.world.resources) if (r.amount > 0) consider(r, r.radius);
        for (const w of this.world.wrecks || []) consider(w, w.radius);
        return best;
    }

    // --- Pure helpers (tests) ----------------------------------------------------

    // Screen point inside the canvas rect -> map units, with the letterbox removed.
    static screenToMap(rect, clientX, clientY, size, side) {
        const ox = (rect.width - side) / 2, oy = (rect.height - side) / 2;
        return RTSMinimap.canvasToMap(clientX - rect.left - ox, clientY - rect.top - oy, size, side);
    }

    // Map units -> position inside a square of side px.
    static mapToCanvas(x, y, size, side) {
        const k = side / Math.max(1, size);
        return { x: x * k, y: y * k };
    }

    // Canvas point inside a square of side px -> map units, clamped to the board.
    static canvasToMap(px, py, size, side) {
        const n = Math.max(1, size), s = Math.max(1, side);
        return {
            x: Math.max(0, Math.min(size, px / s * n)),
            y: Math.max(0, Math.min(size, py / s * n))
        };
    }

    // Nearest entity to a map point within radius (map units), ignoring visibility.
    static nearest(list, x, y, radius) {
        let best = null, bestD = Infinity;
        for (const e of list) {
            if (!e || !e.isAlive) continue;
            const d = Math.hypot(e.x - x, e.y - y);
            if (d <= radius && d < bestD) { bestD = d; best = e; }
        }
        return best;
    }
}
