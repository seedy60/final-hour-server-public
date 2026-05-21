# Final Hour Server

Server runtime for the Final Hour audiogame.

## What you need

- Docker and Docker Compose, recommended
- Or Node.js and npm if you want to run it without containers

## Quick start

### Docker Compose, development

```bash
docker compose -f compose.dev.yml up --build
```

This is the easiest way to get a working server locally. It mounts the whole repo, runs the dev target, and disables Discord integration with `FH_NO_DISCORD=1`.

### Docker Compose, production-style

Before using `compose.yml`, make sure these files exist in the repo root:

- `database.sqlite3`
- `sm.txt`
- `authorised_names`

Then start it with:

```bash
docker compose up --build -d
```

The server listens on UDP port `13000`.

## Local run without Docker

```powershell
New-Item -ItemType File -Force database.sqlite3, sm.txt, authorised_names | Out-Null
npm ci
npm run build
$env:NODE_PATH = "./dist"
$env:FH_NO_DISCORD = "1"
node --enable-source-maps dist/server.js
```

On non-Windows shells:

```bash
export NODE_PATH=./dist
export FH_NO_DISCORD=1
node --enable-source-maps dist/server.js
```

## Runtime files

- `database.sqlite3`: SQLite database, created and migrated on boot
- `maps/`: map files; `main.map` ships with the repo
- `sm.txt`: server message shown to players
- `authorised_names`: usernames that get the beta tester title; matching is case-insensitive
- `contributors.txt`: usernames that get contributor privileges; match the in-game username exactly

## Discord

Discord integration is disabled in the provided Docker files. Leave `FH_NO_DISCORD` set if you do not want the server to log in to Discord.

If you want Discord integration, remove that variable and add a valid token in `libs/consts.ts`.

## Contributor access

Add a username to `contributors.txt` on its own line, using the exact in-game username, then rebuild or restart the server.

## Editing maps

Builders can construct and modify maps from inside the game — no external XML editing required. Players with the `builder` flag on their user record can:

- Mark two corners by walking to them and pressing `m` (or typing `/mark`)
- Drop any element type with `/place …` or `/here …`
- Use macros (`/room`, `/ladder`, `/skylight`, `/doorway`) for repeated shapes
- `/undo` and `/redo` the last 50 edits per map
- Delete or rename elements with `/del`, `/setid`, `/setattr`

Every edit funnels through `WorldMap.update()`, which validates the new XML by compiling it on a throwaway map before overwriting `maps/<name>.map` on disk. Invalid edits are rejected and the live map is untouched.

For the full command list, type `/builderhelp` in chat, or read [`builderhelp.txt`](builderhelp.txt).
