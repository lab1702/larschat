function parseBefore(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseLimit(value, defaultLimit = 50, maxLimit = 100) {
  const n = parseInt(value, 10) || defaultLimit;
  return Math.max(1, Math.min(n, maxLimit));
}

module.exports = { parseBefore, parseLimit };
