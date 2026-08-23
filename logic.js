export const MIN_REST_DAYS = 2;
export const SESSION_SIZE = 5;
export const STORAGE_KEY = "rotation-gym:v1";

export const EXERCISES = Object.freeze([
  { id: "chest-machine", group: "Chest", name: "Chest Machine" },
  { id: "pec-fly-machine", group: "Chest", name: "Pec Fly Machine" },
  { id: "dumbbell-incline", group: "Chest", name: "Dumbbell Incline" },
  { id: "shoulder-machine", group: "Shoulders", name: "Shoulder Machine" },
  { id: "cables", group: "Shoulders", name: "Cables" },
  { id: "cable-curl", group: "Arms", name: "Cable Curl" },
  { id: "tricep-cable", group: "Arms", name: "Tricep Cable" },
  { id: "bicep-curl", group: "Arms", name: "Bicep Curl" },
  { id: "leg-curl", group: "Legs", name: "Leg Curl" },
  { id: "leg-press", group: "Legs", name: "Leg Press" },
  { id: "lat-pulldown", group: "Back", name: "Lat Pulldown" },
  { id: "delt-fly", group: "Back", name: "Delt-Fly" },
].map(Object.freeze));

const exerciseIds = new Set(EXERCISES.map((exercise) => exercise.id));

export function localISODate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function isValidISODate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
  const parsed = parseLocalDate(isoDate);
  return !Number.isNaN(parsed.getTime()) && localISODate(parsed) === isoDate;
}

export function calendarDayDifference(fromISO, toISO) {
  const from = parseLocalDate(fromISO);
  const to = parseLocalDate(toISO);
  const fromUTC = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const toUTC = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toUTC - fromUTC) / 86400000);
}

export function normalizeState(candidate = {}) {
  const restDays = Number(candidate.restDays);
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
        .filter((session) => session && isValidISODate(session.date) && Array.isArray(session.exerciseIds))
        .map((session) => ({
          date: session.date,
          exerciseIds: [...new Set(session.exerciseIds.filter((id) => exerciseIds.has(id)))],
        }))
        .filter((session) => session.exerciseIds.length > 0)
    : [];

  const byDate = new Map();
  sessions.forEach((session) => byDate.set(session.date, session));
  return {
    restDays: Number.isInteger(restDays) && restDays >= 1 && restDays <= 4 ? restDays : MIN_REST_DAYS,
    sessions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    lastExportedAt: typeof candidate.lastExportedAt === "string" ? candidate.lastExportedAt : null,
    installDismissedAt: typeof candidate.installDismissedAt === "string" ? candidate.installDismissedAt : null,
  };
}

export function exerciseStatuses(sessions, targetDate, restDays, includeTargetDate = false) {
  return EXERCISES.map((exercise) => {
    const previousDates = sessions
      .filter((session) => (includeTargetDate ? session.date <= targetDate : session.date < targetDate) && session.exerciseIds.includes(exercise.id))
      .map((session) => session.date)
      .sort();
    const lastDate = previousDates.at(-1) ?? null;
    const daysSince = lastDate ? calendarDayDifference(lastDate, targetDate) : Infinity;
    const fullRestDays = lastDate ? Math.max(0, daysSince - 1) : Infinity;
    return {
      ...exercise,
      lastDate,
      daysSince,
      fullRestDays,
      eligible: lastDate === null || fullRestDays >= restDays,
      remaining: lastDate === null ? 0 : Math.max(0, restDays - fullRestDays),
    };
  });
}

function seededTie(seed, id) {
  let hash = seed | 0;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

function rankAndSpread(pool, count, seed, initialGroupCounts = new Map()) {
  const selected = [];
  const remaining = [...pool];
  const groupCounts = new Map(initialGroupCounts);

  while (selected.length < count && remaining.length) {
    const alternativesBelowCap = remaining.some((item) => (groupCounts.get(item.group) ?? 0) < 2);
    remaining.sort((a, b) => {
      const aCapped = alternativesBelowCap && (groupCounts.get(a.group) ?? 0) >= 2 ? 1 : 0;
      const bCapped = alternativesBelowCap && (groupCounts.get(b.group) ?? 0) >= 2 ? 1 : 0;
      if (aCapped !== bCapped) return aCapped - bCapped;
      if (a.daysSince !== b.daysSince) return b.daysSince - a.daysSince;
      const groupDifference = (groupCounts.get(a.group) ?? 0) - (groupCounts.get(b.group) ?? 0);
      if (groupDifference !== 0) return groupDifference;
      return seededTie(seed, a.id) - seededTie(seed, b.id);
    });
    const next = remaining.shift();
    selected.push(next);
    groupCounts.set(next.group, (groupCounts.get(next.group) ?? 0) + 1);
  }
  return selected;
}

export function recommendSession(sessions, targetDate, restDays = MIN_REST_DAYS, seed = 0) {
  const statuses = exerciseStatuses(sessions, targetDate, restDays);
  const eligible = statuses.filter((item) => item.eligible);
  const selected = rankAndSpread(eligible, SESSION_SIZE, seed);
  if (selected.length < SESSION_SIZE) {
    const selectedIds = new Set(selected.map((item) => item.id));
    const fallback = statuses.filter((item) => !selectedIds.has(item.id) && !item.eligible);
    selected.push(...rankAndSpread(fallback, SESSION_SIZE - selected.length, seed + 7919));
  }
  return selected;
}

export function recommendReplacement(sessions, targetDate, restDays, currentIds, seed = 0) {
  const excluded = new Set(currentIds);
  const statuses = exerciseStatuses(sessions, targetDate, restDays).filter((item) => !excluded.has(item.id));
  const groupCounts = new Map();
  currentIds.forEach((id) => {
    const exercise = EXERCISES.find((item) => item.id === id);
    if (exercise) groupCounts.set(exercise.group, (groupCounts.get(exercise.group) ?? 0) + 1);
  });
  const eligible = rankAndSpread(statuses.filter((item) => item.eligible), 1, seed, groupCounts);
  if (eligible.length) return eligible[0];
  return rankAndSpread(statuses.filter((item) => !item.eligible), 1, seed + 7919, groupCounts)[0] ?? null;
}

export function mergeHistories(current, imported) {
  const merged = new Map(current.sessions.map((session) => [session.date, new Set(session.exerciseIds)]));
  imported.sessions.forEach((session) => {
    const ids = merged.get(session.date) ?? new Set();
    session.exerciseIds.forEach((id) => ids.add(id));
    merged.set(session.date, ids);
  });
  return normalizeState({
    ...current,
    sessions: [...merged].map(([date, ids]) => ({ date, exerciseIds: [...ids] })),
  });
}

export function validateImport(candidate) {
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.sessions)) {
    throw new Error("This file is not a Rotation export.");
  }
  for (const session of candidate.sessions) {
    if (!session || !isValidISODate(session.date) || !Array.isArray(session.exerciseIds)) {
      throw new Error("One or more sessions has an invalid format.");
    }
    if (session.exerciseIds.some((id) => !exerciseIds.has(id))) {
      throw new Error("The file contains an exercise outside the fixed library.");
    }
  }
  return normalizeState(candidate);
}
