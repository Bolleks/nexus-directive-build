// RTSHUD.js — the bridge between RTSWorld and the HUD records in UILayout.js. The game
// never creates or positions DOM: it takes elements by id and feeds text, values and clicks.
// Icon grids (production, construction, orders, selected squad) are canvas records drawn by
// RTSIcons; RTSHUD only maps clicks to the same world calls the old buttons used.

class RTSHUD {
    /** @param {RTSWorld} world */
    constructor(world) {
        this.world = world;
        this.cards = [];
        this.messages = [];
        this._acc = 0;
        this._debug = false;
        this._hintOpen = false;
        this._cmdSingle = false;

        const restart = UI.get('endRestart');
        if (restart) restart.onClick(() => { this.world.audio.ui(); window.location.reload(); });
        const follow = UI.get('camFollow');
        if (follow) follow.onClick(() => { this.world.audio.ui(); this.world.toggleFollowSelection(); });
        const hint = UI.get('hint');
        if (hint) hint.setText('ЛКМ — выбор · рамка — отряд · ПКМ — приказ · WASD/край экрана — камера · колесо — зум\nEsc — отмена · F — слежение · нижняя панель — юниты, здания, приказы · F3 — отладка');
        const hintBtn = UI.get('hintBtn');
        if (hintBtn) hintBtn.onClick(() => {
            this._hintOpen = !this._hintOpen;
            const panel = UI.get('hintPanel');
            if (panel) panel.show(this._hintOpen);
            this.world.audio.ui();
        });
        this._bindGrid('prodIcons', i => this._activateUnit(RTS_DATA.UNIT_MENU[i]));
        this._bindGrid('buildIcons', i => this._activateBuilding(RTS_DATA.BUILD_MENU[i]));
        this._bindGrid('cmdIcons', i => {
            const card = this.cards[i];
            if (!card || !card.enabled || !card.action) return;
            this.world.audio.ui();
            card.action();
        });
        this._bindGrid('squadIcons', i => {
            const unit = this.world.selectedUnits()[i];
            if (unit) this.world.select([unit], false);
        });
        this.setDebug(false);
        this._showMessages();
        this.refreshProduction();
        this.refreshCommands();
    }

    // --- Canvas plumbing ---------------------------------------------------------

    // Resizes the backing store to the current screen scale and returns a layout-px context.
    _canvas(id) {
        const el = UI.get(id);
        const canvas = el && el.canvas;
        if (!canvas) return null;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const w = Math.max(1, canvas.clientWidth || 1);
        const h = Math.max(1, canvas.clientHeight || 1);
        const scale = UI.scale() || 1;
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const bw = Math.max(1, Math.round(w * scale * dpr));
        const bh = Math.max(1, Math.round(h * scale * dpr));
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
        ctx.setTransform(bw / w, 0, 0, bh / h, 0, 0);
        ctx.clearRect(0, 0, w, h);
        return { ctx, w, h };
    }

    _local(canvas, ev) {
        const rect = canvas.getBoundingClientRect();
        const w = canvas.clientWidth || rect.width || 1;
        const h = canvas.clientHeight || rect.height || 1;
        return {
            x: (ev.clientX - rect.left) * (w / (rect.width || w)),
            y: (ev.clientY - rect.top) * (h / (rect.height || h)),
        };
    }

    _bindGrid(id, onPick) {
        const el = UI.get(id);
        const canvas = el && el.canvas;
        if (!canvas) return;
        canvas.addEventListener('click', (ev) => {
            if (UI.editing) return;
            const p = this._local(canvas, ev);
            const rects = this._gridFor(id, canvas.clientWidth || 1, canvas.clientHeight || 1);
            let i = RTSIcons.hit(rects, p.x, p.y);
            if (id === 'cmdIcons' && this._cmdSingle) i = 0;
            if (i >= 0) onPick(i);
        });
    }

    _gridFor(id, w, h) {
        if (id === 'squadIcons') return RTSIcons.grid(w, h, 2, 6, { gapX: 8, gapY: 8, padX: 2, padY: 1 });
        if (id === 'buildIcons') return RTSIcons.grid(w, h, 3, 2, { gapX: 4, gapY: 8 });
        if (id === 'prodIcons') return RTSIcons.grid(w, h, 2, 3, { gapX: 4, gapY: 4 });
        return RTSIcons.grid(w, h, 2, 2, { gapX: 4, gapY: 8 });
    }

    _icon(id, draw) {
        const c = this._canvas(id);
        if (!c) return;
        draw(c.ctx, c.w, c.h);
    }

    // --- Top bar and selected squad ----------------------------------------------

    _drawTopBar() {
        const w = this.world, p = w.teams.player;
        const credits = UI.get('creditsText');
        if (credits) credits.setText(String(Math.floor(p.credits)));
        const supply = UI.get('supplyText');
        if (supply) supply.setText(w.supplyUsed('player') + ' / ' + Math.max(0, w.supplyCap('player')));
        const counts = {};
        for (const u of w.units) if (u.isAlive && u.team === 'player') counts[u.type] = (counts[u.type] || 0) + 1;
        for (const type of RTS_DATA.UNIT_MENU) {
            const el = UI.get(type + 'Count');
            if (el) el.setText(String(counts[type] || 0));
        }
        this._icon('crystalIcon', (ctx, ww, hh) => RTSIcons.drawCrystal(ctx, 0, 0, ww, hh, { color: RTS_DATA.COLORS.neutral }));
        this._icon('supplyIcon', (ctx, ww, hh) => RTSIcons.drawSupply(ctx, 0, 0, ww, hh, { color: '#cfe6f5' }));
        for (const type of RTS_DATA.UNIT_MENU) {
            this._icon(type + 'Icon', (ctx, ww, hh) => RTSIcons.drawUnit(ctx, type, 0, 0, ww, hh, { color: RTS_DATA.COLORS.player }));
        }
    }

    _drawSquad(units) {
        const title = UI.get('squadTitle');
        if (title) title.setText(units.length ? 'ОТРЯД · ' + units.length : 'ОТРЯД');
        const c = this._canvas('squadIcons');
        if (!c) return;
        const rects = this._gridFor('squadIcons', c.w, c.h);
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i], u = units[i] || null;
            RTSIcons.slot(c.ctx, r, !!u);
            if (!u) continue;
            RTSIcons.drawUnit(c.ctx, u.type, r.x + 7, r.y + 5, r.w - 14, r.h - 20, { color: RTS_DATA.COLORS.player });
            const hp = u.health / Math.max(1, u.maxHealth);
            RTSIcons.bar(c.ctx, r.x + 7, r.y + r.h - 10, r.w - 14, 3, hp,
                hp > 0.5 ? '#6ef28b' : hp > 0.25 ? '#ffcf5a' : '#ff5a5a');
        }
    }

    // --- Frame -------------------------------------------------------------------

    update(dt) {
        this._updateMessages(dt);
        this._acc += dt;
        if (this._acc < 0.12) return;
        this._acc = 0;
        this._drawTopBar();
        this._drawSquad(this.world.selectedUnits());
        this.refreshProduction();
        this._updateSelection();
        this.refreshCommands();
        if (this._debug) this._updateDebug();
    }

    refreshSelection() {
        this._updateSelection();
    }

    // --- Selection panel ---------------------------------------------------------

    _updateSelection() {
        const w = this.world;
        const units = w.selectedUnits();
        const building = w.selectedBuilding();
        const resource = w.selectedResource();
        const wreck = typeof w.selectedWreck === 'function' ? w.selectedWreck() : null;
        const enemy = w.selectedEnemyUnit();
        const name = UI.get('selName');
        const bar = UI.get('selHpBar');
        const stats = UI.get('selStats');
        const status = UI.get('selStatus');
        const follow = UI.get('camFollow');
        if (follow) follow.show(false);
        let icon = null;
        if (units.length) {
            let hp = 0, max = 0;
            for (const u of units) { hp += u.health; max += u.maxHealth; }
            if (name) name.setText(units.length === 1 ? units[0].name : 'Отряд · ' + units.length + ' юнитов');
            if (bar) { bar.show(true); bar.setValue(hp / Math.max(1, max)); }
            if (stats) stats.setText(this._unitStats(units));
            if (status) status.setText(w.selectedCommandText() + (units.length > 1 ? ' · ' + units.length + ' ед.' : ''));
            if (follow) {
                follow.show(true);
                follow.setText(w.followSelection ? 'Слежение включено (F)' : 'Следить за отрядом (F)');
            }
            icon = new Set(units.map(u => u.type)).size === 1
                ? { kind: 'unit', type: units[0].type, team: 'player' }
                : { kind: 'group' };
        } else if (building) {
            if (name) name.setText(building.name + (building.team === 'player' ? '' : ' · противник'));
            if (bar) { bar.show(true); bar.setValue(building.health / building.maxHealth); }
            if (stats) stats.setText(this._buildingStats(building));
            if (status) {
                if (building.team !== 'player') {
                    status.setText('Враг');
                } else if (building.demolishing) {
                    status.setText('Демонтаж: ' + Math.round(building.demolishProgress * 100) + '%');
                } else if (!building.isBuilt) {
                    status.setText('Строится: ' + Math.round(building.buildProgress * 100) + '%');
                } else if (building.productionQueue.length) {
                    const q = building.productionQueue[0];
                    const d = RTS_DATA.UNITS[q.type];
                    status.setText('Производство: ' + d.name + ' · ' + Math.max(0, q.remaining).toFixed(1) + 'с' +
                        (building.productionQueue.length > 1 ? ' (+' + (building.productionQueue.length - 1) + ')' : ''));
                } else if (building.train.length) {
                    status.setText('Готов · выберите юнита для производства');
                } else if (building.tower) {
                    status.setText('Автоматическая оборона · радиус ' + building.attackRange);
                } else {
                    status.setText('Готов');
                }
            }
            icon = { kind: 'building', type: building.type, team: building.team };
        } else if (resource) {
            if (name) name.setText('Кристальная жила');
            if (bar) bar.show(false);
            if (stats) stats.setText('Осталось: ' + Math.ceil(resource.amount) + ' / ' + resource.maxAmount);
            if (status) status.setText('Месторождение кристаллов');
            icon = { kind: 'resource' };
        } else if (wreck) {
            if (name) name.setText(wreck.name);
            if (bar) bar.show(false);
            const min = typeof RTS_WRECK_REWARD_MIN !== 'undefined' ? RTS_WRECK_REWARD_MIN : 50;
            const max = typeof RTS_WRECK_REWARD_MAX !== 'undefined' ? RTS_WRECK_REWARD_MAX : 200;
            if (stats) stats.setText('Награда: ' + min + '…' + max + ' кристаллов');
            if (status) {
                if (wreck.searched) status.setText('Обломки обысканы');
                else if (wreck.searchingUnit) {
                    const total = typeof RTS_WRECK_SEARCH_SEC !== 'undefined' ? RTS_WRECK_SEARCH_SEC : 15;
                    status.setText('Обыск: ' + wreck.searchProgress.toFixed(1) + ' / ' + total + ' с');
                } else {
                    status.setText('ПКМ любым юнитом — обыскать');
                }
            }
            icon = { kind: 'wreck' };
        } else if (enemy) {
            if (name) name.setText(enemy.name + ' · противник');
            if (bar) { bar.show(true); bar.setValue(enemy.health / enemy.maxHealth); }
            if (stats) stats.setText(this._unitStats([enemy]));
            if (status) status.setText('Враг');
            icon = { kind: 'unit', type: enemy.type, team: 'enemy' };
        } else {
            if (name) name.setText('Ничего не выбрано');
            if (bar) bar.show(false);
            if (stats) stats.setText('');
            if (status) status.setText('ЛКМ — выбор · ПКМ — приказ');
        }
        this._drawStatsIcon(icon);
    }

    _unitStats(units) {
        if (new Set(units.map(u => u.type)).size !== 1) return 'Смешанный отряд';
        const d = RTS_DATA.UNITS[units[0].type];
        if (!d) return '';
        return 'Броня: ' + d.armor + ' · Бронебойность: ' + d.penetration +
            '\nУрон: ' + d.damage + ' · Перезарядка: ' + d.cooldown + 'с · Дальность: ' + d.range;
    }

    _buildingStats(building) {
        const d = RTS_DATA.BUILDINGS[building.type];
        if (!d) return '';
        const lines = ['Броня: ' + d.armor];
        if (d.supply) lines.push('Снабжение: +' + d.supply);
        if (d.dropoff) lines.push('Приём кристаллов');
        if (d.train && d.train.length) lines.push('Обучение: ' + d.train.map(t => RTS_DATA.UNITS[t].name).join(', '));
        if (d.tower) {
            lines.push('Оборона · урон ' + d.damage + ' · перезарядка ' + d.cooldown +
                'с · бронебойность ' + d.penetration + ' · дальность ' + d.range);
        }
        return lines.join('\n');
    }

    _drawStatsIcon(icon) {
        const c = this._canvas('selIcon');
        if (!c || !icon) return;
        if (icon.kind === 'unit') {
            RTSIcons.drawUnit(c.ctx, icon.type, 0, 0, c.w, c.h, { team: icon.team || 'player' });
        } else if (icon.kind === 'building') {
            RTSIcons.drawBuilding(c.ctx, icon.type, 0, 0, c.w, c.h, { team: icon.team || 'player' });
        } else if (icon.kind === 'resource') {
            RTSIcons.drawCrystalField(c.ctx, 0, 0, c.w, c.h, { color: RTS_DATA.COLORS.neutral });
        } else if (icon.kind === 'wreck') {
            RTSIcons.drawWreck(c.ctx, 0, 0, c.w, c.h, { color: RTS_DATA.COLORS.neutral });
        } else {
            RTSIcons.drawGroup(c.ctx, 0, 0, c.w, c.h, { color: RTS_DATA.COLORS.player });
        }
    }

    // --- Production and construction --------------------------------------------

    refreshProduction() {
        this._drawProduction();
        this._drawConstruction();
    }

    _drawProduction() {
        const c = this._canvas('prodIcons');
        if (!c) return;
        const rects = this._gridFor('prodIcons', c.w, c.h);
        for (let i = 0; i < rects.length; i++) {
            const type = RTS_DATA.UNIT_MENU[i], r = rects[i];
            if (!type) { RTSIcons.slot(c.ctx, r, false); continue; }
            const d = RTS_DATA.UNITS[type];
            const st = this.world.running ? this.world.unitOrderStatus(type) : { ok: false, reason: 'матч завершён' };
            RTSIcons.slot(c.ctx, r, st.ok);
            RTSIcons.drawUnit(c.ctx, type, r.x + 4, r.y + 5, 28, 28, { color: st.ok ? RTS_DATA.COLORS.player : '#5b7180', dim: !st.ok });
            RTSIcons.wrap(c.ctx, d.name, r.x + 36, r.y + 3, r.w - 40, 8, 2, st.ok ? '#e8f4ff' : '#7d94a3');
            RTSIcons.text(c.ctx, d.cost + ' · ' + d.time + 'с', r.x + 36, r.y + 23, 8, st.ok ? '#ffdf7e' : '#7d94a3');
            if (!st.ok) RTSIcons.wrap(c.ctx, st.reason, r.x + 36, r.y + 33, r.w - 40, 7, 1, '#9b6b6b');
        }
    }

    _drawConstruction() {
        const c = this._canvas('buildIcons');
        if (!c) return;
        const rects = this._gridFor('buildIcons', c.w, c.h);
        for (let i = 0; i < rects.length; i++) {
            const type = RTS_DATA.BUILD_MENU[i], r = rects[i];
            if (!type) { RTSIcons.slot(c.ctx, r, false); continue; }
            const d = RTS_DATA.BUILDINGS[type];
            const st = this.world.running ? this.world.buildingOrderStatus(type) : { ok: false, reason: 'матч завершён' };
            RTSIcons.slot(c.ctx, r, st.ok);
            RTSIcons.drawBuilding(c.ctx, type, r.x + (r.w - 26) / 2, r.y + 4, 26, 26, { color: st.ok ? RTS_DATA.COLORS.player : '#5b7180', dim: !st.ok });
            RTSIcons.wrap(c.ctx, d.name, r.x + 2, r.y + 31, r.w - 4, 7, 1, st.ok ? '#e8f4ff' : '#7d94a3', 'center');
            RTSIcons.text(c.ctx, d.cost + ' · ' + d.time + 'с', r.x + r.w / 2, r.y + 42, 7, st.ok ? '#ffdf7e' : '#7d94a3', 'center');
            if (!st.ok) RTSIcons.text(c.ctx, st.reason, r.x + r.w / 2, r.y + 51, 6, '#9b6b6b', 'center');
        }
    }

    _activateUnit(type) {
        if (!type || !this.world.running) return;
        const status = this.world.unitOrderStatus(type);
        if (!status.ok) {
            this.world.audio.error();
            this.world.toast(status.reason + '.', 3);
            this.refreshProduction();
            return;
        }
        this.world.audio.ui();
        this.world.queueUnitAny(type);
        this.refreshProduction();
    }

    _activateBuilding(type) {
        if (!type || !this.world.running) return;
        const status = this.world.buildingOrderStatus(type);
        if (!status.ok) {
            this.world.audio.error();
            this.world.toast(status.reason + '.', 3);
            this.refreshProduction();
            return;
        }
        this.world.audio.ui();
        this.world.input.beginBuild(type);
        this.refreshProduction();
        this.refreshCommands();
    }

    // --- Orders ------------------------------------------------------------------

    refreshCommands() {
        this._drawOrders();
    }

    _drawOrders() {
        const w = this.world;
        const input = w.input;
        const title = UI.get('cmdTitle');
        const units = w.selectedUnits();
        this.cards = [];
        this._cmdSingle = false;
        if (!w.running) {
            if (title) title.setText('МАТЧ ЗАВЕРШЁН');
        } else if (input && input.buildType) {
            if (title) title.setText('РАЗМЕЩЕНИЕ: ' + RTS_DATA.BUILDINGS[input.buildType].name);
            this.cards = [{ label: 'Отмена', enabled: true, action: () => input.cancelBuild() }];
            this._cmdSingle = true;
        } else if (input && input.commandMode) {
            if (title) title.setText(input.commandMode === 'attack' ? 'УКАЖИТЕ ЦЕЛЬ' : 'УКАЖИТЕ ТОЧКУ');
            this.cards = [{ label: 'Отмена', enabled: true, action: () => input.cancelCommand() }];
            this._cmdSingle = true;
        } else if (w.selectedBuilding() && w.selectedBuilding().team === 'player') {
            const b = w.selectedBuilding();
            if (b.demolishing) {
                if (title) title.setText('ДЕМОНТАЖ: ' + b.name);
                this.cards = [{ id: 'cancel', label: 'Отменить демонтаж', enabled: true, action: () => w.cancelDemolition(b) }];
                this._cmdSingle = true;
            } else if (!b.isBuilt) {
                if (title) title.setText('СТРОИТЕЛЬСТВО: ' + b.name);
                this.cards = [];
            } else if (b.productionQueue.length) {
                if (title) title.setText('ПРОИЗВОДСТВО: ' + b.name);
                this.cards = [{
                    id: 'cancel', label: 'Отменить заказ', enabled: true,
                    action: () => w.cancelQueuedUnit(b)
                }];
            } else if (b.type === 'hq') {
                if (title) title.setText('ШТАБ: ' + b.name);
                this.cards = [];
            } else {
                if (title) title.setText('ЗДАНИЕ: ' + b.name);
                this.cards = [{ id: 'demolish', label: 'Демонтировать', enabled: true, action: () => w.startDemolition(b) }];
            }
        } else {
            if (title) title.setText('ПРИКАЗЫ');
            const on = units.length > 0;
            this.cards = [
                { id: 'stop', label: 'Стоп', key: 'S', enabled: on, action: () => w.stopSelected() },
                { id: 'hold', label: 'Удержание', key: 'H', enabled: on, action: () => w.holdSelected() },
                { id: 'move', label: 'Движение', key: 'M', enabled: on, action: () => input && input.beginCommand('move') },
                { id: 'attack', label: 'Атака', key: 'A', enabled: on, action: () => input && input.beginCommand('attack') },
            ];
        }
        this._drawOrderCards();
    }

    _drawOrderCards() {
        const c = this._canvas('cmdIcons');
        if (!c) return;
        if (this._cmdSingle) {
            const r = { x: 0, y: 0, w: c.w, h: c.h };
            const card = this.cards[0];
            RTSIcons.slot(c.ctx, r, true);
            RTSIcons.drawOrder(c.ctx, 'cancel', r.x + 8, r.y + 8, 34, 34, { color: '#cfe6f5' });
            RTSIcons.text(c.ctx, card.label, r.x + 52, r.y + 10, 11, '#e8f4ff');
            RTSIcons.text(c.ctx, 'ПКМ / Esc', r.x + 52, r.y + 28, 9, '#9fb6c8');
            return;
        }
        const rects = this._gridFor('cmdIcons', c.w, c.h);
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i], card = this.cards[i];
            if (!card) { RTSIcons.slot(c.ctx, r, false); continue; }
            RTSIcons.slot(c.ctx, r, card.enabled);
            RTSIcons.drawOrder(c.ctx, card.id || 'cancel', r.x + (r.w - 34) / 2, r.y + 6, 34, 34,
                { color: card.enabled ? '#cfe6f5' : '#5b7180', dim: !card.enabled });
            RTSIcons.text(c.ctx, card.label, r.x + r.w / 2, r.y + r.h - 24, 9,
                card.enabled ? '#e8f4ff' : '#7d94a3', 'center');
            if (card.key) RTSIcons.text(c.ctx, card.key, r.x + r.w / 2, r.y + r.h - 13, 8,
                card.enabled ? '#9fb6c8' : '#6b7d89', 'center');
        }
    }

    // --- Debug -------------------------------------------------------------------

    _updateDebug() {
        const w = this.world;
        const playerUnits = w.units.filter(u => u.isAlive && u.team === 'player').length;
        const enemyUnits = w.units.filter(u => u.isAlive && u.team === 'enemy').length;
        const fps = World3D.engine ? Math.round(World3D.engine.getFps()) : 0;
        const set = (id, text) => {
            const el = UI.get(id);
            if (el) { el.show(true); el.setText(text); }
        };
        set('dbg1', 'FPS: ' + fps + ' · юниты P/E: ' + playerUnits + ' / ' + enemyUnits);
        set('dbg2', 'Здания: ' + w.buildings.filter(b => b.isAlive).length + ' · снабжение P: ' + w.supplyUsed('player') + '/' + w.supplyCap('player'));
        set('dbg3', 'Приказ: ' + w.selectedCommandText());
        const mm = Math.floor(w.time / 60), ss = Math.floor(w.time % 60);
        const goal = w.ai && w.ai.goal ? w.ai.goal.id : '—';
        set('dbg4', 'Время: ' + mm + ':' + (ss < 10 ? '0' : '') + ss + ' · цель ИИ: ' + goal);
        const plan = w.ai && w.ai.plan && w.ai.plan.length
            ? w.ai.plan.map(a => a.id).slice(0, 4).join(' → ')
            : '—';
        set('dbg5', 'План ИИ: ' + plan);
        set('dbg6', 'Отряды: ' + (w.squads && w.squads.summary ? w.squads.summary() : '—'));
    }

    setDebug(on) {
        this._debug = !!on;
        for (let i = 1; i <= 6; i++) {
            const el = UI.get('dbg' + i);
            if (el) el.show(!!on);
        }
    }

    // --- Messages ----------------------------------------------------------------

    toast(text, seconds) {
        if (!text) return;
        this.messages.unshift({ text: String(text), ttl: seconds || 3, total: seconds || 3 });
        if (this.messages.length > 3) this.messages.length = 3;
        this._showMessages();
    }

    _updateMessages(dt) {
        if (!this.messages.length) return;
        let changed = false;
        for (const m of this.messages) {
            m.ttl -= dt;
            if (m.ttl <= 0) changed = true;
        }
        this.messages = this.messages.filter(m => m.ttl > 0);
        if (changed) this._showMessages();
    }

    _showMessages() {
        for (let i = 0; i < 3; i++) {
            const el = UI.get('msg' + (i + 1));
            if (!el) continue;
            const m = this.messages[i];
            if (m) { el.setText(m.text); el.show(true); }
            else el.show(false);
        }
    }

    // --- End screen --------------------------------------------------------------

    showEnd(winner) {
        const title = UI.get('endTitle');
        const text = UI.get('endText');
        if (title) title.setText(winner === 'player' ? 'ПОБЕДА' : winner === 'enemy' ? 'ПОРАЖЕНИЕ' : 'НИЧЬЯ');
        if (text) {
            text.setText(winner === 'player'
                ? 'Штаб противника уничтожен. Сектор под вашим контролем.'
                : winner === 'enemy'
                    ? 'Ваш штаб уничтожен. Оборона сектора провалена.'
                    : 'Лимит времени истёк. Ни одна сторона не уничтожила штаб.');
        }
        const dim = UI.get('endDim');
        if (dim) dim.show(true);
        this.toast(winner === 'player' ? 'Победа!' : winner === 'enemy' ? 'Поражение.' : 'Ничья.', 10);
    }
}
