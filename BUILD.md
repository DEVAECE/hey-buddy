# Building Buddy from source

Requirements: Node.js 20+.

    npm install
    node node_modules/electron/install.js   # if npm skipped Electron's download (npm 11 may)
    mkdir -p assets/model
    curl -L -o assets/model/vosk-model-small-en-us-0.15.tar.gz https://raw.githubusercontent.com/ccoreilly/vosk-browser/gh-pages/models/vosk-model-small-en-us-0.15.tar.gz
    npm start                      # run in development

Build the shareable Windows files (into dist/):

    npm run package                # out/Buddy-win32-x64 (the app folder); fails if the voice engine/model is missing
    npx electron-builder --win nsis --prepackaged out/Buddy-win32-x64    # dist/Buddy-Setup-<version>.exe
    cd out && cp -r Buddy-win32-x64 Buddy && tar -a -c -f ../dist/Buddy-Windows.zip Buddy && rm -rf Buddy   # portable zip

Packaging options live in tools/package.mjs, not in package.json: npm runs scripts through cmd.exe,
which strips "^" from regexes (that once dropped node_modules/vosk-browser/dist and broke voice).
Before sharing, check voice in the packaged app: it should reach "Listening for "Hey Buddy"".

Share Buddy-Setup-<version>.exe (or Buddy-Windows.zip) with "Buddy - Setup Guide.md". Bump "version" in
package.json for a new release. Builds are unsigned, so Windows SmartScreen asks users to confirm the first run.

Layout: main.js (tray, windows, IPC), src/ (tasks and reminders, scheduler and companion triggers, AI and
connections, sign-in tools, instant answers, reports, storage), renderer/ (main UI, voice, and the on-screen
companion: companion.html/js with the characters in sprite.js).
