import packageJSON from '../../package.json' with {type: 'json'};
import {type AddProtocolAction, config} from './config.ts';

import type {default as MaplibreWorker} from '../source/worker.ts';
import type {WorkerSourceConstructor} from '../source/worker_source.ts';
import type {GetResourceResponse, RequestParameters} from './ajax.ts';

export interface WorkerGlobalScopeInterface {
    registerWorkerSource: (sourceName: string, sourceConstructor: WorkerSourceConstructor) => void;
    registerRTLTextPlugin: (_: any) => void;
    addProtocol: (customProtocol: string, loadFn: AddProtocolAction) => void;
    removeProtocol: (customProtocol: string) => void;
    makeRequest: (request: RequestParameters, abortController: AbortController) => Promise<GetResourceResponse<any>>;
    worker: MaplibreWorker;
}

function isCrossOrigin(url: string): boolean {
    if (!url) return false;
    const loc = (globalThis as any).location;
    if (!loc) return false;
    try {
        return new URL(url, loc.href).origin !== loc.origin;
    } catch {
        return false;
    }
}

/**
 * The URL of the worker bundle next to this module, carrying the package version as a `v` query
 * parameter so that a browser does not serve a worker cached from an older release.
 */
function defaultWorkerUrl(): string {
    const moduleUrl = import.meta.url;
    if (!/^https?:/.test(moduleUrl)) return '';
    const workerName = moduleUrl.endsWith('-dev.mjs')
        ? 'maplibre-gl-worker-dev.mjs'
        : 'maplibre-gl-worker.mjs';
    const url = new URL(`./${workerName}`, moduleUrl);
    url.searchParams.set('v', packageJSON.version);
    return url.href;
}

function isClassicWorkerUrl(url: string): boolean {
    return url.split(/[?#]/)[0].endsWith('.cjs');
}

function createWorker(url: string, asModule: boolean): Worker {
    if (asModule) {
        try {
            return new Worker(url, {type: 'module'});
        } catch (e) {
            console.warn('Module worker not supported, falling back to classic worker', e);
        }
    }
    return new Worker(url);
}

async function fetchAsBlobUrl(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch worker script (${response.status}): ${url}`);
    }
    const code = await response.text();
    const blob = new Blob([code], {type: 'text/javascript'});
    return URL.createObjectURL(blob);
}

/**
 * Whether a worker URL is served from a file-like scheme (file:// or GeckoView's resource://),
 * directly or relative to a document that was itself loaded from one.
 */
function isFileSchemeUrl(url: string): boolean {
    const scheme = /^(file|resource):/;
    const loc = (globalThis as any).location;
    return scheme.test(url) || (!!loc && scheme.test(loc.href) && !/^\w+:/.test(url));
}

/**
 * A browser will not start a worker from a file:// or resource:// script URL (GeckoView on Android
 * fires `error` on the worker, Chromium treats the origin as opaque), and `fetch` rejects those
 * schemes too. XHR can read them, so load the source that way and run it from a Blob URL as a
 * classic worker - the worker bundle is self-contained, so it runs unchanged as a classic script.
 */
async function xhrAsBlobUrl(url: string): Promise<string> {
    const code = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'text';
        xhr.onload = () => {
            // Non-http schemes report status 0 on success.
            if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
                resolve(xhr.response);
            } else {
                reject(new Error(`Failed to load worker script (${xhr.status}): ${url}`));
            }
        };
        xhr.onerror = () => reject(new Error(`Failed to load worker script: ${url}`));
        xhr.send();
    });
    // The worker bundle is a module only by virtue of a trailing `export {... as default}`
    // that the worker itself never uses; drop it so the script runs as a classic worker.
    const classicCode = code.replace(/\bexport\s*\{[^}]*\}\s*;?(?=\s*(\/\/# sourceMappingURL=\S*\s*)?$)/, '');
    const blob = new Blob([classicCode], {type: 'text/javascript'});
    return URL.createObjectURL(blob);
}

function importAsBlobUrl(url: string): string {
    const blob = new Blob([`import ${JSON.stringify(new URL(url, import.meta.url).href)}`], {type: 'text/javascript'});
    return URL.createObjectURL(blob);
}

export async function workerFactory(): Promise<Worker> {
    const url = config.WORKER_URL || defaultWorkerUrl();
    const asModule = !isClassicWorkerUrl(url);

    if (url && isFileSchemeUrl(url)) {
        const blobUrl = await xhrAsBlobUrl(url);
        try {
            return createWorker(blobUrl, false);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    if (!isCrossOrigin(url)) {
        return createWorker(url, asModule);
    }

    if (asModule) {
        const blobUrl = importAsBlobUrl(url);
        try {
            return createWorker(blobUrl, asModule);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    const blobUrl = await fetchAsBlobUrl(url);
    try {
        return createWorker(blobUrl, asModule);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}
