import {
  EXERCISES,
  MIN_REST_DAYS,
  STORAGE_KEY,
  exerciseStatuses,
  localISODate,
  mergeHistories,
  normalizeState,
  recommendReplacement,
  recommendSession,
  validateImport,
} from "./logic.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const groups = [...new Set(EXERCISES.map((exercise) => exercise.group))];

let state = loadState();
let shuffleSeed = 0;
let editingDate = null;
let currentRecommendation = [];
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12);
let pendingImport = null;
let deferredInstallPrompt = null;
let toastTimer;
let undoCallback = null;

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return normalizeState();
  }
}

function cloneState(value = state) {
  return JSON.parse(JSON.stringify(value));
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatDate(isoDate, options = { weekday: "long", day: "numeric", month: "long" }) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(`${isoDate}T12:00:00`));
}

function formatDateTime(isoDateTime) {
  if (!isoDateTime) return null;
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function showToast(message, onUndo = null) {
  const toast = $("#toast");
  $("#toast-message").textContent = message;
  undoCallback = onUndo;
  $("#toast-action").hidden = !onUndo;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
    undoCallback = null;
  }, onUndo ? 6000 : 3000);
}

function restoreState(previousState) {
  state = normalizeState(previousState);
  saveState();
  renderToday();
  renderHistory();
  syncSettings();
}

function showView(name) {
  $("#today-view").hidden = name !== "today";
  $("#history-view").hidden = name !== "history";
  $$('[data-view-link]').forEach((button) => {
    const active = button.dataset.viewLink === name;
    button.classList.toggle("active", active);
    if (button.closest("nav")) active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  if (name === "history") renderHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function recommendationReason(exercise) {
  if (!exercise.lastDate) return "Never performed · highest priority";
  if (exercise.eligible) return `Last performed ${formatDate(exercise.lastDate, { day: "numeric", month: "short" })} · ${exercise.daysSince}-day gap`;
  if (exercise.remaining === 1) return `Below rest threshold · available again tomorrow · ${exercise.daysSince}-day gap`;
  return `Below rest threshold · ${exercise.remaining} more rest days preferred · ${exercise.daysSince}-day gap`;
}

function renderRecommendationList(checkedIds) {
  const checked = new Set(checkedIds);
  $("#recommendations").innerHTML = currentRecommendation.map((exercise) => `
    <div class="exercise-item">
      <label class="exercise-select">
        <input type="checkbox" name="exercise" value="${exercise.id}" ${checked.has(exercise.id) ? "checked" : ""} />
        <span class="checkmark" aria-hidden="true"></span>
        <span>
          <span class="group-label">${exercise.group}</span>
          <span class="exercise-name">${exercise.name}</span>
          <span class="exercise-reason ${exercise.eligible ? "" : "rest-warning"}">${recommendationReason(exercise)}</span>
        </span>
      </label>
      <button class="replace-button" type="button" data-replace="${exercise.id}" aria-label="Replace ${exercise.name}">Replace</button>
    </div>
  `).join("");
  syncSubmitState();
}

function renderToday() {
  const today = localISODate();
  currentRecommendation = recommendSession(state.sessions, today, state.restDays, shuffleSeed);
  const eligibleCount = currentRecommendation.filter((exercise) => exercise.eligible).length;
  const existing = state.sessions.find((session) => session.date === today);
  $("#today-label").textContent = formatDate(today).toUpperCase();
  $("#today-summary").textContent = eligibleCount === currentRecommendation.length
    ? `${currentRecommendation.length} exercises, each with ${state.restDays} full rest day${state.restDays === 1 ? "" : "s"}.`
    : `${eligibleCount} fully rested · ${currentRecommendation.length - eligibleCount} included to complete the session.`;
  $("#logged-indicator").hidden = !existing;
  renderRecommendationList(existing?.exerciseIds ?? currentRecommendation.map((exercise) => exercise.id));
  $("#log-session").textContent = existing ? "Update today’s session" : "Log selected exercises";
}

function replaceExercise(exerciseId) {
  const checked = new Set($$('#recommendations input:checked').map((input) => input.value));
  const oldWasChecked = checked.delete(exerciseId);
  const candidate = recommendReplacement(state.sessions, localISODate(), state.restDays, currentRecommendation.map((exercise) => exercise.id), ++shuffleSeed);
  if (!candidate) {
    showToast("No other exercise is available");
    return;
  }
  currentRecommendation = currentRecommendation.map((exercise) => exercise.id === exerciseId ? candidate : exercise);
  if (oldWasChecked) checked.add(candidate.id);
  renderRecommendationList(checked);
  showToast(`Replaced with ${candidate.name}`);
}

function syncSubmitState() {
  $("#log-session").disabled = $$('#recommendations input:checked').length === 0;
}

function upsertSession(date, ids) {
  state.sessions = state.sessions.filter((session) => session.date !== date);
  state.sessions.push({ date, exerciseIds: [...new Set(ids)] });
  state.sessions.sort((a, b) => a.date.localeCompare(b.date));
  saveState();
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const today = localISODate();
  const trainedDates = new Set(state.sessions.map((session) => session.date));
  const firstWeekday = (new Date(year, month, 1, 12).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0, 12).getDate();
  const cells = Array.from({ length: firstWeekday }, () => `<span class="calendar-day empty"></span>`);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = localISODate(new Date(year, month, day, 12));
    const trained = trainedDates.has(iso);
    const classes = ["calendar-day", trained ? "trained" : "", iso === today ? "today" : ""].filter(Boolean).join(" ");
    cells.push(trained
      ? `<button class="${classes}" type="button" data-edit-date="${iso}" aria-label="Edit logged session on ${formatDate(iso)}">${day}</button>`
      : `<span class="${classes}">${day}</span>`);
  }
  $("#calendar-heading").textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(calendarCursor);
  $("#history-calendar").innerHTML = cells.join("");
  const now = new Date();
  $("#calendar-next").disabled = year === now.getFullYear() && month === now.getMonth();
}

function exerciseCount(exerciseId) {
  return state.sessions.reduce((count, session) => count + Number(session.exerciseIds.includes(exerciseId)), 0);
}

function filteredSessions() {
  const group = $("#group-filter").value;
  const exerciseId = $("#exercise-filter").value;
  return [...state.sessions]
    .filter((session) => {
      if (exerciseId !== "all" && !session.exerciseIds.includes(exerciseId)) return false;
      if (group !== "all" && !session.exerciseIds.some((id) => EXERCISES.find((exercise) => exercise.id === id)?.group === group)) return false;
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function renderSessionHistory() {
  const sessions = filteredSessions();
  $("#session-history").innerHTML = sessions.length ? sessions.map((session) => {
    const names = session.exerciseIds.map((id) => EXERCISES.find((exercise) => exercise.id === id)?.name).filter(Boolean);
    return `<article class="session-card">
      <div class="session-card-header">
        <p class="session-date">${formatDate(session.date, { weekday: "short", day: "numeric", month: "long", year: "numeric" })}</p>
        <button class="edit-button" type="button" data-edit-date="${session.date}" aria-label="Edit session on ${session.date}">Edit</button>
      </div>
      <p class="session-exercises">${names.join(" · ")}</p>
    </article>`;
  }).join("") : `<p class="empty-state">No sessions match these filters.</p>`;
}

function renderHistory() {
  const today = localISODate();
  $("#status-date").textContent = formatDate(today, { day: "numeric", month: "short" });
  renderCalendar();
  const statuses = exerciseStatuses(state.sessions, today, state.restDays, true);
  $("#exercise-status").innerHTML = statuses.map((exercise) => {
    const count = exerciseCount(exercise.id);
    const last = exercise.lastDate
      ? `Last: ${formatDate(exercise.lastDate, { day: "numeric", month: "short", year: "numeric" })} · ${exercise.daysSince} day${exercise.daysSince === 1 ? "" : "s"} ago`
      : "Never performed";
    const status = exercise.eligible ? "Eligible" : `Resting · ${exercise.remaining}d remaining`;
    return `<article class="status-row">
      <div><p class="group-label">${exercise.group}</p><h3>${exercise.name}</h3><p class="status-meta">${last}<br />Completed ${count} time${count === 1 ? "" : "s"}</p></div>
      <span class="status-badge ${exercise.eligible ? "" : "resting"}">${status}</span>
    </article>`;
  }).join("");
  renderSessionHistory();
}

function initialiseFilters() {
  $("#group-filter").innerHTML += groups.map((group) => `<option value="${group}">${group}</option>`).join("");
  $("#exercise-filter").innerHTML += EXERCISES.map((exercise) => `<option value="${exercise.id}">${exercise.name}</option>`).join("");
}

function editorExerciseMarkup(selectedIds = []) {
  const selected = new Set(selectedIds);
  let lastGroup = null;
  return EXERCISES.map((exercise) => {
    const groupHeading = exercise.group !== lastGroup ? `<p class="group-label editor-group">${exercise.group}</p>` : "";
    lastGroup = exercise.group;
    return `${groupHeading}<label class="editor-option"><input type="checkbox" name="editor-exercise" value="${exercise.id}" ${selected.has(exercise.id) ? "checked" : ""} /><span>${exercise.name}</span></label>`;
  }).join("");
}

function openSessionEditor(date = localISODate()) {
  const session = state.sessions.find((item) => item.date === date);
  editingDate = session?.date ?? null;
  $("#editor-title").textContent = session ? "Edit session" : "Log a session";
  $("#session-date").value = date;
  $("#session-date").max = localISODate();
  $("#editor-exercises").innerHTML = editorExerciseMarkup(session?.exerciseIds);
  $("#delete-session").hidden = !session;
  $("#editor-error").textContent = "";
  $("#session-dialog").showModal();
}

function closeDialog(button) {
  button.closest("dialog").close();
}

function exportData() {
  const exportedAt = new Date().toISOString();
  state.lastExportedAt = exportedAt;
  saveState();
  const payload = { app: "Rotation", version: 2, exportedAt, ...state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `rotation-backup-${localISODate()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  syncSettings();
  $("#settings-message").textContent = "Backup exported.";
}

function showImportPreview(imported) {
  pendingImport = imported;
  const dates = imported.sessions.map((session) => session.date).sort();
  const exerciseTotal = imported.sessions.reduce((total, session) => total + session.exerciseIds.length, 0);
  $("#import-preview").innerHTML = `
    <div class="preview-stat"><strong>${imported.sessions.length}</strong><span>session${imported.sessions.length === 1 ? "" : "s"}</span></div>
    <div class="preview-stat"><strong>${exerciseTotal}</strong><span>completed exercises</span></div>
    <div class="preview-stat"><strong>${imported.restDays}</strong><span>rest days setting</span></div>
    <div class="preview-stat"><strong>${dates.length ? `${formatDate(dates[0], { day: "numeric", month: "short", year: "2-digit" })}–${formatDate(dates.at(-1), { day: "numeric", month: "short", year: "2-digit" })}` : "Empty"}</strong><span>date range</span></div>`;
  $("#import-dialog").showModal();
}

async function importData(file) {
  try {
    showImportPreview(validateImport(JSON.parse(await file.text())));
    $("#settings-message").textContent = "";
  } catch (error) {
    $("#settings-message").textContent = error instanceof Error ? error.message : "Import failed.";
  }
}

function applyImport(mode) {
  if (!pendingImport) return;
  const previous = cloneState();
  if (mode === "merge") {
    state = mergeHistories(state, pendingImport);
  } else {
    state = normalizeState({ ...pendingImport, lastExportedAt: state.lastExportedAt, installDismissedAt: state.installDismissedAt });
  }
  saveState();
  $("#import-dialog").close();
  renderToday();
  renderHistory();
  syncSettings();
  pendingImport = null;
  showToast(`Import ${mode === "merge" ? "merged" : "replaced"} successfully`, () => restoreState(previous));
}

function syncSettings() {
  const selected = $(`#rest-options input[value="${state.restDays}"]`);
  if (selected) selected.checked = true;
  const exportDate = formatDateTime(state.lastExportedAt);
  $("#backup-date").textContent = exportDate ? `Last backup: ${exportDate}` : "No backup exported yet.";
}

function setupInstallPrompt() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone || state.installDismissedAt) return;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $("#install-copy").textContent = "In Safari, tap Share, then Add to Home Screen. Rotation will also work offline.";
    $("#install-app").textContent = "Got it";
    $("#install-prompt").hidden = false;
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!state.installDismissedAt) $("#install-prompt").hidden = false;
});

window.addEventListener("appinstalled", () => {
  $("#install-prompt").hidden = true;
  showToast("Rotation installed");
});

document.addEventListener("click", (event) => {
  const viewLink = event.target.closest("[data-view-link]");
  if (viewLink) showView(viewLink.dataset.viewLink);
  const editButton = event.target.closest("[data-edit-date]");
  if (editButton) openSessionEditor(editButton.dataset.editDate);
  const replaceButton = event.target.closest("[data-replace]");
  if (replaceButton) replaceExercise(replaceButton.dataset.replace);
  if (event.target.closest(".close-dialog")) closeDialog(event.target.closest(".close-dialog"));
});

$("#recommendations").addEventListener("change", syncSubmitState);
$("#shuffle").addEventListener("click", () => { shuffleSeed += 1; renderToday(); });
$("#session-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const previous = cloneState();
  const ids = $$('#recommendations input:checked').map((input) => input.value);
  upsertSession(localISODate(), ids);
  renderToday();
  renderHistory();
  showToast("Today’s session saved", () => restoreState(previous));
});
$("#past-session").addEventListener("click", () => openSessionEditor());
$("#session-editor").addEventListener("submit", (event) => {
  event.preventDefault();
  const date = $("#session-date").value;
  const ids = $$('#editor-exercises input:checked').map((input) => input.value);
  if (!date || date > localISODate()) { $("#editor-error").textContent = "Choose today or a past date."; return; }
  if (!ids.length) { $("#editor-error").textContent = "Select at least one exercise."; return; }
  const collision = state.sessions.some((session) => session.date === date && session.date !== editingDate);
  if (collision && !window.confirm("A session already exists on this date. Replace it?")) return;
  const previous = cloneState();
  if (editingDate && editingDate !== date) state.sessions = state.sessions.filter((session) => session.date !== editingDate);
  upsertSession(date, ids);
  $("#session-dialog").close();
  renderToday();
  renderHistory();
  showToast("Session saved", () => restoreState(previous));
});
$("#delete-session").addEventListener("click", () => {
  if (!editingDate || !window.confirm("Delete this session?")) return;
  const previous = cloneState();
  state.sessions = state.sessions.filter((session) => session.date !== editingDate);
  saveState();
  $("#session-dialog").close();
  renderToday();
  renderHistory();
  showToast("Session deleted", () => restoreState(previous));
});
$("#toast-action").addEventListener("click", () => {
  if (undoCallback) undoCallback();
  undoCallback = null;
  $("#toast").classList.remove("visible");
});
$("#calendar-previous").addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1, 12); renderCalendar(); });
$("#calendar-next").addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1, 12); renderCalendar(); });
$("#group-filter").addEventListener("change", renderSessionHistory);
$("#exercise-filter").addEventListener("change", renderSessionHistory);
$("#settings-open").addEventListener("click", () => { syncSettings(); $("#settings-message").textContent = ""; $("#settings-dialog").showModal(); });
$("#rest-options").addEventListener("change", (event) => {
  state.restDays = Number(event.target.value) || MIN_REST_DAYS;
  saveState();
  renderToday();
  renderHistory();
  $("#settings-message").textContent = `Rest interval set to ${state.restDays} day${state.restDays === 1 ? "" : "s"}.`;
});
$("#export-data").addEventListener("click", exportData);
$("#import-data").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importData(file); event.target.value = ""; });
$("#merge-import").addEventListener("click", () => applyImport("merge"));
$("#replace-import").addEventListener("click", () => applyImport("replace"));
$("#install-app").addEventListener("click", async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#install-prompt").hidden = true;
  } else {
    state.installDismissedAt = new Date().toISOString();
    saveState();
    $("#install-prompt").hidden = true;
    showToast("Use Safari Share → Add to Home Screen");
  }
});
$("#dismiss-install").addEventListener("click", () => {
  state.installDismissedAt = new Date().toISOString();
  saveState();
  $("#install-prompt").hidden = true;
});

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js"));

initialiseFilters();
renderToday();
renderHistory();
syncSettings();
setupInstallPrompt();
