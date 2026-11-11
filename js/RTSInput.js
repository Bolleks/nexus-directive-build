// RTSInput.js — mouse and keyboard for the RTS: click and double-click selection, drag
// marquee, right-click context orders, build ghost placement and Escape/F3. It turns events
// into RTSWorld calls; the camera keeps WASD/arrows/wheel (LMB and RMB are free because
// CAMERA_ORBIT = 0).

class RTSInput {
    /** @param {RTSWorld} world @param {{ location: Location3D, camera: CameraController }} app */
    constructor(world, app) {
        this.world = world;
        this.app = app;
        this.canvas = World3D.canvas;
        this.enabled = true;
        this.buildType = '';
        this.commandMode = '';
        this.pointer = { x: 0, y: 0 };
        this.drag = null;

        this._bound = {
            down: (e) => this._onDown(e),
            move: (e) => this._onMove(e),
            up: (e) => this._onUp(e),
            dblclick: (e) => this._onDoubleClick(e),
            key: (e) => this._onKey(e)
        };
        if (this.canvas) {
            this.canvas.addEventListener('pointerdown', this._bound.down);
            this.canvas.addEventListener('pointermove', this._bound.move);
            this.canvas.addEventListener('pointerup', this._bound.up);
            this.canvas.addEventListener('pointercancel', this._bound.up);
            this.canvas.addEventListener('dblclick', this._bound.dblclick);
        }
        window.addEventListener('keydown', this._bound.key);
    }

    _local(e) {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _ground(px, py) {
        const view = this.app.location.view;
        if (!view || !this.world.running) return null;
        view.refreshMatrices();
        const hit = view.pointerToGround(px, py, 0, this.app.location.terrain);
        if (!hit) return null;
        return { x: hit.x / this.world.map.scale, y: hit.y / this.world.map.scale };
    }

    // Screen-space picking through View3D projections. It is stable for units with several
    // child meshes and does not fight Babylon's thin instances or scene picking.
    _pickEntity(px, py) {
        const view = this.app.location.view;
        if (!view) return null;
        view.refreshMatrices();
        const cam = this.app.camera;
        const zoom = cam ? cam.zoom : 1;
        const S = this.world.map.scale;
        let best = null, bestD = Infinity;
        const consider = (e, size) => {
            if (!e || !e.isAlive) return;
            if (this.world.vision && !this.world.vision.canSelect('player', e)) return;
            const x = e.x * S, y = e.y * S;
            const h = (this.app.location.terrain ? this.app.location.terrain.heightAt(x, y) : 0) +
                (RTS_DATA.VISUAL_HEIGHT[e.type] || 18) * 0.5;
            const s = view.projectToScreen(x, y, h);
            if (!s.visible) return;
            const r = Math.max(17, size * S * zoom * 1.7);
            const d = Math.hypot(px - s.x, py - s.y);
            if (d <= r && d < bestD) { bestD = d; best = e; }
        };
        for (const u of this.world.units) consider(u, Math.max(1.1, u.radius));
        for (const b of this.world.buildings) consider(b, Math.max(2.1, Math.max(b.footprint[0], b.footprint[1]) * 0.55));
        for (const r of this.world.resources) consider(r, Math.max(2.3, r.radius));
        for (const w of this.world.wrecks || []) consider(w, Math.max(3, w.radius));
        return best;
    }

    // A unit whose projected centre lies inside the canvas: double-click keeps the
    // same-type units that are on screen, as in most RTS games.
    /** @param {RTSUnit} unit */
    _onScreen(unit) {
        const view = this.app.location.view;
        if (!view || !this.canvas) return false;
        const S = this.world.map.scale;
        const wx = unit.x * S, wy = unit.y * S;
        const h = (this.app.location.terrain ? this.app.location.terrain.heightAt(wx, wy) : 0) +
            (RTS_DATA.VISUAL_HEIGHT[unit.type] || 18) * 0.5;
        const s = view.projectToScreen(wx, wy, h);
        return s.visible && s.x >= 0 && s.y >= 0 &&
            s.x <= this.canvas.clientWidth && s.y <= this.canvas.clientHeight;
    }

    _onDoubleClick(e) {
        if (!this.enabled || !this.world.running || e.button !== 0) return;
        if (this.buildType || this.commandMode) return;
        const p = this._local(e);
        const entity = this._pickEntity(p.x, p.y);
        if (!entity || entity.kind !== 'unit' || entity.team !== 'player') return;
        this.world.selectSameType(entity, (unit) => this._onScreen(unit));
    }

    _setCursor(mode) {
        if (this.canvas) this.canvas.style.cursor = mode;
    }

    _onDown(e) {
        if (!this.enabled || !this.world.running) return;
        const p = this._local(e);
        this.pointer = p;
        if (e.button === 0) {
            if (this.buildType) {
                this._placeBuilding(e.shiftKey);
                e.preventDefault();
                return;
            }
            if (this.commandMode) {
                this._applyCommand(p.x, p.y, e.shiftKey);
                e.preventDefault();
                return;
            }
            const additive = !!e.shiftKey;
            this.drag = {
                sx: p.x, sy: p.y, x: p.x, y: p.y, additive,
                before: additive ? this.world.selected.slice() : [],
                moved: false
            };
            try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ }
        } else if (e.button === 2) {
            e.preventDefault();
            if (this.buildType) { this.cancelBuild(); return; }
            if (this.commandMode) { this.cancelCommand(); return; }
            this._contextOrder(p.x, p.y, e.shiftKey);
        }
    }

    _onMove(e) {
        if (!this.enabled) return;
        const p = this._local(e);
        this.pointer = p;
        if (this.drag) {
            this.drag.x = p.x;
            this.drag.y = p.y;
            const dx = p.x - this.drag.sx, dy = p.y - this.drag.sy;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) this.drag.moved = true;
            if (this.drag.moved) {
                const box = UI.get('dragBox');
                if (box) {
                    box.show(true);
                    box.setScreenRect(Math.min(p.x, this.drag.sx), Math.min(p.y, this.drag.sy), Math.abs(dx), Math.abs(dy));
                }
            }
            return;
        }
        if (this.buildType) {
            const g = this._ground(p.x, p.y);
            if (g) {
                const def = RTS_DATA.BUILDINGS[this.buildType];
                const valid = this.world.canPlaceBuilding('player', this.buildType, g.x, g.y) &&
                    this.world.teams.player.credits >= def.cost;
                this.world.view.moveGhost(g.x, g.y, valid);
            }
            this._setCursor('crosshair');
            return;
        }
        if (this.commandMode) { this._setCursor('crosshair'); return; }
        this._setCursor(this._pickEntity(p.x, p.y) ? 'pointer' : 'default');
    }

    _onUp(e) {
        if (!this.drag) return;
        const drag = this.drag;
        this.drag = null;
        const box = UI.get('dragBox');
        if (box) box.show(false);
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
        if (!this.enabled || !this.world.running) return;

        if (drag.moved) {
            const x0 = Math.min(drag.sx, drag.x), x1 = Math.max(drag.sx, drag.x);
            const y0 = Math.min(drag.sy, drag.y), y1 = Math.max(drag.sy, drag.y);
            const view = this.app.location.view;
            const S = this.world.map.scale;
            const picked = [];
            for (const u of this.world.units) {
                if (!u.isAlive || u.team !== 'player') continue;
                const wx = u.x * S, wy = u.y * S;
                const h = (this.app.location.terrain ? this.app.location.terrain.heightAt(wx, wy) : 0) +
                    (RTS_DATA.VISUAL_HEIGHT[u.type] || 20) * 0.5;
                const s = view.projectToScreen(wx, wy, h);
                if (s.visible && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) picked.push(u);
            }
            this.world.select(picked, drag.additive);
            return;
        }

        const entity = this._pickEntity(drag.x, drag.y);
        if (entity) this.world.select([entity], drag.additive);
        else if (!drag.additive) this.world.clearSelection();
    }

    _contextOrder(px, py, shift) {
        const w = this.world;
        const entity = this._pickEntity(px, py);
        const g = this._ground(px, py) || (entity ? { x: entity.x, y: entity.y } : null);
        if (!g) return;
        w.contextOrder(w.selectedUnits(), entity, g.x, g.y, shift);
    }

    beginBuild(type) {
        if (!this.world.running) return;
        this.cancelCommand();
        this.buildType = type;
        this.world.view.beginGhost(type, 'player');
        const g = this._ground(this.pointer.x, this.pointer.y);
        if (g) {
            const valid = this.world.canPlaceBuilding('player', type, g.x, g.y) &&
                this.world.teams.player.credits >= RTS_DATA.BUILDINGS[type].cost;
            this.world.view.moveGhost(g.x, g.y, valid);
        }
        this._setCursor('crosshair');
        this.world.hud.refreshCommands();
    }

    cancelBuild() {
        this.buildType = '';
        this.world.view.endGhost();
        this._setCursor('default');
        this.world.hud.refreshCommands();
    }

    _placeBuilding(keepMode) {
        if (!this.buildType) return;
        const g = this._ground(this.pointer.x, this.pointer.y);
        if (!g) return;
        const def = RTS_DATA.BUILDINGS[this.buildType];
        if (!this.world.canPlaceBuilding('player', this.buildType, g.x, g.y)) {
            this.world.audio.error();
            this.world.toast('Здесь нельзя строить.', 2.5);
            return;
        }
        if (this.world.teams.player.credits < def.cost) {
            this.world.audio.error();
            this.world.toast('Недостаточно кристаллов: нужно ' + def.cost + '.', 3);
            return;
        }
        const b = this.world.placeBuilding('player', this.buildType, g.x, g.y);
        if (!b) return;
        this.world.view.marker(g.x, g.y, 'move');
        if (!keepMode) this.cancelBuild();
        else this.world.hud.refreshCommands();
    }

    beginCommand(mode) {
        if (!this.world.running || !this.world.selectedUnits().length) return;
        this.cancelBuild();
        this.commandMode = mode;
        this._setCursor('crosshair');
        this.world.hud.refreshCommands();
    }

    cancelCommand() {
        this.commandMode = '';
        this._setCursor('default');
        this.world.hud.refreshCommands();
    }

    _applyCommand(px, py, shift) {
        const w = this.world;
        const units = w.selectedUnits();
        if (!units.length) { this.cancelCommand(); return; }
        const entity = this._pickEntity(px, py);
        if (this.commandMode === 'attack' && entity && entity.team && entity.team !== 'player') {
            w.issueAttack(units, entity, shift);
        } else if (this.commandMode === 'attack') {
            const g = this._ground(px, py);
            if (g) w.issueAttackMove(units, g.x, g.y, shift);
        } else {
            const g = entity ? { x: entity.x, y: entity.y } : this._ground(px, py);
            if (g) w.issueMove(units, g.x, g.y, shift);
        }
        this.cancelCommand();
    }

    // Drop any transient input state (called when the match ends).
    abort() {
        this.buildType = '';
        this.commandMode = '';
        this.drag = null;
        if (this.world.view) this.world.view.endGhost();
        const box = UI.get('dragBox');
        if (box) box.show(false);
        this._setCursor('default');
    }

    _onKey(e) {
        if (!this.enabled) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.code === 'F3') {
            e.preventDefault();
            this.world.toggleDebug();
            return;
        }
        if (e.code === 'KeyF' && !e.repeat) {
            e.preventDefault();
            this.world.toggleFollowSelection();
            return;
        }
        if (e.code !== 'Escape') return;
        e.preventDefault();
        if (this.buildType) { this.cancelBuild(); return; }
        if (this.commandMode) { this.cancelCommand(); return; }
        const units = this.world.selectedUnits();
        const busy = units.some(u => u.orders.length || u.path.length || u.target);
        if (units.length && busy) {
            this.world.stopSelected();
            return;
        }
        this.world.clearSelection();
    }
}
