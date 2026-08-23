# Rotation

Rotation is a private, single-user gym session planner that spaces repetitions of individual exercises. It is a dependency-free static site: no account, server, build process, analytics, or network requests.

## How recommendations work

- The exercise library is fixed in `logic.js`.
- A recommendation contains five exercises.
- The default interval is two **full calendar rest days** between repeats. An exercise completed on Monday is next eligible on Thursday.
- The interval can be changed from one to four full rest days in Settings.
- Eligible exercises are ranked by how long it has been since they were performed; never-performed exercises rank first.
- Equal candidates are spread across muscle groups. Three exercises from one group are avoided unless necessary.
- If fewer than five exercises are eligible, the least-recently-performed resting exercises fill the remaining places and are clearly labelled with their actual date gap.
- Shuffle changes tie-breaks without weakening the rest rule.

All date calculations use local calendar dates rather than elapsed timestamps, so daylight-saving and timezone offsets do not distort spacing.

## Data and backups

Sessions are stored in browser `localStorage` under the single key `rotation-gym:v1`, in this form:

```json
{
  "restDays": 2,
  "sessions": [
    { "date": "2026-08-23", "exerciseIds": ["chest-machine", "leg-curl"] }
  ]
}
```

Use **Settings → Export JSON** to download a complete backup. On another device, open Rotation in the browser and use **Settings → Import JSON**. Import replaces the browser's current Rotation history after confirmation. Invalid dates or unknown exercise IDs are rejected.

## Run locally

Because the app uses JavaScript modules, serve the folder over HTTP rather than opening `index.html` directly. For example:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Deploy to GitHub Pages

1. Push this repository and its commit to GitHub.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the branch containing these files (usually `main`) and the **/(root)** folder, then save.
5. GitHub will publish the site at `https://<account>.github.io/<repository>/`.

All asset paths are relative, so the app works from a project subpath without configuration.

## Files

```text
.
├── README.md
├── app.js
├── index.html
├── logic.js
└── styles.css
```
