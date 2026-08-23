import {
  EXERCISES,
  MIN_REST_DAYS,
  STORAGE_KEY,
  calendarDayDifference,
  exerciseStatuses,
  localISODate,
  normalizeState,
  recommendSession,
  validateImport,
} from "./logic.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let state = loadState();
let shuffleSeed = 0;
let editingDate = null;
let toastTimer;

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return normalizeState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatDate(isoDate, options = { weekday: "long", day: "numeric", month: "long" }) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(`${isoDate}T12:00:00`));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function showView(name) {
  $("#today-view").hidden = name !== "today";
  $("#history-view").hidden = name !== "history";
  $$("[data-view-link]").forEach((button) => {
    const active = button.dataset.viewLink === name;
    button.classList.toggle("active", active);
    if (button.closest("nav")) active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  if (name === "history") renderHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderToday() {
  const today = localISODate();
  const recommendation = recommendSession(state.sessions, today, state.restDays, shuffleSeed);
  const eligibleCount = recommendation.filter((exercise) => exercise.eligible).length;
  $("#today-label").textContent = formatDate(today).toUpperCase();
  $("#today-summary").textContent = eligibleCount === recommendation.length
    ? `${recommendation.length} exercises, each with ${state.restDays} full rest day${state.restDays === 1 ? "" : "s"}.`
    : `${eligibleCount} fully rested · ${recommendation.length - eligibleCount} included to complete the session.`;

  const existing = state.sessions.find((session) => session.date === today);
  const checked = new Set(existing?.exerciseIds ?? recommendation.map((exercise) => exercise.id));
  $("#recommendations").innerHTML = recommendation.map((exercise) => `
    <label class="exercise-item">
      <input type="checkbox" name="exercise" value="${exercise.id}" ${checked.has(exercise.id) ? "checked" : ""} />
      <span class="checkmark" aria-hidden="true"></span>
      <span>
        <span class="group-label">${exercise.group}</span>
        <span class="exercise-name">${exercise.name}</span>
        ${exercise.eligible ? "" : `<span class="rest-warning">Below rest threshold · ${exercise.daysSince}-day gap · ${exercise.remaining} more rest day${exercise.remaining === 1 ? "" : "s"} preferred</span>`}
      </span>
    </label>
  `).join("");
  $("#log-session").textContent = existing ? "Update today’s session" : "Log selected exercises";
  syncSubmitState();
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

function renderHistory() {
  const today = localISODate();
  $("#status-date").textContent = formatDate(today, { day: "numeric", month: "short" });
  const statuses = exerciseStatuses(state.sessions, today, state.restDays, true);
  $("#exercise-status").innerHTML = statuses.map((exercise) => {
    const last = exercise.lastDate
      ? `Last: ${formatDate(exercise.lastDate, { day: "numeric", month: "short", year: "numeric" })} · ${exercise.daysSince} day${exercise.daysSince === 1 ? "" : "s"} ago`
      : "Never performed";
    const status = exercise.eligible ? "Eligible" : `Resting · ${exercise.remaining}d remaining`;
    return `<article class="status-row">
      <div><p class="group-label">${exercise.group}</p><h3>${exercise.name}</h3><p class="status-meta">${last}</p></div>
      <span class="status-badge ${exercise.eligible ? "" : "resting"}">${status}</span>
    </article>`;
  }).join("");

  const sessions = [...state.sessions].sort((a, b) => b.date.localeCompare(a.date));
  $("#session-history").innerHTML = sessions.length ? sessions.map((session) => {
    const names = session.exerciseIds.map((id) => EXERCISES.find((exercise) => exercise.id === id)?.name).filter(Boolean);
    return `<article class="session-card">
      <div class="session-card-header">
        <p class="session-date">${formatDate(session.date, { weekday: "short", day: "numeric", month: "long", year: "numeric" })}</p>
        <button class="edit-button" type="button" data-edit-date="${session.date}" aria-label="Edit session on ${session.date}">Edit</button>
      </div>
      <p class="session-exercises">${names.join(" · ")}</p>
    </article>`;
  }).join("") : `<p class="empty-state">No sessions logged yet. Your completed sessions will appear here.</p>`;
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
  const payload = { app: "Rotation", version: 1, exportedAt: new Date().toISOString(), ...state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `rotation-backup-${localISODate()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  $("#settings-message").textContent = "Backup exported.";
}

async function importData(file) {
  try {
    const imported = validateImport(JSON.parse(await file.text()));
    const confirmed = window.confirm(`Replace local history with ${imported.sessions.length} imported session${imported.sessions.length === 1 ? "" : "s"}?`);
    if (!confirmed) return;
    state = imported;
    saveState();
    renderToday();
    renderHistory();
    syncSettings();
    $("#settings-message").textContent = "Import complete.";
  } catch (error) {
    $("#settings-message").textContent = error instanceof Error ? error.message : "Import failed.";
  }
}

function syncSettings() {
  const selected = $(`#rest-options input[value="${state.restDays}"]`);
  if (selected) selected.checked = true;
}

document.addEventListener("click", (event) => {
  const viewLink = event.target.closest("[data-view-link]");
  if (viewLink) showView(viewLink.dataset.viewLink);
  const editButton = event.target.closest("[data-edit-date]");
  if (editButton) openSessionEditor(editButton.dataset.editDate);
  if (event.target.closest(".close-dialog")) closeDialog(event.target.closest(".close-dialog"));
});

$("#recommendations").addEventListener("change", syncSubmitState);
$("#shuffle").addEventListener("click", () => { shuffleSeed += 1; renderToday(); });
$("#session-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const ids = $$('#recommendations input:checked').map((input) => input.value);
  upsertSession(localISODate(), ids);
  renderToday();
  showToast("Today’s session saved");
});
$("#past-session").addEventListener("click", () => openSessionEditor());
$("#session-editor").addEventListener("submit", (event) => {
  event.preventDefault();
  const date = $("#session-date").value;
  const ids = $$('#editor-exercises input:checked').map((input) => input.value);
  if (!date || date > localISODate()) { $("#editor-error").textContent = "Choose today or a past date."; return; }
  if (!ids.length) { $("#editor-error").textContent = "Select at least one exercise."; return; }
  if (editingDate && editingDate !== date) state.sessions = state.sessions.filter((session) => session.date !== editingDate);
  upsertSession(date, ids);
  $("#session-dialog").close();
  renderToday();
  renderHistory();
  showToast("Session saved");
});
$("#delete-session").addEventListener("click", () => {
  if (!editingDate || !window.confirm("Delete this session?")) return;
  state.sessions = state.sessions.filter((session) => session.date !== editingDate);
  saveState();
  $("#session-dialog").close();
  renderToday();
  renderHistory();
  showToast("Session deleted");
});
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

renderToday();
syncSettings();
