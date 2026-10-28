// Voice command matching. Checked in order, so negative phrases ("not ok",
// "not approved") are tested before the positive words they contain.
// finalOnly: wait until speech recognition has the whole phrase, so the "ok"
// in "not ok" can't approve while "not" is still being recognised.

const OK = '(?:ok|okay|o\\.\\s?k\\.?|k)';
// Hindi "theek" as speech recognition may spell it (Latin or Devanagari).
const THEEK = '(?:theek|thik|theak|teek|tik|thick|ठीक)';
const NAHI = '(?:nahi|nahin|nahee|nai|नहीं|नही)';
const HAI = '(?:hai|hain|he|hey|है|हैं)';
const START = '(?:^|\\s)', END = '(?=\\s|$|[.,!?।])';

export const COMMANDS = [
  { re: new RegExp(`\\b(?:not|no|nahi)\\s+${OK}(?![a-z])`), decision: 'reject' },
  { re: new RegExp(`${START}(?:${THEEK}\\s+${NAHI}|${NAHI}\\s+${THEEK})${END}`), decision: 'reject' },
  { re: new RegExp(`${START}${THEEK}\\s+${HAI}${END}`), decision: 'approve', finalOnly: true },
  { re: /\bnot\s+(?:approved?|accepted?)\b/, decision: 'reject' },
  { re: /\b(?:reject|rejected|rejection|decline)\b/, decision: 'reject' },
  { re: /\b(?:approve|approved|approval|accept)\b/, decision: 'approve' },
  { re: new RegExp(`(?:^|\\s)${OK}(?![a-z])`), decision: 'approve', finalOnly: true },
  { re: /\b(?:skip|next)\b/, decision: 'skip' },
  { re: /\b(?:cancel|wait|undo)\b/, decision: 'cancel' },
  { re: /\b(?:stop|exit|quit)\b/, decision: 'stop' },
];

// Returns { decision, wait } for a transcript. wait = true means it matched a
// final-only phrase on an interim result: check again once the result is final.
export function matchCommand(said, isFinal) {
  const text = said.toLowerCase().trim();
  for (const c of COMMANDS) {
    if (!c.re.test(text)) continue;
    if (c.finalOnly && !isFinal) return { decision: null, wait: true };
    return { decision: c.decision, wait: false };
  }
  return { decision: null, wait: false };
}
