# Sheepshead Online — Enhanced Five-Player Edition

A phone-friendly five-player Sheepshead web app. Friends can join from separate phones and every empty seat automatically becomes a bot, so the table always starts with five players.

## What is included

- 5-player, 32-card Sheepshead deck and standard trump order.
- Called-ace partner system; no Jack-of-Diamonds partner rule.
- No forced picking.
- All-pass setting: **Leaster** or **Doubler**.
- Crack and re-crack support.
- Black-queen and red-queen blitzers.
- Multipliers are capped at x16.
- Standard zero-sum 1/2/3 Sheepshead scoring, scaled correctly for picker alone vs picker + partner.
- Schneider and sweep/no-trick scoring.
- Optional score-to-cash display at $0.25, $0.50, or $1 per game point.
- Private rooms with optional passwords.
- Names + emoji avatars.
- Game history for completed hands.
- Smarter bots that consider trump strength, card points, team position, and whether a trick is already being won by their side.
- Mobile-first UI, animations, turn highlighting, and card-table layout.
- If a human disconnects after play starts, a bot takes over that seat.

## Can I play it on a phone?

**Yes.** The game itself is designed for phones.

There are two different ideas to separate:

1. **Playing the game:** everyone can use a phone.
2. **Running/hosting the server:** the easiest local setup uses one Mac/Windows/Linux computer. If you deploy the app to an online host once, then nobody needs a computer to play afterward — everyone simply visits the public URL on their phone.

An Android phone can technically host Node.js with tools such as Termux, but the computer or online-host methods are much easier. An iPhone is best used as a player rather than as the local Node.js server.

---

# OPTION A — SAME WI-FI (easiest for a house/game night)

You need one computer on the same Wi-Fi as everyone else's phones.

### 1. Install Node.js on the host computer

Install Node.js 18 or newer from nodejs.org. The current LTS version is fine.

### 2. Unzip this project

Unzip `sheepshead-online.zip` somewhere easy to find, such as Downloads.

The folder should contain:

- `server.js`
- `package.json`
- `public/`

### 3. Open Terminal / Command Prompt in the folder

**Mac:**
- Open Terminal.
- Type `cd ` including the space.
- Drag the `sheepshead-online` folder into the Terminal window.
- Press Return.

**Windows:**
- Open the `sheepshead-online` folder in File Explorer.
- Click the address bar, type `cmd`, and press Enter.

### 4. Install the app packages

Run:

```bash
npm install
```

You only normally need to do this once.

### 5. Start the game server

Run:

```bash
npm start
```

You should see:

```text
Sheepshead running on http://0.0.0.0:3000
```

Keep that Terminal/Command Prompt window open while playing.

### 6. Find the host computer's local IP address

**Mac:**
- System Settings → Wi-Fi.
- Open Details for the connected network.
- Find **IP Address**.
- It will usually look like `192.168.1.24` or `10.0.0.15`.

**Windows:**
- Open Command Prompt.
- Run `ipconfig`.
- Under the Wi-Fi adapter, find **IPv4 Address**.

### 7. Open the game on the host

On the computer, open:

```text
http://localhost:3000
```

Create a table.

### 8. Open the game on every phone

Every phone must be on the **same Wi-Fi** as the host computer.

If the computer's IP is `192.168.1.24`, each phone opens Safari/Chrome and enters:

```text
http://192.168.1.24:3000
```

Do **not** type `localhost` on the phones. `localhost` means the phone itself.

### 9. Join the room

- Host chooses a name/avatar and creates a table.
- Host shares the five-character room code.
- Friends enter that code.
- If you created a password, friends enter it too.
- The host presses **Start 5-player game**.
- Any open seats instantly become bots.

### If phones cannot connect

Check these in order:

1. All devices are actually on the same Wi-Fi.
2. The IP address was entered correctly, including `:3000`.
3. `npm start` is still running on the computer.
4. The host computer did not fall asleep.
5. Windows Firewall/macOS firewall may be blocking Node.js. Allow Node.js to accept connections on the private/local network.
6. Guest Wi-Fi sometimes prevents devices from talking to each other. Use the main Wi-Fi network instead.

---

# OPTION B — PLAY FROM ANYWHERE / PHONE-ONLY AFTER DEPLOYMENT

To play with friends who are not on the same Wi-Fi, deploy the Node app to a public Node-compatible host such as Render, Railway, Fly.io, or a VPS.

The project already reads the hosting provider's `PORT` environment variable, so no code change should normally be needed.

General deployment settings:

```text
Build command: npm install
Start command: npm start
```

After the host gives you a public address such as:

```text
https://your-sheepshead-app.example.com
```

every player simply opens that same address on their phone. One person creates a table and everybody else joins with the room code. At that point, a computer is no longer required during game night because the server is running online.

## Important hosting note

This version keeps active rooms and game history in server memory. If the online server restarts or sleeps, active games disappear. For casual games this is fine. A later production version could add a database, permanent accounts, reconnect tokens, statistics, and saved games.

---

# Rules implemented in this build

The project uses the called-ace five-player style. The picker must call an off-suit ace they do not hold **and must retain at least one card of that fail suit**, or choose to go alone.

Normal scoring is zero-sum:

- Picker + partner ordinary win: picker +2, partner +1, each defender -1.
- Picker alone ordinary win: picker +4, each defender -1.
- Schneider changes the base value from 1 to 2.
- Taking/no-taking all tricks changes the base value from 1 to 3.
- Losses reverse those values.
- Doublers, cracks, re-cracks, and blitzers multiply those game points.

For a leaster, the player with the fewest card points **among players who took at least one trick** gets +4 and every other player gets -1. The blind goes to the winner of the final trick for leaster scoring. A tie for lowest score produces no score change.

Sheepshead has many local house-rule variations, so these settings are deliberately visible in the lobby instead of pretending there is only one universal ruleset.

## v4 visual updates
- Your own avatar is now displayed beside your cards on your device, including picker/partner badges when applicable.
- Court cards use a new original, detailed mirrored court illustration inspired by traditional American playing-card layouts without copying a commercial deck design.
- Pre-play announcements now build line-by-line (picker, called ace/alone, cracks/blitzers, start/lead) and remain on screen until the first card is played.
- Bot actions and trick-clear timing were slowed down so players can follow what happened before the next action.

## v5 table-flow changes

- Every connected human player must press **Start game** before the first hand is dealt. Bots do not need to confirm.
- After the picker calls a suit / goes alone, every connected human presses **Start play** before trick play begins.
- After all five cards of every trick are on the table, the cards stay visible and every connected human must press **Next trick**. On trick 6 the button says **Show hand result**.
- After scoring, every connected human must press **Next round** before the dealer shuffles the next hand.
- The dealer now performs a visible shuffle animation before every deal.
- Your table-side avatar is hidden on your own screen; your avatar remains beside your cards at the bottom.
- Played cards are larger and positioned farther inward toward the center while remaining visually attached to the player who played them.


## v11 bot discard fix
Bot pickers now commit their two-card bury directly from their current 8-card hand, with a watchdog fallback. This prevents the game from remaining stuck in the discard phase.


## v13 changes

- Uses an unbiased Fisher-Yates shuffle driven by Node.js `crypto.randomInt()` for stronger random dealing.
- Enforces the called-ace partner rule server-side for both humans and bots:
  - when the called suit is led, the partner must play the called ace;
  - the called ace cannot be sloughed on another suit while another legal card exists;
  - the partner cannot lead the called suit while they still hold another fail suit;
  - if the called suit is their only fail suit, they may lead it, but must lead the called ace.

### Updating the live Render site
Upload/replace `server.js`, `package.json`, and the `public` folder in the same GitHub repository. Once the commit is saved, Render should auto-deploy the new commit.
