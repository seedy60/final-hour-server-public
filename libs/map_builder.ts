import { uuid } from "@supercharge/strings";
import WorldMap from "./world_map";
import Mapobj, { MapObjProperties } from "./world_map/elements/mapobj";

export interface Corner {
    x: number;
    y: number;
    z: number;
    mapName: string;
}

export interface ElementBounds {
    minx: number;
    maxx: number;
    miny: number;
    maxy: number;
    minz: number;
    maxz: number;
}

export function boundsOf(c1: Corner, c2: Corner): ElementBounds {
    return {
        minx: Math.min(c1.x, c2.x),
        maxx: Math.max(c1.x, c2.x),
        miny: Math.min(c1.y, c2.y),
        maxy: Math.max(c1.y, c2.y),
        minz: Math.min(c1.z, c2.z),
        maxz: Math.max(c1.z, c2.z),
    };
}

export function boundsString(b: ElementBounds): string {
    return `${b.minx} ${b.maxx} ${b.miny} ${b.maxy} ${b.minz} ${b.maxz}`;
}

export function escapeXmlAttr(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function escapeXmlText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function withId(attrs: Record<string, string | number | boolean | undefined>): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined && v !== null && v !== "") {
            out[k] = v;
        }
    }
    if (!out.id) {
        out.id = `b_${uuid().slice(0, 12)}`;
    }
    return out;
}

export function serializeElement(
    type: string,
    attrs: Record<string, string | number | boolean>,
    innerText?: string
): string {
    const parts: string[] = [type];
    for (const [k, v] of Object.entries(attrs)) {
        const s = typeof v === "string" ? v : String(v);
        parts.push(`${k}="${escapeXmlAttr(s)}"`);
    }
    const opening = parts.join(" ");
    if (innerText && innerText.length > 0) {
        return `<${opening}>${escapeXmlText(innerText)}</${type}>`;
    }
    return `<${opening}/>`;
}

const BODY_CLOSE_RE = /([ \t]*)<\/body>/;

export async function insertElements(map: WorldMap, lines: string[]): Promise<void> {
    const data = map.real_data;
    const match = BODY_CLOSE_RE.exec(data);
    if (!match) {
        throw new Error("Could not find </body> in map data to insert into.");
    }
    const indent = (match[1] ?? "") + "    ";
    const block = lines.map((l) => indent + l).join("\n") + "\n";
    const newData = data.slice(0, match.index) + block + data.slice(match.index);
    await map.update(newData);
}

export async function insertElement(map: WorldMap, line: string): Promise<void> {
    return insertElements(map, [line]);
}

function findElementById(
    map: WorldMap,
    id: string
): Mapobj<MapObjProperties> | undefined {
    return map.allElementsIds.get(id);
}

function findElementAt(
    map: WorldMap,
    x: number,
    y: number,
    z: number,
    type?: string
): Mapobj<MapObjProperties> | undefined {
    for (let i = map.allElements.length - 1; i >= 0; i--) {
        const el = map.allElements[i];
        if (type && el.elementName !== type) continue;
        if (el.in_bound(x, y, z)) return el;
    }
    return undefined;
}

export function elementsAt(
    map: WorldMap,
    x: number,
    y: number,
    z: number
): Mapobj<MapObjProperties>[] {
    const out: Mapobj<MapObjProperties>[] = [];
    for (const el of map.allElements) {
        if (el.in_bound(x, y, z)) out.push(el);
    }
    return out;
}

export function elementsWithin(
    map: WorldMap,
    x: number,
    y: number,
    z: number,
    r: number
): Mapobj<MapObjProperties>[] {
    const out: Mapobj<MapObjProperties>[] = [];
    const region = {
        minx: x - r,
        maxx: x + r,
        miny: y - r,
        maxy: y + r,
        minz: z - r,
        maxz: z + r,
    };
    for (const el of map.allElements) {
        if (el.intersects(region)) out.push(el);
    }
    return out;
}

function buildElementRegex(el: Mapobj<MapObjProperties>): RegExp {
    const type = el.elementName;
    return new RegExp(`<${type}\\b[^>]*?\\bid="${escapeRegex(el.id)}"[^>]*/?>`);
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureIdInXml(
    map: WorldMap,
    el: Mapobj<MapObjProperties>
): Promise<void> {
    const re = buildElementRegex(el);
    if (re.test(map.real_data)) return;
    const tagRe = buildPositionalRegex(el);
    const match = tagRe.exec(map.real_data);
    if (!match) {
        throw new Error(
            `Could not locate element ${el.elementName} in source XML to assign id.`
        );
    }
    const original = match[0];
    const withIdTag = original.replace(/(\s*)\/?>(?!.*\/?>)/, ` id="${el.id}"$&`).replace(/ id="([^"]+)" id="([^"]+)"/, ' id="$2"');
    const updated =
        map.real_data.slice(0, match.index) +
        withIdTag +
        map.real_data.slice(match.index + original.length);
    await map.update(updated);
}

function buildPositionalRegex(el: Mapobj<MapObjProperties>): RegExp {
    const type = el.elementName;
    const props = el.properties as MapObjProperties;
    const hasPosition =
        props.minx === props.maxx &&
        props.miny === props.maxy &&
        props.minz === props.maxz;
    if (hasPosition) {
        const pos = `${props.minx} ${props.miny} ${props.minz}`;
        return new RegExp(
            `<${type}\\b[^>]*?\\bposition="${escapeRegex(pos)}"[^>]*/?>`
        );
    }
    const bounds = boundsString({
        minx: props.minx,
        maxx: props.maxx,
        miny: props.miny,
        maxy: props.maxy,
        minz: props.minz,
        maxz: props.maxz,
    });
    return new RegExp(
        `<${type}\\b[^>]*?\\bbounds="${escapeRegex(bounds)}"[^>]*/?>`
    );
}

export async function deleteElementById(
    map: WorldMap,
    id: string
): Promise<Mapobj<MapObjProperties> | undefined> {
    const el = findElementById(map, id);
    if (!el) return undefined;
    await ensureIdInXml(map, el);
    const re = buildElementRegex(el);
    const match = re.exec(map.real_data);
    if (!match) return undefined;
    const newData =
        map.real_data.slice(0, match.index) +
        map.real_data.slice(match.index + match[0].length).replace(/^[ \t]*\r?\n/, "");
    await map.update(newData);
    return el;
}

export async function deleteElementAt(
    map: WorldMap,
    x: number,
    y: number,
    z: number,
    type?: string
): Promise<Mapobj<MapObjProperties> | undefined> {
    const el = findElementAt(map, x, y, z, type);
    if (!el) return undefined;
    return deleteElementById(map, el.id);
}

export async function setElementAttr(
    map: WorldMap,
    id: string,
    attr: string,
    value: string
): Promise<boolean> {
    const el = findElementById(map, id);
    if (!el) return false;
    await ensureIdInXml(map, el);
    const re = buildElementRegex(el);
    const match = re.exec(map.real_data);
    if (!match) return false;
    let tag = match[0];
    const attrRe = new RegExp(`\\b${escapeRegex(attr)}="[^"]*"`);
    if (attrRe.test(tag)) {
        tag = tag.replace(attrRe, `${attr}="${escapeXmlAttr(value)}"`);
    } else {
        tag = tag.replace(/(\s*\/?>)$/, ` ${attr}="${escapeXmlAttr(value)}"$1`);
    }
    const newData =
        map.real_data.slice(0, match.index) +
        tag +
        map.real_data.slice(match.index + match[0].length);
    await map.update(newData);
    return true;
}

export async function renameElementId(
    map: WorldMap,
    oldId: string,
    newId: string
): Promise<boolean> {
    const el = findElementById(map, oldId);
    if (!el) return false;
    await ensureIdInXml(map, el);
    const re = buildElementRegex(el);
    const match = re.exec(map.real_data);
    if (!match) return false;
    const tag = match[0].replace(
        /\bid="[^"]+"/,
        `id="${escapeXmlAttr(newId)}"`
    );
    const newData =
        map.real_data.slice(0, match.index) +
        tag +
        map.real_data.slice(match.index + match[0].length);
    await map.update(newData);
    return true;
}

export const KNOWN_TILE_TYPES = [
    "wood",
    "wallwood",
    "wall",
    "wallglass",
    "wallwindow",
    "metal",
    "carpet",
    "concrete",
    "snow",
    "air",
    "deep_water",
    "underwater",
];

export const BOUNDED_ELEMENT_TYPES = [
    "platform",
    "door",
    "zone",
    "playerSpawn",
    "zombieSpawn",
    "wallbuy",
    "interactable",
    "ambience",
    "soundSource",
    "music",
    "reverb",
] as const;

export const POINT_ELEMENT_TYPES = [
    "perkMachine",
    "powerSwitch",
    "window",
    "pannable",
] as const;

export type BoundedElementType = typeof BOUNDED_ELEMENT_TYPES[number];
export type PointElementType = typeof POINT_ELEMENT_TYPES[number];
