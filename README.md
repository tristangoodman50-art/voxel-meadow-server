# Voxel Meadow with multiplayer

One small Node server that serves the game and relays multiplayer messages.

## Deploy on Render (free)
1. Put these files in a new GitHub repository: index.html, server.js, package.json, render.yaml.
2. On render.com choose New > Web Service (or Blueprint), connect the repository.
   Build command: npm install    Start command: npm start
3. Open the .onrender.com address Render gives you. That address is your game.

## Playing together
- Host: Singleplayer > start a world > Esc > Open to LAN. A join code appears, plus a Copy Invite Link button.
- Friend: open the same address, Multiplayer, type the code (or just open the invite link).

Free Render servers sleep when idle; the first visit after a pause can take about 30 seconds.

## Run locally
npm install && npm start, then open http://localhost:3000 (two tabs to test).
