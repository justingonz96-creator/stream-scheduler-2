'use strict';
// Turn whatever the operator pastes (a full broadcast link, a class link, or a
// bare id) into the durable handles the portal client needs.
const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

function parsePortalLink(input) {
  const s = String(input || '');
  const b = /\/broadcast\/([0-9a-fA-F-]{36})\/([0-9a-fA-F-]{36})/.exec(s);
  if (b) return { contentItemGuid: b[1], scheduleGuid: b[2] };
  const found = s.match(GUID) || [];
  return { contentItemGuid: found[0] || '', scheduleGuid: found[1] || '' };
}

module.exports = { parsePortalLink };
