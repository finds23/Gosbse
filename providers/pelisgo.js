/**
 * PelisGO (pelisgo.online) - plugin para Nuvio / addon Svdjksba
 * Flujo: TMDB -> titulo -> /api/search?q= -> slug de la serie
 *        -> pagina /series/<slug>/temporada/<T>/episodio/<E> -> episodeId (datos de Next.js)
 *        -> POST /api/session/sync -> sid
 *        -> GET /api/series/episode/<episodeId>/stream con cabecera x-session-id -> links[]
 *        -> Voe | Okru (cada uno con sus opciones HLS y MP4)
 * Voe suele fallar dentro del addon de Render (403), pero fuera del addon funciona.
 */
var PG_BASE = "https://pelisgo.online";
var AJ_BASE = PG_BASE; // los extractores copiados usan AJ_BASE como Referer por defecto
var TMDB_API_KEY = "56db0ec297530920213e1503706b81ff";
var UA = "Mozilla/5.0 (Linux; Android 13; moto g82 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

var _nativeFetch = fetch;
function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error("tiempo agotado (" + label + ")")); }, ms);
    Promise.resolve(promise).then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}
function pgFetch(url, opts) { return withTimeout(_nativeFetch(url, opts), 10000, String(url).replace(/^https?:\/\//, "").split("/")[0]); }

var ENABLED_SOURCES = {
  Voe: true,   // puede dar 403 desde Render; fuera del addon funciona
  Okru: true   // solo reproduce si el video existe en ok.ru
};
var VERSION = "1.1.0";
var DEBUG = true; // muestra una entrada DIAGNOSTICO si algo falla. Poner en false cuando todo funcione.
var TRACE = [];
function trace(msg) { TRACE.push(String(msg).replace(/\s+/g, " ").slice(0, 140)); }
function shortErr(e) { return String(e && e.message || e).replace(/ en https?:\/\/\S+/, ""); }
var SERVER_ORDER = ["Okru", "Voe"];

// ---------- utilidades ----------
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function slugify(s) {
  return norm(s).replace(/['\u2019`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function decodeEntities(s) {
  return String(s || "").replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function looksBlocked(html) {
  return /just a moment|cf-chl|challenge-platform|attention required|enable javascript and cookies/i.test(html || "");
}
async function fetchText(url, headers) {
  var resp = await pgFetch(url, { headers: Object.assign({ "User-Agent": UA }, headers || {}) });
  if (!resp.ok) throw new Error("HTTP " + resp.status + " en " + url);
  return resp.text();
}

function describeHtml(html) {
  var t = /<title[^>]*>([^<]*)/i.exec(html || "");
  return (html || "").length + "b" +
    ", packer=" + (/eval\(function\(p,a,c,k,e,[a-z]\)/.test(html) ? "si" : "no") +
    ", m3u8=" + (/m3u8/.test(html) ? "si" : "no") +
    ", links=" + (/var\s+links\s*=/.test(html) ? "si" : "no") +
    ", sources=" + (/sources\s*:/.test(html) ? "si" : "no") +
    (looksBlocked(html) ? ", CLOUDFLARE" : "") +
    ", titulo=" + (t ? t[1].trim().slice(0, 30) : "?");
}
function hostOf(u) { try { return new URL(u).host; } catch (e) { return "?"; } }
function ajOrigin(u) { var m = /^(https?:\/\/[^\/?#]+)/i.exec(u || ""); return m ? m[1] : ""; }

// ---------- extractores (copiados de animejara-1.js) ----------
var VOE_MARKERS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
function voeRot13(str) {
  return str.replace(/[a-zA-Z]/g, function (c) {
    var code = c.charCodeAt(0), base = code <= 90 ? 65 : 97;
    return String.fromCharCode((code - base + 13) % 26 + base);
  });
}
function decodeVoePayload(raw) {
  var x = voeRot13(raw);
  VOE_MARKERS.forEach(function (mk) { x = x.split(mk).join("_"); });
  x = x.split("_").join("");
  x = atob(x);
  x = Array.from(x).map(function (c) { return String.fromCharCode((c.charCodeAt(0) - 3 + 256) % 256); }).join("");
  x = x.split("").reverse().join("");
  x = atob(x);
  return JSON.parse(x);
}
async function extractVoe(embedUrl, ctx) {
  async function getHtml(url) {
    var resp = await pgFetch(url, { headers: { "User-Agent": UA, "Referer": (ctx && ctx.referer) || AJ_BASE + "/" } });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " en " + url);
    return { html: await resp.text(), url: resp.url || url };
  }
  var page = await getHtml(embedUrl);
  var jsRedirect = page.html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
  if (jsRedirect) page = await getHtml(jsRedirect[1]);
  var sm = page.html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!sm) throw new Error("VOE: no se encontro el JSON del embed");
  var arr = JSON.parse(decodeEntities(sm[1].trim()).replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  if (!Array.isArray(arr) || !arr[0]) throw new Error("VOE: payload inesperado");
  var decoded = decodeVoePayload(arr[0]);
  var origin;
  try { origin = new URL(page.url).origin; } catch (e) { origin = new URL(embedUrl).origin; }
  var out = [];
  if (decoded.source) {
    out.push({ url: decoded.source, type: "hls", tag: "HLS", headers: { "Referer": origin + "/", "User-Agent": UA } });
  }
  var mp4 = decoded.fallback && decoded.fallback[0] && decoded.fallback[0].file;
  if (mp4) out.push({ url: mp4, tag: "MP4", headers: { "User-Agent": UA } });
  if (!out.length) throw new Error("VOE: sin source ni fallback");
  return out;
}


function okDecode(s) {
  return String(s || "").replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
var OK_QUALITY = ["mobile", "lowest", "low", "sd", "hd", "full", "quad", "ultra"];
function parseOkru(html) {
  var m = /data-options=(["'])([\s\S]*?)\1/.exec(html);
  var meta = null;
  if (m) {
    try {
      var opts = JSON.parse(okDecode(m[2]));
      var raw = opts && opts.flashvars && opts.flashvars.metadata;
      meta = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!meta && opts && opts.flashvars && opts.flashvars.metadataUrl) return { metadataUrl: opts.flashvars.metadataUrl };
    } catch (e) { /* se prueba con regex */ }
  }
  var out = [];
  if (meta) {
    var hls = meta.hlsManifestUrl || meta.hlsMasterPlaylistUrl || meta.ondemandHls;
    if (hls) out.push({ url: hls, type: "hls", tag: "HLS" });
    var vids = (meta.videos || []).filter(function (v) { return v && v.url; });
    vids.sort(function (a, b) { return OK_QUALITY.indexOf(b.name) - OK_QUALITY.indexOf(a.name); });
    if (vids[0]) out.push({ url: vids[0].url, tag: "MP4 " + vids[0].name });
    return { streams: out };
  }
  var txt = okDecode(html).replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  var hm = /"hlsManifestUrl"\s*:\s*"([^"]+)"/.exec(txt) || /"ondemandHls"\s*:\s*"([^"]+)"/.exec(txt);
  if (hm) out.push({ url: hm[1], type: "hls", tag: "HLS" });
  return { streams: out };
}
async function extractOkru(embedUrl, ctx) {
  if (embedUrl.indexOf("//") === 0) embedUrl = "https:" + embedUrl;
  var html = await fetchText(embedUrl, { "Referer": (ctx && ctx.referer) || AJ_BASE + "/" });
  var r = parseOkru(html);
  if (!r.streams || !r.streams.length) {
    trace("embed okru: " + describeHtml(html) + ", data-options=" + (/data-options=/.test(html) ? "si" : "no"));
    throw new Error("No se encontro el video en Okru");
  }
  return r.streams.map(function (v) {
    var o = { url: v.url, tag: v.tag, headers: { "Referer": "https://ok.ru/", "User-Agent": UA } };
    if (v.type) o.type = v.type;
    return o;
  });
}



// ---------- PelisGO ----------
function pgHeaders(referer, extra) {
  var h = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
    "Referer": referer || PG_BASE + "/"
  };
  return Object.assign(h, extra || {});
}
async function pgJson(url, opts) {
  var r = await pgFetch(url, opts);
  var t = await r.text();
  var j = null;
  try { j = JSON.parse(t); } catch (e) { /* no era JSON */ }
  if (!r.ok) throw new Error("HTTP " + r.status + " en " + hostOf(url) + (j && j.error ? " (" + j.error + ")" : ""));
  if (!j) throw new Error("respuesta no JSON en " + hostOf(url));
  return j;
}

var TMDB_YEAR = null;
var PG_SID = "";
async function getTMDBTitles(tmdbId) {
  var base = "https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  var langs = ["es-MX", "en-US"];
  var titles = [];
  for (var i = 0; i < langs.length; i++) {
    try {
      var d = await pgFetch(base + "&language=" + langs[i], { headers: { "User-Agent": UA } }).then(function (r) { return r.json(); });
      if (!d || d.success === false) continue;
      if (d.first_air_date && !TMDB_YEAR) TMDB_YEAR = parseInt(String(d.first_air_date).slice(0, 4), 10);
      [d.name, d.original_name].forEach(function (t) { if (t && titles.indexOf(t) === -1) titles.push(t); });
    } catch (e) { /* siguiente idioma */ }
  }
  return titles;
}

function scoreTitle(a, b) {
  var x = slugify(a), y = slugify(b);
  if (!x || !y) return 0;
  if (x === y) return 3;
  if (x.indexOf(y) !== -1 || y.indexOf(x) !== -1) return 2;
  var tx = x.split("-"), ty = y.split("-");
  var common = tx.filter(function (t) { return t.length > 2 && ty.indexOf(t) !== -1; }).length;
  return common / Math.max(tx.length, ty.length);
}
async function findSeriesSlug(titles) {
  var best = null;
  for (var i = 0; i < titles.length; i++) {
    var queries = [titles[i]];
    var short = titles[i].split(/[:\-\u2013]/)[0].trim();
    if (short && short !== titles[i]) queries.push(short);
    for (var q = 0; q < queries.length; q++) {
      var data;
      try {
        data = await pgJson(PG_BASE + "/api/search?q=" + encodeURIComponent(queries[q]), { headers: pgHeaders(PG_BASE + "/", { "Accept": "application/json" }) });
      } catch (e) { trace("busqueda '" + queries[q] + "': " + shortErr(e)); continue; }
      var res = (data.results || []).filter(function (r) { return r.type === "serie"; });
      trace("busqueda '" + queries[q] + "': " + res.length + " series");
      res.forEach(function (r) {
        var s = Math.max.apply(null, titles.map(function (t) { return scoreTitle(t, r.title); }));
        if (TMDB_YEAR && r.year && Math.abs(r.year - TMDB_YEAR) <= 1) s += 0.5;
        if (!best || s > best.score) best = { slug: r.slug, title: r.title, score: s };
      });
      if (best && best.score >= 2.5) return best;
    }
  }
  return best && best.score >= 1.2 ? best : null;
}

async function getEpisodeId(slug, season, episode) {
  var url = PG_BASE + "/series/" + slug + "/temporada/" + season + "/episodio/" + episode;
  var resp = await pgFetch(url, { headers: pgHeaders(PG_BASE + "/series/" + slug) });
  var html = await resp.text();
  if (!resp.ok) { trace("pagina episodio: HTTP " + resp.status + " " + describeHtml(html)); throw new Error("HTTP " + resp.status + " en la pagina del episodio"); }
  var m = /episodeId\\?":\\?"([a-z0-9]{15,})/.exec(html) || /episodeId=([a-z0-9]{15,})/.exec(html);
  if (!m) { trace("sin episodeId: " + describeHtml(html)); throw new Error("no se encontro episodeId"); }
  return { id: m[1], url: url };
}

async function getLinks(episodeId, pageUrl) {
  var sync = await pgJson(PG_BASE + "/api/session/sync", {
    method: "POST",
    headers: pgHeaders(pageUrl, { "Content-Type": "application/json", "Accept": "application/json", "Origin": PG_BASE }),
    body: "{}"
  });
  if (!sync.sid) throw new Error("session/sync sin sid");
  PG_SID = sync.sid;
  var api = PG_BASE + "/api/series/episode/" + episodeId + "/stream";
  var data;
  try {
    data = await pgJson(api, { headers: pgHeaders(pageUrl, { "Accept": "application/json", "x-session-id": sync.sid }) });
  } catch (e) {
    trace("stream con cabecera: " + shortErr(e));
    data = await pgJson(api + "?sid=" + encodeURIComponent(sync.sid), { headers: pgHeaders(pageUrl, { "Accept": "application/json" }) });
  }
  return data.links || [];
}

var EXTRACTORS = {
  Voe: { label: "VOE", extract: extractVoe },
  Okru: { label: "Okru", extract: extractOkru }
};
function findSourceKey(serverName, serverUrl) {
  var n = norm(serverName).replace(/[^a-z0-9]/g, "");
  var key = null;
  if (n.indexOf("voe") !== -1) key = "Voe";
  else if (n.indexOf("okru") !== -1) key = "Okru";
  if (!key && serverUrl) {
    var h = hostOf(serverUrl).toLowerCase();
    if (/voe/.test(h)) key = "Voe";
    else if (/ok\.ru/.test(h)) key = "Okru";
  }
  return key && ENABLED_SOURCES[key] ? key : null;
}
function langInfo(l) {
  var n = norm(l);
  if (n.indexOf("latin") !== -1) return { order: 0, label: "\uD83C\uDDF2\uD83C\uDDFD LATINO" };
  if (n.indexOf("castell") !== -1 || n.indexOf("espa") !== -1) return { order: 1, label: "\uD83C\uDDEA\uD83C\uDDF8 CASTELLANO" };
  if (n.indexOf("sub") !== -1) return { order: 2, label: "\uD83C\uDDEC\uD83C\uDDE7 SUBTITULADO" };
  return { order: 3, label: String(l || "?").toUpperCase() };
}

// ---------- punto de entrada ----------
async function getStreamsInner(tmdbId, type, season, episode) {
  TRACE = [];
  TMDB_YEAR = null;
  PG_SID = "";
  trace("PelisGO v" + VERSION);
  if (!tmdbId || type !== "tv") {
    trace("solo soporta series (tipo recibido: " + type + ", id: " + tmdbId + ")");
    return diagnostic();
  }
  try {
    var seasonNum = season ? Number(season) : 1;
    var episodeNum = episode !== undefined ? Number(episode) : 1;
    var slug;
    var direct = /^slug:([a-z0-9][a-z0-9\-]*)$/i.exec(String(tmdbId));
    if (direct) {
      slug = direct[1].toLowerCase();
      trace("slug directo: " + slug);
    } else {
      var titles = await getTMDBTitles(tmdbId);
      if (!titles.length) { trace("TMDB sin titulos"); return diagnostic(); }
      trace("TMDB: " + titles.slice(0, 2).join(" / ") + " (" + TMDB_YEAR + ") T" + seasonNum + "E" + episodeNum);
      var found = await findSeriesSlug(titles);
      if (!found) { trace("serie no encontrada en PelisGO"); return diagnostic(); }
      slug = found.slug;
      trace("serie: " + slug + " (puntos " + found.score.toFixed(1) + ")");
    }
    var ep = await getEpisodeId(slug, seasonNum, episodeNum);
    trace("episodeId " + ep.id);
    var links = await getLinks(ep.id, ep.url);
    trace("servidores: " + links.map(function (l) { return l.server; }).join(","));

    var jobs = links.map(async function (lk) {
      var key = findSourceKey(lk.server, lk.url);
      if (!key) return null;
      var source = EXTRACTORS[key];
      try {
        var resolved = await withTimeout(source.extract(lk.url, { referer: ep.url }), 35000, source.label);
        var list = Array.isArray(resolved) ? resolved : [resolved];
        var li = langInfo(lk.language);
        return list.map(function (v) {
          var o = {
            name: "PelisGO",
            title: "",
            url: v.url,
            quality: "\uD83D\uDCFA " + source.label + (v.tag ? " (" + v.tag + ")" : "") + "\n" + (lk.quality || "1080p") + " | WEB-DL\n" + li.label +
              "\n\uD83D\uDD17 T" + seasonNum + "E" + episodeNum + " \u00B7 " + ep.url,
            headers: v.headers,
            _lang: li.order,
            _rank: SERVER_ORDER.indexOf(key)
          };
          if (v.type) o.type = v.type;
          return o;
        });
      } catch (e) {
        trace(source.label + " fallo: " + shortErr(e));
        console.warn("[" + source.label + "] fallo: " + e.message);
        return null;
      }
    });
    var results = [];
    (await Promise.all(jobs)).filter(Boolean).forEach(function (arr) { results = results.concat(arr); });
    results.sort(function (a, b) { return a._lang !== b._lang ? a._lang - b._lang : a._rank - b._rank; });
    results.forEach(function (r) { delete r._lang; delete r._rank; });
    console.log("[PelisGO] " + results.length + " streams");
    if (results.length === 0) return diagnostic();
    if (DEBUG && TRACE.some(function (t) { return /fallo/.test(t); })) results = results.concat(diagnostic());
    return results;
  } catch (e) {
    trace("error: " + shortErr(e));
    console.error("[PelisGO] Error: " + e.message);
    return diagnostic();
  }
}

// Entrada informativa (no reproducible) para ver en la lista de Nuvio por que no salio nada
function diagnostic() {
  if (!DEBUG) return [];
  return [{
    name: "PelisGO",
    title: "",
    url: PG_BASE + "/",
    quality: "\uD83D\uDEE0 DIAGNOSTICO (no reproducir)\n" + TRACE.join("\n"),
    headers: {}
  }];
}

async function getStreams(tmdbId, type, season, episode) {
  try {
    return await withTimeout(getStreamsInner(tmdbId, type, season, episode), 45000, "PelisGO");
  } catch (e) {
    trace("global: " + shortErr(e));
    return diagnostic();
  }
}

exports.getStreams = getStreams;
