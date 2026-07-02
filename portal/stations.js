'use strict';
// Pure logic ported from 1.x: each Echelon control-station embeds its Mux live
// stream — the RTMP ingest URL + stream key OBS 1.x used, and our engine uses now.
// The stream key is a credential: callers must never log or display it.

function parseStations(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function stationIngest(stations, stationGuid) {
  const s = stations.find(x => x && typeof x === 'object' && x.guid === stationGuid);
  if (!s) return { ok: false, error: 'The studio for this class was not found.' };
  const rtmp = s.rtmpUrl || {};
  const server = rtmp.secure || rtmp.standard;
  const key = (s.mux || {}).streamKey;
  if (!server || !key) return { ok: false, error: 'This studio has no stream ingest set up.' };
  return { ok: true, server, key, stationName: s.name || '' };
}

function stationSummaries(stations) {
  return stations.filter(s => s && s.guid && s.name).map(s => ({ name: s.name, guid: s.guid }));
}

module.exports = { parseStations, stationIngest, stationSummaries };
