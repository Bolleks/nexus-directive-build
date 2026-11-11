// RTSData.js — design tables for the RTS demo: units, buildings, their statistics and
// the visual palette. The numbers of the match (map size, starting resources, AI timings)
// live in Constants.js; this file holds the per-type balance table.
//
// Statistics are in map units and seconds. The view multiplies positions by
// RTS_WORLD_SCALE when it places meshes. Armor and penetration are flat values used by
// the damage formula (RTSCombat.effectiveDamage); `buildingMultiplier` scales damage
// against buildings; `splash` and `deadZone` are the siege tank's special rules.

/** @satisfies {Record<string, any>} */
const RTS_DATA = {
    TEAM_PLAYER: 'player',
    TEAM_ENEMY: 'enemy',

    UNITS: {
        worker: {
            name: 'Сборщик', role: 'worker', cost: 50, time: 12, hp: 60, speed: 9, radius: 1.0,
            sight: 21, damage: 0, range: 0, cooldown: 0, penetration: 0, supply: 1, armor: 0,
            move: { accel: 24, decel: 30, turnRate: 8.0, mass: 1, clearance: 1.0 },
            turret: { turnRate: 10, arc: Math.PI, fireOnMove: false },
            preferredRange: [0, 0], kite: false
        },
        infantry: {
            name: 'Пехотинец с бластером', role: 'infantry', cost: 60, time: 15, hp: 80, speed: 8,
            radius: 1.1, sight: 28, damage: 8, range: 18, cooldown: 1.0,
            penetration: 2, supply: 1, armor: 1,
            move: { accel: 22, decel: 28, turnRate: 7.0, mass: 1, clearance: 1.1 },
            turret: { turnRate: 10, arc: Math.PI, fireOnMove: false },
            preferredRange: [0, 18], kite: false
        },
        grenadier: {
            name: 'Гранатомётчик', role: 'grenadier', cost: 90, time: 18, hp: 90, speed: 7.5,
            radius: 1.1, sight: 27, damage: 12, range: 19, cooldown: 1.9,
            penetration: 2, supply: 2, armor: 1, buildingMultiplier: 0.75, deadZone: 2.5,
            splash: { innerRadius: 1.5, outerRadius: 3, outerFactor: 0.55 },
            move: { accel: 20, decel: 24, turnRate: 6.0, mass: 1.2, clearance: 1.1 },
            turret: { turnRate: 6, arc: Math.PI, fireOnMove: false },
            preferredRange: [3, 19], kite: false
        },
        scout: {
            name: 'Машина разведки', role: 'scout', cost: 100, time: 20, hp: 150, speed: 14,
            radius: 0.9, sight: 42, damage: 7, range: 21, cooldown: 0.5,
            penetration: 1, supply: 2, armor: 3,
            move: { accel: 26, decel: 30, turnRate: 8.0, mass: 1, clearance: 0.9 },
            turret: { turnRate: 12, arc: Math.PI, fireOnMove: true },
            preferredRange: [18, 21], kite: true
        },
        siege: {
            name: 'Осадный танк', role: 'siege', cost: 250, time: 40, hp: 300, speed: 6,
            radius: 1.8, sight: 28, damage: 50, range: 35, cooldown: 3.0,
            penetration: 5, supply: 4, armor: 6,
            buildingMultiplier: 1.5,
            deadZone: 7,
            splash: { innerRadius: 2, outerRadius: 5, outerFactor: 0.5 },
            move: { accel: 6, decel: 8, turnRate: 1.3, mass: 6, clearance: 1.8 },
            turret: { turnRate: 1.2, arc: 0.25, fireOnMove: false },
            preferredRange: [7, 35], kite: false
        }
    },

    // The always-visible production panel: unit cards first, then constructible buildings.
    UNIT_MENU: ['worker', 'infantry', 'scout', 'grenadier', 'siege'],
    BUILD_MENU: ['generator', 'depot', 'barracks', 'factory', 'tower'],

    // Target role priority: how much an attacker of a given role wants a given target.
    TARGET_PRIORITY: {
        worker:    { worker: 4, infantry: 1, scout: 2, grenadier: 1, siege: 1, building: 1, tower: 0 },
        infantry:  { worker: 5, infantry: 5, scout: 4, grenadier: 4, siege: 3, building: 2, tower: 3 },
        grenadier: { worker: 5, infantry: 8, scout: 4, grenadier: 3, siege: 2, building: 1, tower: 2 },
        scout:     { worker: 8, infantry: 3, scout: 5, grenadier: 5, siege: 2, building: 1, tower: 0 },
        siege:     { worker: 2, infantry: 2, scout: 2, grenadier: 2, siege: 5, building: 8, tower: 9 }
    },

    // GOAP design numbers: goal priorities and action costs. The editor does not patch these;
    // tunable timings and thresholds live in Constants.js.
    AI: {
        GOAL_PRIORITY: {
            survive: 100, regroup: 95, defend: 90, attack: 80, harass: 70,
            defenses: 60, tech: 58, army: 55, economy: 50, scout: 40, idle: 0
        },
        ACTION_COST: {
            assign_workers: 1, train_worker: 2, build_generator: 5, build_depot: 6,
            build_barracks: 8, build_factory: 12,             train_infantry: 3, train_scout: 4, train_grenadier: 4,
            train_siege: 6, build_tower: 7, defend_base: 2, stage_army: 3,
            launch_attack: 5, press_attack: 4, harass: 4, regroup: 2, scout: 3, wait: 1
        },
        SQUAD_GOAL_PRIORITY: {
            survive: 100, regroup: 90, defend_point: 80, raid_economy: 70,
            siege_building: 65, eliminate_target: 60, scout_area: 50,
            hold_position: 20
        },
        SQUAD_ACTION_COST: {
            move_to: 2, attack_move_to: 3, hold: 2, explore: 2, focus: 3,
            destroy_building: 4, engage_nearest: 2, withdraw: 2, flank: 4, kite: 3,
            avoid_tower: 2, destroy_tower: 4, raid_workers: 3, regroup: 2, wait: 1
        },
        // Tactical squad radii, formation limits and maneuver distances (map units and seconds).
        SQUAD_THRESHOLDS: {
            rebuildSec: 1.5, siegeSize: 3, enemyNearRadius: 20, enemyArmyRadius: 22,
            enemyWorkersRadius: 28, enemyTowerRadius: 18, rallyRadius: 6, targetRadius: 4,
            outnumberFactor: 1.3, flankBack: 8, flankSide: 10, kiteBack: 6, kiteDone: 9,
            towerMargin: 3, towerMarginSafe: 6
        },
        THRESHOLDS: {
            stagingRadius: 9, creditsLow: 100, creditsHigh: 300,
            supplyPressure: 0.85, supplyOk: 0.9, stagingRatio: 0.8,
            baseRadius: 20, hqDanger: 0.6,
            economyBonus: 12, armyBonus: 10, defenseBonus: 10, attackBonus: 10,
            queueMax: 2, defendReassignSec: 5, toastSec: 3.5, counterCost: 2
        }
    },

    BUILDINGS: {
        hq: {
            name: 'Штаб', cost: 400, time: 60, hp: 3000, footprint: [7, 7], radius: 3.6,
            sight: 35, supply: 10, dropoff: true, train: ['worker'], armor: 5, requires: []
        },
        generator: {
            name: 'Генератор', cost: 100, time: 20, hp: 500, footprint: [4, 4], radius: 2.2,
            sight: 25, supply: 8, armor: 3, requires: ['hq']
        },
        depot: {
            name: 'Приёмный пункт', cost: 150, time: 25, hp: 600, footprint: [6, 6], radius: 3.0,
            sight: 25, dropoff: true, armor: 3, requires: ['hq']
        },
        barracks: {
            name: 'Казармы', cost: 150, time: 30, hp: 800, footprint: [5, 5], radius: 2.7,
            sight: 25, train: ['infantry', 'grenadier'], armor: 4, requires: ['hq']
        },
        factory: {
            name: 'Военный завод', cost: 250, time: 45, hp: 1000, footprint: [6, 6], radius: 3.2,
            sight: 25, train: ['scout', 'siege'], armor: 5, requires: ['generator', 'barracks']
        },
        tower: {
            name: 'Турель', cost: 150, time: 25, hp: 400, footprint: [3, 3], radius: 1.8,
            sight: 32, range: 24, damage: 12, cooldown: 0.8, penetration: 2, armor: 4,
            requires: ['barracks']
        }
    },

    // Height of the top of an object in world px — health bars and debug circles sit above it.
    VISUAL_HEIGHT: {
        worker: 28, infantry: 26, scout: 35, grenadier: 29, siege: 42,
        hq: 100, generator: 50, depot: 56, barracks: 54, factory: 72, tower: 54, resource: 24, wreck: 30
    },

    // Construction and unit palette. Team colour is applied to hulls or trim; details stay neutral.
    COLORS: {
        player: '#3f8cff',
        enemy: '#ff5a5a',
        playerDark: '#174a99',
        enemyDark: '#8e2525',
        neutral: '#ffcf5a',
        metal: '#77828a',
        metalDark: '#343c42',
        glow: '#9de8ff',
        hqHull: '#e7eaf0',
        hqHullShade: '#c3c9d2',
        hqCharcoal: '#3c424c',
        hqCharcoalLight: '#59616c',
        hqGlow: '#2fd0ec',
        hqBeacon: '#ff4b2b',
        depotHull: '#dfe3ea',
        depotHullShade: '#b7bdc7',
        depotCharcoal: '#39404a',
        depotCharcoalLight: '#5a636e',
        depotGlow: '#2fd0ec',
        depotBeacon: '#ff4b2b',
        depotHazard: '#f5b829',
        depotCrate: '#98a09a',
        depotCrateDark: '#5f6763',
        generatorHull: '#e2e6ec',
        generatorHullShade: '#b8bfc9',
        generatorCharcoal: '#333a44',
        generatorCharcoalLight: '#59616c',
        generatorGlow: '#2fd0ec',
        factoryHull: '#e7eaf0',
        factoryHullShade: '#c2c8d1',
        factoryCharcoal: '#3b424c',
        factoryCharcoalLight: '#59616c',
        factoryGlow: '#2fd0ec',
        factoryHazard: '#f5b829',
        towerHull: '#e7eaf0',
        towerHullShade: '#c2c8d1',
        towerCharcoal: '#333a44',
        towerCharcoalLight: '#59616c',
        towerGlow: '#2fd0ec',
        siegeHull: '#d9dde3',
        siegeHullShade: '#b0b6c0',
        siegeCharcoal: '#363c45',
        siegeCharcoalLight: '#59616c',
        siegeTire: '#24282e',
        siegeTireLight: '#4a505a',
        siegeBore: '#15181c',
        treeTrunk: '#6b4a2e',
        treeCrown: '#2f7a45',
        treeCrownLight: '#4c9e5c',
        rock: '#73767a',
        rockDark: '#4b4e52',
        scoutHull: '#eef1f5',
        scoutHullShade: '#c7ccd4',
        scoutCharcoal: '#3b414a',
        scoutCharcoalLight: '#5b636d',
        scoutTire: '#2f343b',
        scoutTireLight: '#515861',
        scoutGlass: '#223344',
        scoutGlow: '#2fd0ec',
        workerHull: '#eef1f5',
        workerHullShade: '#c7ccd4',
        workerCharcoal: '#3b414a',
        workerCharcoalLight: '#5b636d',
        workerTire: '#2f343b',
        workerTireLight: '#515861',
        workerGlass: '#223344',
        workerGlow: '#2fd0ec',
        workerHazard: '#f5b829',
        grenadierAmmo: '#7c8a45',
        grenadierHazard: '#f5b829',
        crystalDeep: '#1f3fc8',
        crystalBody: '#2b7dff',
        crystalLight: '#38cfff',
        crystalTip: '#a8f7ff',
        crystalRock: '#667085',
        crystalRockDark: '#4a5263',
        crystalRockLight: '#7a8498',
        wreckHull: '#6d747b',
        wreckDark: '#343a40',
        wreckGlow: '#ff8a3d'
    }
};
