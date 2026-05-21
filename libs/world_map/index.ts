import fs from "fs/promises";
import consts from "../consts";
import * as template from "../template";
import quadtree, { QuadtreeItem } from "quadtree-lib";
import astar from "../astar";
import * as random from "../random";
import parse_data from "../map_data_parser";
import Server from "../networking";
import Player from "../objects/player";
import { Stream } from "stream";
import Game from "../game_mode";
import Game_object from "../objects/object";
import Vector3 from "../astar/vector3";
import PlayerContainer from "../player_container";
import Mapobj, { MapObjProperties } from "./elements/mapobj";
import SpawnZone from "./elements/spawn_zone";
import Door from "./elements/door";
import Wallbuy from "./elements/wallbuy";
import Platform from "./elements/platform";
import Interactable from "./elements/interactable";
import PerkMachine from "../objects/perk_machine";
import mapElements from "./elements";
import { XmlDocument, XmlElement } from "xmldoc";
import { uuid } from "@supercharge/strings";
import { parseValue, to_num } from "../string_utils";
import path from "path";
import { MapObjectExport, exportedMap } from "./types";
import Zone from "./elements/zone";
import Ambience from "./elements/ambience";
import SoundSource from "./elements/sound_source";
import Music from "./elements/music";
import { Reverb } from "./elements/reverb";
import WrappedWorldMap, {
    WrappedWorldMapInterface,
} from "../map_scripts/wrapped_world_map";
import EventEmitter from "../event_emitter";
import { WrappedEntityInterface } from "../map_scripts/wrapped_entity";
import MapScript from "./script";
import TickExecutor from "../tick_executor";

interface Point {
    x: number;
    y: number;
    z: number;
}

export interface EntityQuery {
    x: number;
    width?: number;
    y: number;
    height?: number;
    z: number;
    max_z?: number;
}

export default class WorldMap extends PlayerContainer {
    playersQuadtree: Quadtree<Player>;
    mapName: string;
    data: string;
    doors: Door[] = [];
    platforms: Platform[] = [];
    playerSpawns: SpawnZone[] = [];
    zomby_spawns: SpawnZone[] = [];
    wallbuys: Wallbuy[] = [];
    interactables: Interactable[] = [];
    allElementsIds = new Map<string, Mapobj<MapObjProperties>>();
    allElements: Mapobj<MapObjProperties>[] = [];
    rebuiltElements: Mapobj<MapObjProperties>[] = [];
    minx: number;
    miny: number;
    minz: number;
    maxx: number;
    maxy: number;
    maxz: number;
    public_: boolean = false;
    round_sounds: number = 1;
    objects: quadtree<Game_object>;
    astar?: astar;
    real_data: string = "";
    game?: Game;
    isPowerOn: boolean = false;
    wrapped: WrappedWorldMapInterface;
    wrappedEvents = new EventEmitter<WrappedEntityInterface>();
    script?: MapScript;
    undoStack: string[] = [];
    redoStack: string[] = [];
    static UNDO_LIMIT = 50;
    private tickExecutor: TickExecutor;
    private destroied: boolean = false;
    constructor(server: Server, name: string, maxx = 10, maxy = 10, maxz = 15) {
        super(server);
        this.data = "";
        this.mapName = name;
        this.minx = 0;
        this.miny = 0;
        this.minz = 0;
        this.maxx = maxx;
        this.maxy = maxy;
        this.maxz = maxz;
        this.playersQuadtree = new quadtree({
            width: this.maxx + 1,
            height: this.maxy + 1,
            maxElements: 4,
        });
        this.objects = new quadtree({
            width: this.maxx + 1,
            height: this.maxy + 1,
            maxElements: 30,
        });
        this.wrapped = WrappedWorldMap(this);
        this.tickExecutor = new TickExecutor(this.server, this.loop.bind(this));
        this.tickExecutor.start();
    }
    interact(interacter: Player): void {}
    in_bound(x: number, y: number, z: number): boolean {
        return (
            x >= this.minx &&
            x <= this.maxx &&
            y >= this.miny &&
            y <= this.maxy &&
            z >= this.minz &&
            z <= this.maxz
        );
    }
    is_unwalkable(map: WorldMap, x: number, y: number, z: number): boolean {
        var tile = map.get_tile_at(x, y, z);
        return (
            !tile ||
            (tile.includes("wall") && tile != "wallwindow") ||
            tile == "air"
        );
    }
    update_pathfinder(): void {
        this.astar = new astar(
            this,
            { min: this.minx, max: this.maxx },
            { min: this.miny, max: this.maxy },
            { min: this.minz, max: this.maxz },
            this.is_unwalkable
        );
    }
    async find_path(
        start_x: number,
        start_y: number,
        start_z: number,
        end_x: number,
        end_y: number,
        end_z: number
    ): Promise<Vector3[]> {
        try {
            if (this.astar) {
                return await this.astar.path(
                    start_x,
                    start_y,
                    start_z,
                    end_x,
                    end_y,
                    end_z,
                    {
                        timeout: 100,
                    }
                );
            } else {
                return [];
            }
        } catch (err) {
            console.log(err);
            return [];
        }
    }
    get_zomby_spawn(): { x: number; y: number; z: number } {
        const possible_spawn_areas: SpawnZone[] = [];
        for (let spawn_area of this.zomby_spawns) {
            if (spawn_area.isActive) {
                if (spawn_area.zBound) {
                    let done: boolean = false; // We can't use the `break` statement during a loop like this, so we use this variable as a work around.
                    this.playersQuadtree.each((player) => {
                        if (
                            !done &&
                            player.z <= spawn_area.maxz &&
                            player.z >= spawn_area.minz
                        ) {
                            possible_spawn_areas.push(spawn_area);
                            done = true;
                        }
                    });
                } else {
                    possible_spawn_areas.push(spawn_area);
                }
            }
        }
        if (!possible_spawn_areas.length)
            return { x: this.minx, y: this.miny, z: this.minz };
        var spawn_area =
            possible_spawn_areas[
                random.random_number(0, possible_spawn_areas.length - 1)
            ];
        return {
            x: random.random_number(spawn_area.minx, spawn_area.maxx),
            y: random.random_number(spawn_area.miny, spawn_area.maxy),
            z: random.random_number(spawn_area.minz, spawn_area.maxz),
        };
    }
    get_player_spawn(): { x: number; y: number; z: number } {
        const possible_spawn_areas: SpawnZone[] = this.playerSpawns;
        if (!possible_spawn_areas.length)
            return { x: this.minx, y: this.miny, z: this.minz };
        var spawn_area =
            possible_spawn_areas[
                random.random_number(0, possible_spawn_areas.length - 1)
            ];
        return {
            x: random.random_number(spawn_area.minx, spawn_area.maxx),
            y: random.random_number(spawn_area.miny, spawn_area.maxy),
            z: random.random_number(spawn_area.minz, spawn_area.maxz),
        };
    }
    get_tile_at(x: number, y: number, z: number): string {
        for (let i = this.platforms.length - 1; i >= 0; i--) {
            if (this.platforms[i].in_bound(x, y, z)) {
                return this.platforms[i].type;
            }
        }
        return "air";
    }
    get_wallbuy_at(x: number, y: number, z: number): Wallbuy | null {
        for (let i = this.wallbuys.length - 1; i >= 0; i--) {
            if (this.wallbuys[i].in_bound(x, y, z)) {
                return this.wallbuys[i];
            }
        }
        return null;
    }
    get_door_at(x: number, y: number, z: number): Door | null {
        for (var i of this.doors.slice().reverse()) {
            if (i.in_bound(x, y, z)) {
                return i;
            }
        }
        return null;
    }
    valid_straight_path(
        obj1: Point,
        obj2: Point
    ): true | [number, number, number, string] {
        var x = Math.round(obj1.x);
        var y = Math.round(obj1.y);
        var z = Math.round(obj1.z);
        const dist_x = Math.round(obj2.x);
        const dist_y = Math.round(obj2.y);
        const dist_z = Math.round(obj2.z);
        while (true) {
            var i = this.get_tile_at(x, y, z);
            if (i.includes("wall")) {
                return [x, y, z, i];
            }
            if (x == dist_x && y == dist_y && z == dist_z) {
                return true;
            }
            if (x > dist_x) --x;
            else if (x < dist_x) ++x;
            if (y > dist_y) --y;
            else if (y < dist_y) ++y;
            if (z > dist_z) --z;
            else if (z < dist_z) ++z;
        }
    }
    get_players_at({
        x,
        width = 1,
        y,
        height = 1,
        z,
        max_z,
    }: {
        x: number;
        y: number;
        height: number;
        width: number;
        z: number;
        max_z?: number;
    }): Player[] {
        max_z = max_z ?? z;
        let res: Player[] = [];
        for (var i of this.playersQuadtree.colliding({
            x: x,
            y: y,
            width: width,
            height: height,
        })) {
            if (i.z >= z && i.z <= max_z) {
                res.push(i);
            }
        }
        return res;
    }
    get_objects_at(
        { x, width = 1, y, height = 1, z, max_z }: EntityQuery,
        include_players = true,
        exclude_unhittables = true
    ): Game_object[] {
        max_z = max_z ?? z;
        let res: Game_object[] = [];
        for (var i of this.objects.colliding({
            x: x,
            y: y,
            width: width,
            height: height,
        })) {
            if (i.z >= z && i.z <= max_z) {
                if (!exclude_unhittables || i.hittable) res.push(i);
            }
        }
        if (include_players) {
            res = [
                ...res,
                ...this.get_players_at({
                    x: x,
                    y: y,
                    z: z,
                    width: width,
                    height: height,
                    max_z: max_z,
                }),
            ];
        }
        return res;
    }
    get_objects_of_type_at<T extends Game_object>(
        position: {
            x: number;
            width?: number | undefined;
            y: number;
            height?: number | undefined;
            z: number;
            max_z?: number | undefined;
        },
        target_type: { new (...args: any[]): T }
    ): T[] {
        let res: T[] = [];
        for (let obj of this.get_objects_at(position, false)) {
            if (obj instanceof target_type) res.push(obj);
        }
        return res;
    }
    add_object(obj: Game_object, x = 0, y = 0, z = 0) {
        obj.x = x;
        obj.y = y;
        obj.z = z;
        if (obj instanceof Player) {
            this.add_player(obj, x, y, z);
        } else {
            this.objects.push(obj, true);
            this.wrappedEvents.emit("entityAdded", obj.wrapped);
            this.playersQuadtree.each((i) => {
                i.send(consts.channel_map, "spawn_entity", {
                    name: obj.name,
                    x: obj.x,
                    y: obj.y,
                    z: obj.z,
                });
            });
        }
    }
    remove_object(obj: Game_object) {
        if (obj instanceof Player) {
            this.remove_player(obj);
        } else {
            this.objects.remove(obj);
            this.wrappedEvents.emit("entityRemoved", obj.wrapped);
            this.playersQuadtree.each((i) => {
                i.send(consts.channel_map, "remove_entity", {
                    name: obj.name,
                });
            });
        }
    }
    add(player: Player): boolean {
        const result = super.add(player);
        if (result) {
            this.wrappedEvents.emit("playerAdded", player.wrapped);
        }
        return result;
    }
    remove(player: Player): boolean {
        const result = super.remove(player);
        if (result) {
            this.wrappedEvents.emit("playerRemoved", player.wrapped);
        }
        return result;
    }
    add_player(player: Player, x = 0, y = 0, z = 0): void {
        if (!this.add(player)) return;
        player.send(consts.channel_map, "parse_map", {
            name: this.mapName,
            data: this.ExportToClient(),
            x: x,
            y: y,
            z: z,
        });
        //tell the player about everyone on this map...
        this.playersQuadtree.each((i) => {
            player.send(consts.channel_map, "spawn_entity", {
                name: i.name,
                x: i.x,
                y: i.y,
                z: i.z,
                voice_channel: i.voice_channel,
                player: true,
                beacon: true,
            });
        });
        //tell the player about all the objects in this map...
        this.objects.each((i) => {
            player.send(consts.channel_map, "spawn_entity", {
                name: i.name,
                x: i.x,
                y: i.y,
                z: i.z,
            });
        });
        //tell everyone on this map about the new player...
        this.send(
            consts.channel_map,
            "spawn_entity",
            {
                name: player.name,
                x: x,
                y: y,
                z: z,
                voice_channel: player.voice_channel,
                player: true,
                beacon: true,
            },
            [player.name]
        );
        this.playersQuadtree.push(player, true);
        this.objects.each((i) => {
            if (i instanceof PerkMachine && i.isActive) {
                i.activate();
            }
        });
    }
    play_unbound(
        sound: string,
        x: number,
        y: number,
        z: number,
        volume = 100,
        streaming = false
    ): void {
        this.playersQuadtree.each((i) => {
            i.play_unbound(sound, x, y, z, volume, streaming);
        });
    }
    remove_player(player: Player) {
        if (!this.remove(player)) return;
        this.playersQuadtree.remove(player);
        //tell the player's client to remove all players...
        this.playersQuadtree.each((i) => {
            player.send(consts.channel_map, "remove_entity", { name: i.name });
        });
        //tell the player's client to remove all objects...
        this.objects.each((i) => {
            player.send(consts.channel_map, "remove_entity", {
                name: i.name,
            });
        });
        //tell everyone in this map to remove that player...
        this.send(consts.channel_map, "remove_entity", { name: player.name });
    }
    send_area(
        channel: number,
        event: string,
        data: {
            name: string;
            sound: string;
            looping: boolean;
            volume: number;
            streaming: boolean;
            id: string;
            dist_path: any;
        },
        location: QuadtreeItem,
        excludes: string[] = []
    ): void {
        for (var i of this.playersQuadtree.colliding(location)) {
            if (!excludes.includes(i.name)) i.send(channel, event, data);
        }
    }
    chat(message: string, buffer = "chat") {
        this.speak(message, false, buffer, "ui/chat.ogg");
    }
    destroy_objects(): void {
        var objs: Game_object[] = [];
        this.objects.each((obj) => objs.push(obj));
        for (let i of objs) {
            i.destroy();
        }
    }
    async update(newData: string): Promise<void> {
        const previous = this.real_data;
        await this._applyData(newData);
        if (previous && previous !== newData) {
            this.undoStack.push(previous);
            if (this.undoStack.length > WorldMap.UNDO_LIMIT) {
                this.undoStack.shift();
            }
            this.redoStack = [];
        }
    }
    async undo(): Promise<boolean> {
        const previous = this.undoStack.pop();
        if (previous === undefined) return false;
        const current = this.real_data;
        await this._applyData(previous);
        this.redoStack.push(current);
        if (this.redoStack.length > WorldMap.UNDO_LIMIT) {
            this.redoStack.shift();
        }
        return true;
    }
    async redo(): Promise<boolean> {
        const next = this.redoStack.pop();
        if (next === undefined) return false;
        const current = this.real_data;
        await this._applyData(next);
        this.undoStack.push(current);
        if (this.undoStack.length > WorldMap.UNDO_LIMIT) {
            this.undoStack.shift();
        }
        return true;
    }
    private async _applyData(newData: string): Promise<void> {
        // Validate by compiling on a temp map first. If invalid, throw before touching the live map.
        await WorldMap.compileMapXmlFromString(
            new WorldMap(
                this.server,
                this.mapName,
                this.maxx,
                this.maxy,
                this.maxz
            ),
            newData
        );
        const path = `maps/${this.mapName}.map`;
        await fs.writeFile(path, newData);
        this.platforms = [];
        this.playerSpawns = [];
        this.zomby_spawns = [];
        this.doors = [];
        this.allElements = [];
        this.wallbuys = [];
        this.destroy_objects();
        await WorldMap.compileMapXmlFromString(this, newData);
        this.send(consts.channel_map, "update_map", {
            data: this.ExportToClient(),
        });
    }
    ExportToClient(): exportedMap {
        function doExport(
            element: Mapobj<MapObjProperties>
        ): MapObjectExport<MapObjProperties> {
            return element.export();
        }
        return {
            minx: this.minx,
            maxx: this.maxx,
            miny: this.miny,
            maxy: this.maxy,
            minz: this.minz,
            maxz: this.maxz,
            elements: this.allElements
                .filter(
                    (element) =>
                        element instanceof Platform ||
                        element instanceof Zone ||
                        element instanceof Ambience ||
                        element instanceof SoundSource ||
                        element instanceof Music ||
                        element instanceof Door ||
                        element instanceof Reverb
                )
                .map(doExport),
        };
    }
    destroyMapScript(): void {
        this.wrappedEvents.removeAllListeners();
        this.objects.each((entity) =>
            entity.wrappedEvents.removeAllListeners()
        );
        this.players.forEach((entity) =>
            entity.wrappedEvents.removeAllListeners()
        );
    }
    async loop(): Promise<void> {
        const updates: MapObjectExport<MapObjProperties>[] = [];
        for (const rebuiltElement of this.rebuiltElements) {
            updates.push(rebuiltElement.export());
        }
        if (updates.length > 0) {
            this.rebuiltElements = [];
            this.send(consts.channel_map, "rebuild_elements", {
                elements: updates,
            });
        }
    }
    destroy(): void {
        if (!this.destroied) {
            this.destroied = true;
            this.tickExecutor.cancel();
        }
    }
    static async compileMapFromFile(
        server: Server,
        filePath: string
    ): Promise<WorldMap> {
        const map = new WorldMap(
            server,
            path.basename(filePath).split(".")[0],
            10,
            10,
            10
        );
        return this.compileMapXmlFromString(
            map,
            await fs.readFile(filePath, { encoding: "utf-8" })
        );
    }
    static async compileMapXmlFromString(
        map: WorldMap,
        text: string
    ): Promise<WorldMap> {
        map.real_data = text;
        return await this.compileMapXml(
            map,
            new XmlDocument(await template.render_string(text))
        );
    }
    static async compileMapXml(
        map: WorldMap,
        doc: XmlDocument
    ): Promise<WorldMap> {
        map.destroyMapScript();
        map.allElementsIds.clear();
        const mapElement = doc.name === "map" ? doc : doc.childNamed("map");
        if (!mapElement) {
            throw new Error("<map> element is missing.");
        }
        const headElement = mapElement.childNamed("head");
        const bodyElement = mapElement.childNamed("body");
        if (!headElement) {
            throw new Error("<head> element is missing.");
        }
        if (!bodyElement) {
            throw new Error("<body> element is missing.");
        }
        const defaultRefBounds = {
            minx: 0,
            maxx: 0,
            miny: 0,
            maxy: 0,
            minz: 0,
            maxz: 0,
        };
        const refBounds = parseBounds(mapElement, defaultRefBounds);
        map.minx = refBounds.minx;
        map.maxx = refBounds.maxx;
        map.miny = refBounds.miny;
        map.maxy = refBounds.maxy;
        map.minz = refBounds.minz;
        map.maxz = refBounds.maxz;
        const semanticElements = parseBodyOrArea(bodyElement, defaultRefBounds);
        if (semanticElements.length <= 0) {
            throw new Error("No elements inside <body>");
        }
        for (const element of semanticElements) {
            if (element.type in mapElements) {
                new mapElements[element.type](map, element.properties);
            }
        }
        if (headElement.childNamed("public")) {
            map.public_ = true;
        } else {
            map.public_ = false;
        }
        if (headElement.childNamed("roundSounds")) {
            map.round_sounds = to_num(headElement.childNamed("roundSounds")?.val ?? "1");
        }
        map.update_pathfinder();
        const scriptElement = mapElement.childNamed("script");
        if (scriptElement) {
            map.script = new MapScript(map, scriptElement.val);
            try {
                await map.script.execute();
            } catch (err) {
                if (map.players.size > 0) {
                    map.speak((err as Error).toString());
                } else {
                    map.server.speakbuilders((err as Error).toString());
                }
            }
        }
        return map;
    }
}
interface Bounds {
    minx: number;
    maxx: number;
    miny: number;
    maxy: number;
    minz: number;
    maxz: number;
}

function parseBounds(element: XmlElement, refBounds: Bounds): Bounds {
    const bounds: Bounds = {
        minx: refBounds.minx,
        maxx: refBounds.maxx,
        miny: refBounds.miny,
        maxy: refBounds.maxy,
        minz: refBounds.minz,
        maxz: refBounds.maxz,
    };
    if (element.attr.position) {
        const positionValues = element.attr.position.split(" ").map(parseFloat);
        if (positionValues.length !== 3) {
            throw new Error(
                `Position should have exactly 3 space-separated values.`
            );
        }
        bounds.minx = refBounds.minx + positionValues[0];
        bounds.maxx = refBounds.minx + positionValues[0];
        bounds.miny = refBounds.miny + positionValues[1];
        bounds.maxy = refBounds.miny + positionValues[1];
        bounds.minz = refBounds.minz + positionValues[2];
        bounds.maxz = refBounds.minz + positionValues[2];
    } else if (element.attr.bounds) {
        const boundsValues = element.attr.bounds.split(" ").map(parseFloat);
        if (boundsValues.length !== 6) {
            throw new Error(
                `Bounds should have exactly 6 space-separated values.`
            );
        }
        bounds.minx = refBounds.minx + boundsValues[0];
        bounds.maxx = refBounds.minx + boundsValues[1];
        bounds.miny = refBounds.miny + boundsValues[2];
        bounds.maxy = refBounds.miny + boundsValues[3];
        bounds.minz = refBounds.minz + boundsValues[4];
        bounds.maxz = refBounds.minz + boundsValues[5];
    }
    return bounds;
}
interface ParsedSemanticElement {
    type: string;
    properties: MapObjProperties;
    innerText?: string;
}

function parseBodyOrArea(
    element: XmlElement,
    refBounds: Bounds
): ParsedSemanticElement[] {
    const semanticElements: ParsedSemanticElement[] = [];
    for (const childElement of element.children) {
        if (!(childElement instanceof XmlElement)) continue; //Escape any text
        if (childElement.name === "area") {
            // If it is an area, recurse inside that area to flatten it.
            semanticElements.push(
                ...parseBodyOrArea(
                    childElement,
                    parseBounds(childElement, refBounds)
                )
            );
            continue;
        }
        const parsedElement: ParsedSemanticElement = {
            type: childElement.name,
            properties: {
                ...parseBounds(childElement, refBounds),
                id: childElement.attr.id ?? uuid(),
                _class: childElement.attr.class,
                innerText: childElement.val,
                ...Object.fromEntries(
                    // This unreadable mess converts attribute key-value pairs to parsed values. It creates a derived object with the same keys, but the values are parsed. This way is supposedly faster than a loop.
                    Object.entries(childElement.attr).map(([key, value]) => [
                        key,
                        parseValue(value),
                    ])
                ),
            },
        };
        semanticElements.push(parsedElement);
    }
    return semanticElements;
}
