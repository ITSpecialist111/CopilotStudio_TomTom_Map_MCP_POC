import { readFileSync } from "fs";
import { join } from "path";

interface MapAssets {
  headHtml: string;
  bodyHtml: string;
}

let cached: MapAssets | null = null;

/**
 * Reads `interactive-map-app/index.html` once at startup, splits it into
 * head (CDN tags + styles) and body (DOM markup + transformed IIFE), and
 * rewrites the inline JS so it reads `window.MAP_STATE` instead of URL
 * params. The caller injects `window.MAP_STATE = { … }` before the body
 * script runs.
 */
export function getInteractiveMapAssets(): MapAssets {
  if (cached) return cached;

  const htmlPath = join(__dirname, "..", "..", "interactive-map-app", "index.html");
  const raw = readFileSync(htmlPath, "utf8");

  // ---- Split into head and body ----------------------------------------
  // Head: everything between <head> … </head> (CDN links, styles)
  const headMatch = raw.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const headContent = headMatch ? headMatch[1] : "";

  // Body: everything between <body> … </body>
  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let bodyContent = bodyMatch ? bodyMatch[1] : "";

  // ---- Transform getParams() to read window.MAP_STATE ------------------
  // Replace the URL-param-based getParams function body with MAP_STATE read
  bodyContent = bodyContent.replace(
    /function getParams\(\)\s*\{[\s\S]*?var params = new URLSearchParams[\s\S]*?return \{[\s\S]*?\};\s*\}/,
    `function getParams() {
            var s = window.MAP_STATE || {};
            return {
                apiKey:  s.apiKey || '',
                center:  s.center || '',
                zoom:    parseFloat(s.zoom) || 13,
                markers: s.markers || '',
                route:   s.route || '',
                traffic: s.traffic === true || s.traffic === 'true',
                vizId:   s.vizId || '',
                mcpUrl:  s.mcpUrl || '',
                overlay: s.overlay || '',
                render:  (s.render || '').toLowerCase(),
                cols:    parseInt(s.cols, 10) || 0,
                title:   s.title || 'TomTom Interactive Map'
            };
        }`
  );

  // ---- Replace ASCII toggle URL reload with state mutation -------------
  // The original does window.location.assign(url) — which doesn't work in
  // the Cowork sandbox. Instead, mutate MAP_STATE.render and re-init.
  bodyContent = bodyContent.replace(
    /btnAscii\.addEventListener\('click',\s*function\(\)\s*\{[\s\S]*?window\.location\.assign\([\s\S]*?\}\);/,
    `btnAscii.addEventListener('click', function() {
            var cur = currentRenderMode();
            var next = cur === 'map' ? 'ascii' : (cur === 'ascii' ? 'pixel' : 'map');
            if (window.MAP_STATE) window.MAP_STATE.render = (next === 'map') ? '' : next;
            params.render = (next === 'map') ? '' : next;
            var labels = { map: 'ASCII', ascii: 'Pixel', pixel: 'Normal' };
            if (asciiLabel) asciiLabel.textContent = labels[next] || 'ASCII';
            btnAscii.classList.toggle('active', next !== 'map');
            btnAscii.title = next === 'map' ? 'Switch to live ASCII map'
                : next === 'ascii' ? 'Switch to live pixel map' : 'Back to the normal map';
            init();
        });`
  );

  // ---- Inject applyMapState before the IIFE closing --------------------
  // Insert window.applyMapState just before the })(); at the end of the IIFE
  const applyMapStateFn = `
        window.applyMapState = function(next) {
            if (!next) return;
            if (next.apiKey) { window.MAP_STATE.apiKey = next.apiKey; params.apiKey = next.apiKey; }
            if (next.title) {
                window.MAP_STATE.title = next.title;
                params.title = next.title;
                document.getElementById('header-title').textContent = next.title;
                document.title = next.title;
            }
            if (next.center) { window.MAP_STATE.center = next.center; params.center = next.center; }
            if (next.zoom != null) { window.MAP_STATE.zoom = next.zoom; params.zoom = parseFloat(next.zoom) || 13; }
            if (next.markers) { window.MAP_STATE.markers = next.markers; params.markers = next.markers; }
            if (next.route) { window.MAP_STATE.route = next.route; params.route = next.route; }
            if (next.traffic != null) { window.MAP_STATE.traffic = next.traffic; params.traffic = (next.traffic === true || next.traffic === 'true'); }
            if (next.overlay) { window.MAP_STATE.overlay = next.overlay; params.overlay = next.overlay; }
            if (next.vizId) { window.MAP_STATE.vizId = next.vizId; params.vizId = next.vizId; }
            applyVizData(next);
        };
`;

  // Insert before the boot() function definition or the IIFE close
  bodyContent = bodyContent.replace(
    /(\n\s*function boot\(\))/,
    applyMapStateFn + "$1"
  );

  cached = { headHtml: headContent, bodyHtml: bodyContent };
  return cached;
}
